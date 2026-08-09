"""Verify a real, live FDC Web2Json proof against Coston2's own FdcVerification contract.

Why this exists: our own attestation requests are accepted and paid for on-chain but are not
picked up by the data providers (see README §12). That leaves the most important question
unanswered — *is our proof-handling code correct?* — because it had never been exercised against a
real payload.

This answers it independently of whether our source gets attested. Flare's own traffic generator
publishes genuine Web2Json attestations on Coston2. This script pulls one, rebuilds the exact
`IWeb2Json.Proof` tuple `TacitVault.executeRebalance` expects, and asks the real
`FdcVerification.verifyWeb2Json()` whether it is valid.

A `True` here means the tuple encoding, the Merkle proof handling and the response decoding are all
correct against production data. Only the choice of source URL remains in question.

Usage:  ./.venv/bin/python offchain/verify_real_proof.py [--round N]
"""

from __future__ import annotations

import argparse
import json
import urllib.request

from web3 import Web3

import fdc

FDC_VERIFICATION_ABI = json.loads(
    """[{"inputs":[{"components":[
        {"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},
        {"components":[
          {"internalType":"bytes32","name":"attestationType","type":"bytes32"},
          {"internalType":"bytes32","name":"sourceId","type":"bytes32"},
          {"internalType":"uint64","name":"votingRound","type":"uint64"},
          {"internalType":"uint64","name":"lowestUsedTimestamp","type":"uint64"},
          {"components":[
            {"internalType":"string","name":"url","type":"string"},
            {"internalType":"string","name":"httpMethod","type":"string"},
            {"internalType":"string","name":"headers","type":"string"},
            {"internalType":"string","name":"queryParams","type":"string"},
            {"internalType":"string","name":"body","type":"string"},
            {"internalType":"string","name":"postProcessJq","type":"string"},
            {"internalType":"string","name":"abiSignature","type":"string"}],
           "internalType":"struct IWeb2Json.RequestBody","name":"requestBody","type":"tuple"},
          {"components":[{"internalType":"bytes","name":"abiEncodedData","type":"bytes"}],
           "internalType":"struct IWeb2Json.ResponseBody","name":"responseBody","type":"tuple"}],
         "internalType":"struct IWeb2Json.Response","name":"data","type":"tuple"}],
       "internalType":"struct IWeb2Json.Proof","name":"_proof","type":"tuple"}],
      "name":"verifyWeb2Json",
      "outputs":[{"internalType":"bool","name":"_proved","type":"bool"}],
      "stateMutability":"view","type":"function"}]"""
)

WEB2JSON_TYPE = "0x" + b"Web2Json".hex().ljust(64, "0")


def latest_finalised_round(api_key: str) -> int:
    req = urllib.request.Request(
        f"{fdc.COSTON2_DA_LAYER}/api/v0/fsp/status", headers={"X-API-KEY": api_key}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["latest_fdc"]["voting_round_id"]


def find_web2json(round_id: int, api_key: str):
    req = urllib.request.Request(
        f"{fdc.COSTON2_DA_LAYER}/api/v1/fdc?voting_round_id={round_id}",
        headers={"X-API-KEY": api_key},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        for entry in json.loads(r.read().decode()):
            if entry["response"]["attestationType"] == WEB2JSON_TYPE:
                return entry
    return None


def to_tuple(entry: dict) -> tuple:
    """Rebuild the on-chain `IWeb2Json.Proof` tuple from the DA layer's JSON form."""
    r = entry["response"]
    rb, resp = r["requestBody"], r["responseBody"]

    data = (
        Web3.to_bytes(hexstr=r["attestationType"]),
        Web3.to_bytes(hexstr=r["sourceId"]),
        int(r["votingRound"]),
        int(r["lowestUsedTimestamp"]),
        (
            rb["url"], rb["httpMethod"], rb["headers"],
            rb["queryParams"], rb["body"], rb["postProcessJq"], rb["abiSignature"],
        ),
        (Web3.to_bytes(hexstr=resp["abiEncodedData"]),),
    )
    merkle = [Web3.to_bytes(hexstr=p) for p in entry["proof"]]
    return (merkle, data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", type=int, help="voting round to pull a proof from")
    ap.add_argument("--api-key", default="00000000-0000-0000-0000-000000000000")
    args = ap.parse_args()

    w3 = Web3(Web3.HTTPProvider(fdc.COSTON2_RPC))
    verifier_addr = fdc.resolve(w3, "FdcVerification")
    verifier = w3.eth.contract(address=verifier_addr, abi=FDC_VERIFICATION_ABI)
    print(f"FdcVerification : {verifier_addr}")

    rounds = [args.round] if args.round else range(latest_finalised_round(args.api_key), 0, -1)

    entry = None
    for rid in rounds:
        try:
            entry = find_web2json(rid, args.api_key)
        except Exception:
            entry = None
        if entry:
            print(f"found Web2Json attestation in round {rid}")
            break
        if not args.round and rid < latest_finalised_round(args.api_key) - 60:
            break

    if not entry:
        print("no Web2Json attestation found in the scanned window")
        return 1

    rb = entry["response"]["requestBody"]
    print(f"  source url    : {rb['url']}")
    print(f"  jq filter     : {rb['postProcessJq'][:70]}")
    print(f"  merkle proof  : {len(entry['proof'])} node(s)")

    proof = to_tuple(entry)
    proved = verifier.functions.verifyWeb2Json(proof).call()

    print(f"\nFdcVerification.verifyWeb2Json(proof) = {proved}")
    if proved:
        print("\nThe proof tuple encoding, Merkle handling and response decoding are all correct")
        print("against a real Coston2 attestation. This is the same code path TacitVault uses.")
    else:
        print("\nVerification returned false — the tuple rebuild is wrong somewhere.")

    # Also prove the payload decodes, which is what the vault does next.
    decoded = w3.codec.decode(
        ["(uint256,uint256)"], Web3.to_bytes(hexstr=entry["response"]["responseBody"]["abiEncodedData"])
    )
    print(f"decoded payload : {decoded[0]}")

    return 0 if proved else 1


if __name__ == "__main__":
    raise SystemExit(main())
