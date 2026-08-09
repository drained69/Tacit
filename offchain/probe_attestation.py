"""Controlled experiment: which Web2Json requests do the data providers actually attest?

The verifier's `prepareRequest` says only that a request is *well-formed*. Whether ~100 independent
data providers can and will attest it is a separate question, answered by different machines with
different network egress — and the only way to find out is to submit and watch.

A submitted-but-unattested request costs a fee, produces no proof, and reports no error anywhere.
This script isolates the cause by submitting several variants in the same round and comparing:

  control   — the exact shape Flare's own FdcTrafficMaker uses, known-good
  empty     — our source, with `""` for queryParams/body like the control
  braces    — our source, with `"{}"` (what we shipped originally)

Usage:  ./.venv/bin/python offchain/probe_attestation.py [--check ROUND]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

from eth_account import Account
from web3 import Web3

import fdc
import signal_source

CONTROL_URL = "https://jsonplaceholder.typicode.com/todos"
CONTROL_JQ = ".[0] | {userId: .userId, id: .id}"
CONTROL_ABI = json.dumps({
    "components": [
        {"internalType": "uint256", "name": "userId", "type": "uint256"},
        {"internalType": "uint256", "name": "id", "type": "uint256"},
    ],
    "name": "task", "type": "tuple",
})


def prepare_raw(url, jq, abisig, headers, query_params, body, api_key):
    payload = {
        "attestationType": signal_source.ATTESTATION_TYPE,
        "sourceId": signal_source.SOURCE_ID,
        "requestBody": {
            "url": url, "httpMethod": "GET", "headers": headers,
            "queryParams": query_params, "body": body,
            "postProcessJq": jq, "abiSignature": abisig,
        },
    }
    req = urllib.request.Request(
        signal_source.VERIFIER_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-API-KEY": api_key},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def variants(api_key):
    return {
        "control-jsonplaceholder": prepare_raw(
            CONTROL_URL, CONTROL_JQ, CONTROL_ABI,
            '{"Content-Type":"application/json","User-Agent":"FdcTrafficMaker"}', "", "", api_key),
        "bitstamp-empty-params": prepare_raw(
            signal_source.SOURCE_URL, signal_source.POST_PROCESS_JQ, signal_source.ABI_SIGNATURE,
            '{"Content-Type":"application/json"}', "", "", api_key),
        "bitstamp-brace-params": prepare_raw(
            signal_source.SOURCE_URL, signal_source.POST_PROCESS_JQ, signal_source.ABI_SIGNATURE,
            "{}", "{}", "{}", api_key),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", type=int, help="check a previously submitted round instead")
    args = ap.parse_args()

    api_key = os.getenv("VERIFIER_API_KEY_TESTNET", signal_source.DEFAULT_API_KEY)
    w3 = Web3(Web3.HTTPProvider(fdc.COSTON2_RPC))

    if args.check:
        _report(args.check, json.load(open("/tmp/probe_requests.json")))
        return 0

    pk = os.getenv("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY required", file=sys.stderr)
        return 2
    account = Account.from_key(pk)

    prepared = variants(api_key)
    submitted = {}
    round_id = None

    for name, res in prepared.items():
        status = res.get("status")
        print(f"{name:26} verifier: {status}")
        if status != "VALID":
            continue
        att = fdc.submit(w3, account, res["abiEncodedRequest"])
        submitted[name] = res["abiEncodedRequest"]
        round_id = att.voting_round
        print(f"{'':26} submitted round {att.voting_round}  tx {att.tx_hash[:18]}…")
        time.sleep(2)

    json.dump(submitted, open("/tmp/probe_requests.json", "w"))
    print(f"\nWaiting ~4 minutes for round {round_id} to finalise…")
    time.sleep(240)
    _report(round_id, submitted)
    return 0


def _report(round_id, submitted):
    url = f"{fdc.COSTON2_DA_LAYER}/api/v1/fdc?voting_round_id={round_id}"
    req = urllib.request.Request(url, headers={"X-API-KEY": signal_source.DEFAULT_API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            attested = json.loads(r.read().decode())
    except Exception as exc:
        print(f"could not read round {round_id}: {exc}")
        return

    urls = [a.get("response", {}).get("requestBody", {}).get("url", "") for a in attested]
    print(f"\nRound {round_id} contains {len(attested)} attestation(s):")
    for u in urls:
        print(f"  - {u}")

    print("\nVerdict:")
    for name in submitted:
        want = CONTROL_URL if name.startswith("control") else signal_source.SOURCE_URL
        print(f"  {name:26} {'ATTESTED' if want in urls else 'NOT ATTESTED'}")


if __name__ == "__main__":
    raise SystemExit(main())
