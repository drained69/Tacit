// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title SignalTypes
/// @notice Shared value types for the off-chain market signal and the TEE rebalance plan.
/// @dev `MarketSignal` MUST stay byte-compatible with the `abiSignature` registered in the
///      Web2Json attestation request (see `offchain/signal.py`). If you change a field here,
///      change it there in the same commit or every attestation will decode to garbage.
library SignalTypes {
    /// @notice Market observation attested by the Flare Data Connector via Web2Json.
    /// @dev Prices are micro-USD (6dp) to match FXRP's own 6 decimals. `changeBps` is signed
    ///      basis points of 24h price change. `volumeXrp` is whole XRP (fractional part dropped
    ///      by the jq filter, which cannot use `floor`).
    struct MarketSignal {
        uint256 lastMicroUsd;
        uint256 vwapMicroUsd;
        uint256 highMicroUsd;
        uint256 lowMicroUsd;
        uint256 volumeXrp;
        int256 changeBps;
        uint256 obsTimestamp;
    }

    /// @notice An allocation instruction produced inside the confidential enclave.
    /// @dev The enclave's *strategy* is private; this plan is the only thing it reveals, and the
    ///      vault re-derives every transfer from its own ledger rather than trusting the plan's
    ///      arithmetic. `targetBps` must sum to exactly `BPS_DENOMINATOR`.
    struct RebalancePlan {
        uint256 nonce;
        uint64 deadline;
        bytes32 signalHash;
        uint256 refPriceMicroUsd;
        uint16[] targetBps;
    }

    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Canonical hash binding a plan to the exact signal it was computed from.
    /// @dev Prevents an enclave from replaying a favourable plan against a newer market state.
    function hashSignal(MarketSignal memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                s.lastMicroUsd,
                s.vwapMicroUsd,
                s.highMicroUsd,
                s.lowMicroUsd,
                s.volumeXrp,
                s.changeBps,
                s.obsTimestamp
            )
        );
    }

    /// @notice EIP-712-style struct hash for the plan, signed by the enclave identity.
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
