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

from eth_account import Account
from web3 import Web3

import fdc
import signal_source as signal_mod  # named to avoid shadowing the stdlib `signal` module

VAULT_ABI = json.loads(
    """[
 {"inputs":[],"name":"rebalanceNonce","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
 {"inputs":[],"name":"totalAssets","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
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


def call_enclave(url: str, chain_id: int, vault: str, nonce: int, signal: dict, venues: list[dict]) -> dict:
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
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


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

    # 1. Prepare and validate the Web2Json request.
    print("\n[1/5] preparing Web2Json attestation request")
    prepared = signal_mod.prepare()
    print(f"      source: {prepared.source_url}")
    print(f"      encoded request: {len(prepared.abi_encoded_request)} chars")

    # 2. Submit it to the FDC and wait for the round to finalise.
    print("\n[2/5] submitting to FdcHub")
    attestation = fdc.submit(w3, account, prepared.abi_encoded_request)
    print(f"      tx    : {attestation.tx_hash}")
    print(f"      round : {attestation.voting_round}")

    print("\n[3/5] waiting for ~100 data providers to vote and the round to finalise")
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
    decision = call_enclave(args.enclave, w3.eth.chain_id, vault.address, nonce, signal, venues)

    print(f"      identity  : {decision['identity']}")
    print(f"      simulated : {decision['simulated']}")
    print(f"      targets   : {decision['targetBps']}  ({decision['rationale']})")
    if decision["simulated"]:
        print("      NOTE: attestation is SIMULATED on Coston2. The vault's on-chain invariants,")
        print("            not the enclave's word, are what protect deposits here.")

    if args.dry_run:
        print("\n[5/5] dry run - stopping before executeRebalance")
        return 0

    # 4. Submit. Every field is now either attested, signed, or re-derived on-chain.
    print("\n[5/5] submitting executeRebalance")
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

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    print(f"      status: {'SUCCESS' if receipt.status == 1 else 'REVERTED'}")

    assets, idle = vault.functions.allocations().call()
    print("\nallocation after rebalance:")
    for i, a in enumerate(assets):
        print(f"  venue{i}: {a / 1e6:>14,.6f} FXRP")
    print(f"  idle  : {idle / 1e6:>14,.6f} FXRP")

    return 0 if receipt.status == 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
