"""Submit a prepared attestation to FdcHub and collect the finalised proof.

The round trip is inherently asynchronous: `requestAttestation` only *queues* the request, ~100
independent data providers then fetch and vote on the data, and the Merkle root is relayed on-chain
when the voting round finalises. Nothing here can be made synchronous, so the relayer polls.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from web3 import Web3

COSTON2_RPC = "https://coston2-api.flare.network/ext/C/rpc"
COSTON2_DA_LAYER = "https://ctn2-data-availability.flare.network"

# Same address on every Flare network. Everything else is resolved through it, because Flare
# rotates system contracts and hardcoded addresses go stale silently.
CONTRACT_REGISTRY = Web3.to_checksum_address("0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019")

REGISTRY_ABI = json.loads(
    '[{"inputs":[{"internalType":"string","name":"_name","type":"string"}],'
    '"name":"getContractAddressByName","outputs":[{"internalType":"address","name":"","type":"address"}],'
    '"stateMutability":"view","type":"function"}]'
)

FDC_HUB_ABI = json.loads(
    '[{"inputs":[{"internalType":"bytes","name":"_data","type":"bytes"}],'
    '"name":"requestAttestation","outputs":[],"stateMutability":"payable","type":"function"}]'
)

FDC_FEE_ABI = json.loads(
    '[{"inputs":[{"internalType":"bytes","name":"_data","type":"bytes"}],'
    '"name":"getRequestFee","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],'
    '"stateMutability":"view","type":"function"}]'
)

# Flare systems timing for Coston2. Used to map a block timestamp to its voting round.
FIRST_VOTING_ROUND_START_TS = 1658430000
VOTING_EPOCH_DURATION_SECONDS = 90


@dataclass
class Attestation:
    voting_round: int
    tx_hash: str
    request_bytes: str


def registry(w3: Web3):
    return w3.eth.contract(address=CONTRACT_REGISTRY, abi=REGISTRY_ABI)


def resolve(w3: Web3, name: str) -> str:
    """Look a Flare system contract up by name rather than trusting a hardcoded address."""
    return registry(w3).functions.getContractAddressByName(name).call()


def submit(w3: Web3, account, request_bytes: str, gas: int = 400_000) -> Attestation:
    """Queue an attestation request and return the voting round it landed in."""
    hub_address = resolve(w3, "FdcHub")
    hub = w3.eth.contract(address=hub_address, abi=FDC_HUB_ABI)

    data = bytes.fromhex(request_bytes[2:] if request_bytes.startswith("0x") else request_bytes)

    # The fee lives on FdcRequestFeeConfigurations, NOT on FdcHub — calling `getRequestFee` on the
    # hub reverts. Underpaying fails with "fee to low, call getRequestFee to get the required fee
    # amount", which points at a method the hub does not expose, so it is easy to chase in the
    # wrong place. On Coston2 this is currently 1000 wei; read it rather than hardcoding.
    fee_cfg = w3.eth.contract(address=resolve(w3, "FdcRequestFeeConfigurations"), abi=FDC_FEE_ABI)
    fee = fee_cfg.functions.getRequestFee(data).call()

    tx = hub.functions.requestAttestation(data).build_transaction(
        {
            "from": account.address,
            "value": fee,
            "gas": gas,
            "nonce": w3.eth.get_transaction_count(account.address),
            "chainId": w3.eth.chain_id,
            "maxFeePerGas": w3.eth.gas_price * 2,
            "maxPriorityFeePerGas": w3.eth.gas_price,
        }
    )
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"requestAttestation reverted: {tx_hash.hex()}")

    block = w3.eth.get_block(receipt.blockNumber)
    voting_round = (block.timestamp - FIRST_VOTING_ROUND_START_TS) // VOTING_EPOCH_DURATION_SECONDS

    return Attestation(
        voting_round=int(voting_round),
        tx_hash=tx_hash.hex(),
        request_bytes=request_bytes,
    )


def fetch_proof(
    attestation: Attestation,
    da_layer_url: str = COSTON2_DA_LAYER,
    api_key: str = "00000000-0000-0000-0000-000000000000",
    attempts: int = 25,
    delay_seconds: int = 20,
) -> dict[str, Any]:
    """Poll the Data Availability layer until the round finalises and the proof is published."""
    url = f"{da_layer_url}/api/v1/fdc/proof-by-request-round-raw"
    payload = json.dumps(
        {"votingRoundId": attestation.voting_round, "requestBytes": attestation.request_bytes}
    ).encode()

    last_error = ""
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "X-API-KEY": api_key},
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = json.loads(resp.read().decode())
            # Before finalisation the endpoint answers 200 with an empty proof, so presence of the
            # proof field — not the status code — is what says the round is done.
            if body.get("proof") is not None and body.get("response_hex"):
                return body
            last_error = "round not finalised yet"
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read().decode()[:160]}"
        except Exception as exc:  # network flakiness is expected while polling
            last_error = str(exc)

        print(f"  [{attempt}/{attempts}] waiting for round {attestation.voting_round} ({last_error})")
        time.sleep(delay_seconds)

    raise TimeoutError(
        f"proof for round {attestation.voting_round} not available after "
        f"{attempts * delay_seconds}s; last: {last_error}"
    )
