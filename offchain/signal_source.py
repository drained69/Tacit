"""Web2Json attestation request construction for the TacitVault market signal.

The jq filter here is the load-bearing part of this module, and it looks stranger than it needs
to for a reason: **the FDC verifier runs a restricted jq subset**. Empirically (Coston2,
2026-08-09) it rejects `floor`, `round`, `sub` and `ltrimstr` with `INVALID: INVALID JQ FILTER`.
So every decimal-to-integer conversion is done with string surgery — split on ".", pad the
fraction, slice it — rather than arithmetic.

The source is Bitstamp because most crypto APIs are unreachable from the *verifier*: CoinGecko,
Binance, Kraken, OKX and CryptoCompare all return `INVALID: FETCH ERROR`. Bitstamp also returns
every field as a string, which suits the string-op approach exactly.

    !! KNOWN GAP — Bitstamp validates here but is NEVER ATTESTED by the data providers.

The verifier and the ~100 providers are different machines with different egress. A request can be
VALID, submitted and paid for, and then silently never attested (see README §12). Confirmed by
controlled experiment in `probe_attestation.py`, and `probe_sources.py` maps which hosts do work:

    attesting      api.gemini.com, api.coinbase.com, api.coinpaprika.com
    not attesting  www.bitstamp.net, api.exchange.coinbase.com

Moving to an attesting source is not a URL swap: none of them expose the same field set, so the
`MarketSignal` DTO has to be reshaped across Solidity, Go and this module together, and the
conformance vector regenerated. That work is scoped in Todo.md and deliberately not half-done here,
because a partial change would break the signing path in a way that surfaces only as `BadSigner`.

`ABI_SIGNATURE` must stay byte-compatible with `SignalTypes.MarketSignal` in Solidity.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

VERIFIER_URL = "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest"
# Public testnet key published in flare-hardhat-starter/.env.example.
DEFAULT_API_KEY = "00000000-0000-0000-0000-000000000000"

SOURCE_URL = "https://www.bitstamp.net/api/v2/ticker/xrpusd/"

ATTESTATION_TYPE = "0x" + b"Web2Json".hex().ljust(64, "0")
SOURCE_ID = "0x" + b"PublicWeb2".hex().ljust(64, "0")

PRICE_DP = 6  # micro-USD, matching FXRP's own 6 decimals


def _scaled(field: str, dp: int = PRICE_DP) -> str:
    """jq fragment: decimal string -> integer scaled by 10**dp, without using `floor`."""
    pad = "0" * dp
    return (
        f'((.{field}|split(".")|.[0]|tonumber)*{10 ** dp} + '
        f'((.{field}|split(".")|.[1]) + "{pad}" | .[0:{dp}] | tonumber))'
    )


def _signed_bps(field: str) -> str:
    """jq fragment: signed percentage string -> signed basis points.

    `split(".")` on "-0.22" yields ["-0", "22"], and ("-0"|tonumber) is 0 — the sign is silently
    lost. So the sign is detected up front and the magnitude parsed from the unsigned remainder.
    """
    magnitude = (
        '(((.{f}|split(".")|.[0]|tonumber)*100) + '
        '((.{f}|split(".")|.[1]) + "00" | .[0:2] | tonumber))'
    )
    positive = magnitude.format(f=field)
    negative = magnitude.format(f=f"{field}|.[1:]").replace(f".{field}|.[1:]", f"(.{field}|.[1:])")
    return f'(if (.{field}|startswith("-")) then -{negative} else {positive} end)'


POST_PROCESS_JQ = (
    "{"
    f"lastMicroUsd: {_scaled('last')}, "
    f"vwapMicroUsd: {_scaled('vwap')}, "
    f"highMicroUsd: {_scaled('high')}, "
    f"lowMicroUsd: {_scaled('low')}, "
    'volumeXrp: (.volume|split(".")|.[0]|tonumber), '
    f"changeBps: {_signed_bps('percent_change_24')}, "
    "obsTimestamp: (.timestamp|tonumber)"
    "}"
)

ABI_SIGNATURE = json.dumps(
    {
        "components": [
            {"internalType": "uint256", "name": "lastMicroUsd", "type": "uint256"},
            {"internalType": "uint256", "name": "vwapMicroUsd", "type": "uint256"},
            {"internalType": "uint256", "name": "highMicroUsd", "type": "uint256"},
            {"internalType": "uint256", "name": "lowMicroUsd", "type": "uint256"},
            {"internalType": "uint256", "name": "volumeXrp", "type": "uint256"},
            {"internalType": "int256", "name": "changeBps", "type": "int256"},
            {"internalType": "uint256", "name": "obsTimestamp", "type": "uint256"},
        ],
        "name": "task",
        "type": "tuple",
    }
)


@dataclass(frozen=True)
class PreparedRequest:
    abi_encoded_request: str
    source_url: str
    jq: str


class PrepareError(RuntimeError):
    """The verifier refused the request. The message carries its status verbatim."""


def prepare(api_key: str = DEFAULT_API_KEY, timeout: int = 60) -> PreparedRequest:
    """Ask the FDC verifier to validate and encode the attestation request."""
    payload = {
        "attestationType": ATTESTATION_TYPE,
        "sourceId": SOURCE_ID,
        "requestBody": {
            "url": SOURCE_URL,
            "httpMethod": "GET",
            "headers": "{}",
            "queryParams": "{}",
            "body": "{}",
            "postProcessJq": POST_PROCESS_JQ,
            "abiSignature": ABI_SIGNATURE,
        },
    }

    req = urllib.request.Request(
        VERIFIER_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-API-KEY": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise PrepareError(f"verifier HTTP {exc.code}: {exc.read().decode()[:300]}") from exc

    status = body.get("status", "")
    if status != "VALID" or not body.get("abiEncodedRequest"):
        # Worth distinguishing: FETCH ERROR means the host is unreachable from the verifier and no
        # amount of filter-fixing will help; INVALID JQ FILTER means the subset rejected something.
        raise PrepareError(f"verifier returned {status!r}")

    return PreparedRequest(
        abi_encoded_request=body["abiEncodedRequest"],
        source_url=SOURCE_URL,
        jq=POST_PROCESS_JQ,
    )


if __name__ == "__main__":
    print("jq filter:\n", POST_PROCESS_JQ, "\n")
    prepared = prepare()
    print("status: VALID")
    print("abiEncodedRequest:", prepared.abi_encoded_request[:120], "...")
    print("length:", len(prepared.abi_encoded_request))
