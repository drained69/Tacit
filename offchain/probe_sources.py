"""Find which market-data hosts the FDC *data providers* will actually attest.

The verifier and the ~100 data providers are different machines with different network egress.
`prepareRequest` returning VALID proves only that the verifier could reach a host and run the
filter; it says nothing about whether the providers can. Bitstamp is the worked example: VALID from
the verifier, never attested by the providers.

There is no endpoint that answers this. The only way to know is to submit candidates and watch
which ones come back with a proof, so this submits them all in one round and reports the result.

Usage:
    ./.venv/bin/python offchain/probe_sources.py            # submit and wait
    ./.venv/bin/python offchain/probe_sources.py --check    # re-check a previous run
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

STATE = "/tmp/probe_sources.json"

# One integer per source is enough to answer the reachability question. `floor` is unavailable in
# the verifier's jq subset, so integers are produced with string surgery (see signal_source).
CANDIDATES = {
    "coinbase-spot": (
        "https://api.coinbase.com/v2/prices/XRP-USD/spot",
        '{v: (.data.amount|split(".")|.[0]|tonumber)}',
    ),
    "coinbase-exchange": (
        "https://api.exchange.coinbase.com/products/XRP-USD/stats",
        '{v: (.volume|split(".")|.[0]|tonumber)}',
    ),
    "gemini": (
        "https://api.gemini.com/v2/ticker/xrpusd",
        '{v: (.close|split(".")|.[0]|tonumber)}',
    ),
    "coinpaprika": (
        "https://api.coinpaprika.com/v1/tickers/xrp-xrp",
        '{v: (.rank)}',
    ),
    "kraken": (
        "https://api.kraken.com/0/public/Ticker?pair=XRPUSD",
        '{v: 1}',
    ),
    "bitstamp": (
        "https://www.bitstamp.net/api/v2/ticker/xrpusd/",
        '{v: (.volume|split(".")|.[0]|tonumber)}',
    ),
}

ABI = json.dumps({
    "components": [{"internalType": "uint256", "name": "v", "type": "uint256"}],
    "name": "task", "type": "tuple",
})


def prepare(url: str, jq: str, api_key: str) -> dict:
    payload = {
        "attestationType": signal_source.ATTESTATION_TYPE,
        "sourceId": signal_source.SOURCE_ID,
        "requestBody": {
            "url": url, "httpMethod": "GET",
            "headers": '{"Content-Type":"application/json"}',
            "queryParams": "", "body": "",
            "postProcessJq": jq, "abiSignature": ABI,
        },
    }
    req = urllib.request.Request(
        signal_source.VERIFIER_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-API-KEY": api_key},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def report(state: dict) -> None:
    lo, hi = state["round"] - 1, state["round"] + 4
    attested_hosts: set[str] = set()

    for rid in range(lo, hi + 1):
        try:
            req = urllib.request.Request(
                f"{fdc.COSTON2_DA_LAYER}/api/v1/fdc?voting_round_id={rid}",
                headers={"X-API-KEY": signal_source.DEFAULT_API_KEY},
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                entries = json.loads(r.read().decode())
        except Exception:
            continue
        for e in entries:
            u = e.get("response", {}).get("requestBody", {}).get("url") or ""
            if u:
                attested_hosts.add(u.split("/")[2])

    print(f"\nHosts attested in rounds {lo}–{hi}: {sorted(attested_hosts) or 'none'}\n")
    print(f"{'source':20} {'host':34} result")
    print("-" * 70)
    for name, url in state["submitted"].items():
        host = url.split("/")[2]
        mark = "ATTESTED" if host in attested_hosts else "not attested"
        print(f"{name:20} {host:34} {mark}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        report(json.load(open(STATE)))
        return 0

    api_key = os.getenv("VERIFIER_API_KEY_TESTNET", signal_source.DEFAULT_API_KEY)
    pk = os.getenv("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY required", file=sys.stderr)
        return 2

    w3 = Web3(Web3.HTTPProvider(fdc.COSTON2_RPC))
    account = Account.from_key(pk)

    submitted: dict[str, str] = {}
    round_id = None

    for name, (url, jq) in CANDIDATES.items():
        try:
            res = prepare(url, jq, api_key)
        except Exception as exc:
            print(f"{name:20} verifier error: {exc}")
            continue

        if res.get("status") != "VALID":
            print(f"{name:20} verifier rejected: {res.get('status')}")
            continue

        att = fdc.submit(w3, account, res["abiEncodedRequest"])
        submitted[name] = url
        round_id = att.voting_round
        print(f"{name:20} submitted -> round {att.voting_round}")
        time.sleep(2)

    if not submitted:
        print("nothing submitted")
        return 1

    json.dump({"round": round_id, "submitted": submitted}, open(STATE, "w"))
    print(f"\nWaiting ~5 minutes for rounds around {round_id} to finalise…")
    time.sleep(300)
    report(json.load(open(STATE)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
