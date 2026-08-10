// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test, console2} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {SignalTypes} from "../src/lib/SignalTypes.sol";

/// @notice Cross-language conformance between the Go enclave and the Solidity vault.
///
/// @dev This is the single highest-risk seam in the system. The enclave hashes the signal and the
///      plan in Go; the vault re-hashes them in Solidity and recovers the signer. If the two
///      encodings disagree by even one byte, every rebalance fails with `BadSigner` and the cause
///      is invisible from either side alone — the signature is valid, just over different bytes.
///
///      The vectors below are **captured verbatim from a live run** of `tee/` (key 0x…0a11ce,
///      chain 114). Regenerate with:
///
///        cd tee && TACIT_TEE_KEY=00000000000000000000000000000000000000000000000000000000000a11ce \
///          SIMULATED_TEE=true go run .
///        curl -s -X POST localhost:8080/action \
///          -H "Content-Type: application/json" --data-binary "test/fixtures/enclave_request.json"
///
///      Three separate encodings have to line up: `abi.encode` of the signal struct, the
///      EIP-712-style plan struct hash (which includes `abi.encodePacked(uint16[])`, a tight
///      2-bytes-per-element form that differs from `abi.encode`), and the EIP-191 personal-sign
///      prefix over the chain/vault replay context.
contract EnclaveConformanceTest is Test {
    uint256 constant CHAIN_ID = 114; // Coston2
    address constant VAULT = 0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9;
    address constant EXPECTED_IDENTITY = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;

    bytes32 constant EXPECTED_SIGNAL_HASH =
        0x992f847713d8504d9117a34c7d2490129b6e4475518f0a4f8df225eeb1781ec2;

    bytes constant ENCLAVE_SIGNATURE =
        hex"c068563144658971d7dc7d0bd4babf5f74bb888778b72c327d4cdb6c621cb35e"
        hex"472b695273233d4499cda44d2dd64282efcf897990da191efabd4897de9d2a23"
        hex"1b";

    function _signal() internal pure returns (SignalTypes.MarketSignal memory) {
        // A real Bitstamp XRP/USD observation. Used here as a fixed vector for the hashing
        // conformance check — this test is about Go/Solidity byte agreement, not attestation.
        return SignalTypes.MarketSignal({
            lastMicroUsd: 1_038_910,
            vwapMicroUsd: 1_040_130,
            highMicroUsd: 1_048_060,
            lowMicroUsd: 1_030_290,
            volumeXrp: 8_957_657,
            changeBps: -22, // negative: exercises two's-complement encoding on both sides
            obsTimestamp: 1_786_281_701
        });
    }

    function _plan() internal pure returns (SignalTypes.RebalancePlan memory p) {
        uint16[] memory targets = new uint16[](2);
        targets[0] = 1978; // the enclave's own output, not a round number
        targets[1] = 4770;

        p = SignalTypes.RebalancePlan({
            nonce: 0,
            deadline: 1_786_400_000,
            signalHash: EXPECTED_SIGNAL_HASH,
            refPriceMicroUsd: 1_038_910,
            targetBps: targets
        });
    }

    /// @notice Go's `HashSignal` and Solidity's `hashSignal` agree, including on a negative int256.
    function test_signalHashMatchesEnclave() public pure {
        bytes32 solidityHash = SignalTypes.hashSignal(_signal());
        assertEq(solidityHash, EXPECTED_SIGNAL_HASH, "signal hash diverged from the Go enclave");
    }

    /// @notice A signature produced by the Go enclave recovers to its advertised identity.
    function test_enclaveSignatureRecoversToIdentity() public {
        vm.chainId(CHAIN_ID);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, VAULT, SignalTypes.hashPlan(_plan())))
        );
        address recovered = ECDSA.recover(digest, ENCLAVE_SIGNATURE);

        console2.log("recovered:", recovered);
        console2.log("expected :", EXPECTED_IDENTITY);
        assertEq(recovered, EXPECTED_IDENTITY, "Go/Solidity plan encoding diverged");
    }

    /// @notice The replay binding is real: the same signature must fail against another vault.
    function test_signatureDoesNotRecoverForDifferentVault() public {
        vm.chainId(CHAIN_ID);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(0xdead), SignalTypes.hashPlan(_plan())))
        );
        assertTrue(ECDSA.recover(digest, ENCLAVE_SIGNATURE) != EXPECTED_IDENTITY, "vault not bound");
    }

    /// @notice And against another chain.
    function test_signatureDoesNotRecoverForDifferentChain() public {
        vm.chainId(1);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, VAULT, SignalTypes.hashPlan(_plan())))
        );
        assertTrue(ECDSA.recover(digest, ENCLAVE_SIGNATURE) != EXPECTED_IDENTITY, "chain not bound");
    }

    /// @notice Any tampering with the plan invalidates the signature.
    function test_tamperedTargetsBreakSignature() public {
        vm.chainId(CHAIN_ID);

        SignalTypes.RebalancePlan memory tampered = _plan();
        tampered.targetBps[1] = 4771; // one basis point

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, VAULT, SignalTypes.hashPlan(tampered)))
        );
        assertTrue(ECDSA.recover(digest, ENCLAVE_SIGNATURE) != EXPECTED_IDENTITY, "targets not bound");
    }
}
