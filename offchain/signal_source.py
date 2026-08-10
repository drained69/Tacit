"""Web2Json attestation request for the TacitVault market signal.

Two constraints shaped everything here, and neither is documented by Flare.

**The verifier's jq is a restricted subset.** `floor`, `round`, `sub` and `ltrimstr` are all
rejected with `INVALID: INVALID JQ FILTER`. Every decimal-to-integer conversion is therefore string
surgery — stringify, split on ".", pad the fraction, slice it — rather than arithmetic.

**The verifier and the data providers are different machines.** `prepareRequest` returning VALID
proves only that *the verifier* could reach a host. The ~100 providers that actually attest have
different egress, and a VALID request to a host they cannot reach is submitted, paid for, and then
silently never attested. Established by controlled experiment (`probe_attestation.py`) and mapped
across candidates (`probe_sources.py`):

    attesting      api.coinpaprika.com, api.gemini.com, api.coinbase.com
    not attesting  www.bitstamp.net, api.exchange.coinbase.com

Coinpaprika is used because it is the only attesting source carrying price, volume *and* several
return horizons in one document. `ABI_SIGNATURE` must stay byte-compatible with
`SignalTypes.MarketSignal` in Solidity and `strategy.MarketSignal` in Go.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

VERIFIER_URL = "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest"
# Public testnet key published in flare-hardhat-starter/.env.example.
DEFAULT_API_KEY = "00000000-0000-0000-0000-000000000000"

SOURCE_URL = "https://api.coinpaprika.com/v1/tickers/xrp-xrp"

ATTESTATION_TYPE = "0x" + b"Web2Json".hex().ljust(64, "0")
SOURCE_ID = "0x" + b"PublicWeb2".hex().ljust(64, "0")

PRICE_DP = 6  # micro-USD, matching FXRP's own 6 decimals

_Q = ".quotes.USD"


def _padded(path: str) -> str:
    """jq fragment: a JSON number as a string that is guaranteed to contain a '.'.

    Coinpaprika returns numbers, not strings, so `tostring` is needed first. Appending ".0"
    afterwards guarantees `split(".")` yields a second element even for integer-valued fields
    (`0` -> `"0.0"` -> `["0","0"]`), which otherwise makes `.[1]` null and blows up the filter.
    """
    return f'(({path}|tostring) + ".0")'


def _scaled(path: str, dp: int = PRICE_DP) -> str:
    """jq fragment: number -> integer scaled by 10**dp, without `floor`."""
    pad = "0" * dp
    p = _padded(path)
    return (
        f'(({p}|split(".")|.[0]|tonumber)*{10 ** dp} + '
        f'(({p}|split(".")|.[1]) + "{pad}" | .[0:{dp}] | tonumber))'
    )


def _whole(path: str) -> str:
    """jq fragment: number -> its integer part."""
    return f'({_padded(path)}|split(".")|.[0]|tonumber)'


def _signed_bps(path: str) -> str:
    """jq fragment: signed percentage -> signed basis points.

    The sign has to be handled before parsing: `split(".")` on "-0.39" yields ["-0", "39"], and
    `("-0"|tonumber)` is 0, so the sign is silently lost.
    """
    pos_src = _padded(path)
    neg_src = f'((({path}|tostring)|.[1:]) + ".0")'

    def magnitude(src: str) -> str:
        return (
            f'(({src}|split(".")|.[0]|tonumber)*100 + '
            f'(({src}|split(".")|.[1]) + "00" | .[0:2] | tonumber))'
        )

    return (
        f'(if (({path}|tostring)|startswith("-")) '
        f"then -{magnitude(neg_src)} else {magnitude(pos_src)} end)"
    )


POST_PROCESS_JQ = (
    "{"
    f"priceMicroUsd: {_scaled(f'{_Q}.price')}, "
    f"volume24hUsd: {_whole(f'{_Q}.volume_24h')}, "
    f"change1hBps: {_signed_bps(f'{_Q}.percent_change_1h')}, "
    f"change6hBps: {_signed_bps(f'{_Q}.percent_change_6h')}, "
    f"change24hBps: {_signed_bps(f'{_Q}.percent_change_24h')}"
    "}"
)

ABI_SIGNATURE = json.dumps(
    {
        "components": [
            {"internalType": "uint256", "name": "priceMicroUsd", "type": "uint256"},
            {"internalType": "uint256", "name": "volume24hUsd", "type": "uint256"},
            {"internalType": "int256", "name": "change1hBps", "type": "int256"},
            {"internalType": "int256", "name": "change6hBps", "type": "int256"},
            {"internalType": "int256", "name": "change24hBps", "type": "int256"},
        ],
        "name": "task",
        "type": "tuple",
    }
)

SIGNAL_FIELDS = (
    "priceMicroUsd",
    "volume24hUsd",
    "change1hBps",
    "change6hBps",
    "change24hBps",
)

#: Solidity tuple type for decoding `responseBody.abiEncodedData`.
SIGNAL_TUPLE = "(uint256,uint256,int256,int256,int256)"


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
            "headers": '{"Content-Type":"application/json"}',
            "queryParams": "",
            "body": "",
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
        # Worth distinguishing: FETCH ERROR means the host is unreachable *from the verifier* and
        # no filter change will help; INVALID JQ FILTER means the subset rejected something.
        raise PrepareError(f"verifier returned {status!r}")

    return PreparedRequest(
        abi_encoded_request=body["abiEncodedRequest"],
        source_url=SOURCE_URL,
        jq=POST_PROCESS_JQ,
    )


if __name__ == "__main__":
    print("source:", SOURCE_URL)
    print("\njq filter:\n", POST_PROCESS_JQ, "\n")
    prepared = prepare()
    print("status: VALID")
    print("abiEncodedRequest:", prepared.abi_encoded_request[:110], "...")
    print("length:", len(prepared.abi_encoded_request))
