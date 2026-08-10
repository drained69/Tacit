// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title SignalTypes
/// @notice Shared value types for the off-chain market signal and the TEE rebalance plan.
/// @dev `MarketSignal` MUST stay byte-compatible with the `abiSignature` registered in the
///      Web2Json attestation request (`offchain/signal_source.py`) and with `HashSignal` in the Go
///      enclave. Change one without the other two and every rebalance fails as `BadSigner`, with
///      both sides looking correct in isolation — see `test/EnclaveConformance.t.sol`.
library SignalTypes {
    /// @notice Market observation attested by the Flare Data Connector via Web2Json.
    ///
    /// @dev The field set is dictated by what the FDC data providers will actually fetch, not by
    ///      what would be convenient. Providers attest Coinpaprika, Coinbase and Gemini; they do
    ///      not attest Bitstamp, whatever the verifier says. Coinpaprika is the only reachable
    ///      source carrying price, volume *and* multiple return horizons in one document, and the
    ///      horizons turn out to be a better volatility input than a single high–low range: they
    ///      describe the *shape* of recent movement rather than only its extent.
    ///
    ///      Prices are micro-USD (6dp) to match FXRP's own decimals. Returns are signed basis
    ///      points. Volume is whole USD — the fractional part is dropped by the jq filter, which
    ///      has no `floor`.
    ///
    ///      There is deliberately no timestamp field. A source-supplied timestamp is a claim by the
    ///      source; freshness is instead derived on-chain from the attestation's own voting round,
    ///      which is the chain's view of when the observation was made and cannot be backdated by a
    ///      compromised endpoint.
    struct MarketSignal {
        uint256 priceMicroUsd;
        uint256 volume24hUsd;
        int256 change1hBps;
        int256 change6hBps;
        int256 change24hBps;
    }

    /// @notice An allocation instruction produced inside the confidential enclave.
    /// @dev The enclave's *strategy* is private; this plan is the only thing it reveals, and the
    ///      vault re-derives every transfer from its own ledger rather than trusting the plan's
    ///      arithmetic. `targetBps` may sum to less than `BPS_DENOMINATOR` — the remainder stays
    ///      idle, which is a legitimate defensive allocation — but never to more.
    struct RebalancePlan {
        uint256 nonce;
        uint64 deadline;
        bytes32 signalHash;
        uint256 refPriceMicroUsd;
        uint16[] targetBps;
    }

    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Canonical hash binding a plan to the exact observation it was computed from.
    /// @dev Prevents an enclave from replaying a favourable plan against a newer market state.
    function hashSignal(MarketSignal memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                s.priceMicroUsd, s.volume24hUsd, s.change1hBps, s.change6hBps, s.change24hBps
            )
        );
    }

    /// @notice EIP-712-style struct hash for the plan, signed by the enclave identity.
    /// @dev `abi.encodePacked(uint16[])` pads each element to a full 32-byte word — it does not
    ///      pack two bytes per element, which is the intuitive reading and produces a different
    ///      hash. The Go signer must match this exactly.
    function hashPlan(RebalancePlan memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("RebalancePlan(uint256 nonce,uint64 deadline,bytes32 signalHash,uint256 refPriceMicroUsd,uint16[] targetBps)"),
                p.nonce,
                p.deadline,
                p.signalHash,
                p.refPriceMicroUsd,
                keccak256(abi.encodePacked(p.targetBps))
            )
        );
    }
}
