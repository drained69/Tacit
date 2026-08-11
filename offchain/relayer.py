"""End-to-end rebalance relayer.

    Coinpaprika --Web2Json--> FDC (~100 providers vote)  -->  proof on Coston2
                                                              |
                                            FCC enclave  <----+  (confidential strategy)
                                                              |
                                        TacitVault.executeRebalance(plan, sig, proof)
                                                              |
                                     conservation / caps / turnover / FTSO band / signal binding

The relayer is deliberately untrusted infrastructure: it can choose *when* to run and can refuse
to run, but every value it carries is either attested by the FDC, signed by the enclave, or
re-derived on-chain. A malicious relayer cannot alter an allocation without the vault rejecting it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass

from eth_account import Account
from web3 import Web3

import fdc
import signal_source as signal_mod  # named to avoid shadowing the stdlib `signal` module

VAULT_ABI = json.loads(
    """[
 {"inputs":[],"name":"rebalanceNonce","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"totalAssets","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"lastRebalanceAt","outputs":[{"type":"uint64"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"minRebalanceInterval","outputs":[{"type":"uint32"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"paused","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
 {"anonymous":false,"inputs":[
    {"indexed":true,"type":"uint256","name":"nonce"},{"indexed":false,"type":"uint256","name":"totalAssets"},
    {"indexed":false,"type":"uint64","name":"timestamp"}],
  "name":"RebalanceRequested","type":"event"},
 {"inputs":[],"name":"venueCount","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"teeIdentity","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
 {"inputs":[{"type":"uint256"}],"name":"venues","outputs":[
    {"type":"address","name":"venue"},{"type":"uint16","name":"capBps"},{"type":"bool","name":"active"},{"type":"bool","name":"liquidOnDemand"}],
  "stateMutability":"view","type":"function"},
 {"inputs":[],"name":"allocations","outputs":[
    {"type":"uint256[]","name":"assetsPerVenue"},{"type":"uint256","name":"idle"}],
  "stateMutability":"view","type":"function"},
 {"inputs":[],"name":"requestRebalance","outputs":[],"stateMutability":"nonpayable","type":"function"},
 {"inputs":[
    {"components":[
       {"type":"uint256","name":"nonce"},{"type":"uint64","name":"deadline"},
       {"type":"bytes32","name":"signalHash"},{"type":"uint256","name":"refPriceMicroUsd"},
       {"type":"uint16[]","name":"targetBps"}],
     "name":"plan","type":"tuple"},
    {"type":"bytes","name":"signature"},
    {"components":[
       {"type":"bytes32[]","name":"merkleProof"},
       {"components":[
          {"type":"bytes32","name":"attestationType"},{"type":"bytes32","name":"sourceId"},
          {"type":"uint64","name":"votingRound"},{"type":"uint64","name":"lowestUsedTimestamp"},
          {"components":[
             {"type":"string","name":"url"},{"type":"string","name":"httpMethod"},
             {"type":"string","name":"headers"},{"type":"string","name":"queryParams"},
             {"type":"string","name":"body"},{"type":"string","name":"postProcessJq"},
             {"type":"string","name":"abiSignature"}],
           "name":"requestBody","type":"tuple"},
          {"components":[{"type":"bytes","name":"abiEncodedData"}],
           "name":"responseBody","type":"tuple"}],
        "name":"data","type":"tuple"}],
     "name":"signalProof","type":"tuple"}],
  "name":"executeRebalance","outputs":[],"stateMutability":"nonpayable","type":"function"}
]"""
)

VENUE_ABI = json.loads(
    '[{"inputs":[],"name":"ratePerYearBps","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},'
    '{"inputs":[],"name":"liquidityBps","outputs":[{"type":"uint16"}],"stateMutability":"view","type":"function"}]'
)


def decode_signal(w3: Web3, abi_encoded_data: bytes) -> dict:
    """Decode the attested payload using the same tuple layout the contract expects."""
    values = w3.codec.decode([signal_mod.SIGNAL_TUPLE], abi_encoded_data)[0]
    return dict(zip(signal_mod.SIGNAL_FIELDS, values))


class EnclaveUnreachable(RuntimeError):
    """The enclave did not answer.

    Raised instead of letting a bare URLError escape, so the caller can name the address that
    failed and the command that fixes it rather than printing a socket traceback.
    """


def enclave_identity(url: str) -> str | None:
    """Read the enclave's signing identity, or None if it is unreachable."""
    import urllib.request

    try:
        with urllib.request.urlopen(url.rstrip("/") + "/info", timeout=15) as resp:
            return json.loads(resp.read().decode()).get("identity")
    except Exception:
        return None


def enclave_hint(url: str) -> str:
    return (
        f"enclave unreachable at {url}\n"
        "      start it with:  cd tee && SIMULATED_TEE=true go run .\n"
        "      or point --enclave / TACIT_ENCLAVE_URL at a running one"
    )


def call_enclave(url: str, chain_id: int, vault: str, nonce: int, signal: dict, venues: list[dict]) -> dict:
    import urllib.error
    import urllib.request

    payload = {
        "opType": "TACIT",
        "command": "REBALANCE",
        "chainId": chain_id,
        "vault": vault,
        "nonce": nonce,
        "signal": {
            "PriceMicroUSD": signal["priceMicroUsd"],
            "Volume24hUSD": signal["volume24hUsd"],
            "Change1hBps": signal["change1hBps"],
            "Change6hBps": signal["change6hBps"],
            "Change24hBps": signal["change24hBps"],
        },
        "venues": venues,
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/action",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        # The enclave answered and refused. Its body says why; a traceback would not.
        raise EnclaveUnreachable(f"enclave rejected the request ({e.code}): {e.read().decode()}") from e
    except urllib.error.URLError as e:
        raise EnclaveUnreachable(enclave_hint(url)) from e


def build_proof_tuple(proof_body: dict, w3: Web3) -> tuple:
    """Rebuild the IWeb2Json.Proof tuple from the DA layer's raw response."""
    response_hex = proof_body["response_hex"]
    decoded = w3.codec.decode(
        [
            "(bytes32,bytes32,uint64,uint64,"
            "(string,string,string,string,string,string,string),"
            "(bytes))"
        ],
        bytes.fromhex(response_hex[2:] if response_hex.startswith("0x") else response_hex),
    )[0]
    merkle_proof = [
        bytes.fromhex(p[2:] if p.startswith("0x") else p) for p in proof_body["proof"]
    ]
    return (merkle_proof, decoded)


@dataclass
class CycleResult:
    """Outcome of one full attestation → enclave → executeRebalance cycle."""

    nonce: int
    targets: list[int]
    rationale: str
    simulated: bool
    tx_hash: str | None = None      # None on a dry run
    succeeded: bool = False         # True only once the receipt confirms status 1
    allocations: list[int] | None = None
    idle: int | None = None


def run_cycle(
    w3: Web3,
    account,
    vault,
    enclave_url: str,
    *,
    dry_run: bool = False,
    on_step=None,
) -> CycleResult:
    """Run one rebalance cycle end to end.

    Extracted from `main()` so the autopilot daemon can drive the same code path rather than
    keeping a second copy of it. The printed `[n/5]` output is part of the demo script and must
    not drift; `on_step(n, text)` is the machine-readable mirror of it for the status endpoint.
    """

    def step(n: int, text: str) -> None:
        if on_step is not None:
            on_step(n, text)

    # 0. Reach the enclave first. Everything below this line costs something: the FDC fee is paid
    # in step 2 and the round takes minutes to finalise. Discovering a dead enclave in step 4 --
    # which is exactly what used to happen -- burns both for nothing. One GET buys that back.
    print("\n[0/5] checking the enclave is reachable")
    step(0, "checking the enclave is reachable")
    identity = enclave_identity(enclave_url)
    if identity is None:
        raise EnclaveUnreachable(enclave_hint(enclave_url))
    expected = vault.functions.teeIdentity().call()
    if Web3.to_checksum_address(identity) != Web3.to_checksum_address(expected):
        # Every plan this enclave signs would revert BadSigner. Stop before paying to find out.
        raise EnclaveUnreachable(
            f"enclave identity {identity} != vault teeIdentity {expected}\n"
            "      the vault will reject every plan this enclave signs (BadSigner)"
        )
    print(f"      identity  : {identity}  (matches vault teeIdentity)")

    # 1. Prepare and validate the Web2Json request.
    print("\n[1/5] preparing Web2Json attestation request")
    step(1, "preparing Web2Json attestation request")
    prepared = signal_mod.prepare()
    print(f"      source: {prepared.source_url}")
    print(f"      encoded request: {len(prepared.abi_encoded_request)} chars")

    # 2. Submit it to the FDC and wait for the round to finalise.
    print("\n[2/5] submitting to FdcHub")
    step(2, "submitting to FdcHub")
    attestation = fdc.submit(w3, account, prepared.abi_encoded_request)
    print(f"      tx    : {attestation.tx_hash}")
    print(f"      round : {attestation.voting_round}")

    print("\n[3/5] waiting for ~100 data providers to vote and the round to finalise")
    step(3, f"waiting for FDC round {attestation.voting_round} to finalise")
    proof_body = fdc.fetch_proof(attestation)
    proof_tuple = build_proof_tuple(proof_body, w3)
    signal = decode_signal(w3, proof_tuple[1][5][0])
    print(f"      attested price   : ${signal['priceMicroUsd'] / 1e6:.6f}")
    print(f"      attested volume  : ${signal['volume24hUsd']:,}")
    print(f"      change 1h/6h/24h : "
          f"{signal['change1hBps'] / 100:+.2f}% / "
          f"{signal['change6hBps'] / 100:+.2f}% / "
          f"{signal['change24hBps'] / 100:+.2f}%")

    # 3. Ask the enclave for an allocation. The strategy itself never leaves the TEE.
    print("\n[4/5] requesting allocation from the confidential enclave")
    step(4, "requesting allocation from the confidential enclave")
    n = vault.functions.venueCount().call()
    venues = []
    for i in range(n):
        addr, cap_bps, active, liquid_on_demand = vault.functions.venues(i).call()
        v = w3.eth.contract(address=addr, abi=VENUE_ABI)
        try:
            rate = v.functions.ratePerYearBps().call()
            liq = v.functions.liquidityBps().call()
        except Exception:
            rate, liq = 0, 10_000
        venues.append(
            {
                "name": f"venue{i}",
                "ratePerYearBp": int(rate),
                "capBps": int(cap_bps) if active else 0,
                "liquidityBps": int(liq),
            }
        )

    nonce = vault.functions.rebalanceNonce().call()
    decision = call_enclave(enclave_url, w3.eth.chain_id, vault.address, nonce, signal, venues)

    print(f"      identity  : {decision['identity']}")
    print(f"      simulated : {decision['simulated']}")
    print(f"      targets   : {decision['targetBps']}  ({decision['rationale']})")
    if decision["simulated"]:
        print("      NOTE: attestation is SIMULATED on Coston2. The vault's on-chain invariants,")
        print("            not the enclave's word, are what protect deposits here.")

    result = CycleResult(
        nonce=int(decision["nonce"]),
        targets=[int(t) for t in decision["targetBps"]],
        rationale=str(decision["rationale"]),
        simulated=bool(decision["simulated"]),
    )

    if dry_run:
        print("\n[5/5] dry run - stopping before executeRebalance")
        step(5, "dry run - stopping before executeRebalance")
        result.succeeded = True
        return result

    # 4. Submit. Every field is now either attested, signed, or re-derived on-chain.
    print("\n[5/5] submitting executeRebalance")
    step(5, "submitting executeRebalance")
    plan = (
        int(decision["nonce"]),
        int(decision["deadline"]),
        bytes.fromhex(decision["signalHash"][2:]),
        int(decision["refPriceMicroUsd"]),
        [int(t) for t in decision["targetBps"]],
    )
    sig = bytes.fromhex(decision["signature"][2:])

    tx = vault.functions.executeRebalance(plan, sig, proof_tuple).build_transaction(
        {
            "from": account.address,
            "gas": 2_000_000,
            "nonce": w3.eth.get_transaction_count(account.address),
            "chainId": w3.eth.chain_id,
            "maxFeePerGas": w3.eth.gas_price * 2,
            "maxPriorityFeePerGas": w3.eth.gas_price,
        }
    )
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"      tx: 0x{tx_hash.hex()}")
    result.tx_hash = "0x" + tx_hash.hex()

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    print(f"      status: {'SUCCESS' if receipt.status == 1 else 'REVERTED'}")
    result.succeeded = receipt.status == 1

    assets, idle = vault.functions.allocations().call()
    print("\nallocation after rebalance:")
    for i, a in enumerate(assets):
        print(f"  venue{i}: {a / 1e6:>14,.6f} FXRP")
    print(f"  idle  : {idle / 1e6:>14,.6f} FXRP")
    result.allocations = [int(a) for a in assets]
    result.idle = int(idle)

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="TacitVault rebalance relayer")
    ap.add_argument("--vault", required=True, help="TacitVault address")
    ap.add_argument("--enclave", default=os.getenv("TACIT_ENCLAVE_URL", "http://127.0.0.1:8080"))
    ap.add_argument("--rpc", default=os.getenv("COSTON2_RPC", fdc.COSTON2_RPC))
    ap.add_argument("--dry-run", action="store_true", help="stop before sending executeRebalance")
    args = ap.parse_args()

    pk = os.getenv("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY is required", file=sys.stderr)
        return 2
    account = Account.from_key(pk)

    w3 = Web3(Web3.HTTPProvider(args.rpc))
    vault = w3.eth.contract(address=Web3.to_checksum_address(args.vault), abi=VAULT_ABI)

    print(f"relayer      : {account.address}")
    print(f"vault        : {args.vault}")
    print(f"total assets : {vault.functions.totalAssets().call() / 1e6:.6f} FXRP")

    try:
        result = run_cycle(w3, account, vault, args.enclave, dry_run=args.dry_run)
    except EnclaveUnreachable as e:
        print(f"\n{e}", file=sys.stderr)
        return 3

    return 0 if result.succeeded else 1


if __name__ == "__main__":
    raise SystemExit(main())
