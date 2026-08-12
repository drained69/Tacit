// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";

import {EnforcedOptionParam} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";

/// @notice The two configuration calls every OFT and OFT adapter in this deployment needs.
/// @dev Both hub adapters and both spoke OFTs expose these, but through different inheritance paths.
///      One interface keeps the wiring scripts from caring which concrete type they hold.
interface IOAppWiring {
    function setPeer(uint32 _eid, bytes32 _peer) external;
    function setEnforcedOptions(EnforcedOptionParam[] calldata _params) external;
    function peers(uint32 _eid) external view returns (bytes32);
    function owner() external view returns (address);
}

/// @notice Shared plumbing for the OVault deployment and wiring scripts.
///
/// @dev Holds the addresses and endpoint IDs the OVault layer needs, plus the environment-variable
///      reads. Every value here was read off-chain rather than taken from a docs page, and the
///      commands to re-read them are in `docs/OVAULT.md` §1.
///
///      No script in this directory hardcodes FXRP. `_resolveFXRP()` walks the Flare contract
///      registry the same way `script/Deploy.s.sol` does, so a Flare address rotation does not
///      silently point the asset adapter at a dead token.
abstract contract OVaultBase is Script {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @dev LayerZero EndpointV2. The same address on Coston2 and Base Sepolia — verified by calling
    ///      `eid()` on both, which returns 40294 and 40245 respectively.
    address internal constant LZ_ENDPOINT_V2 = 0x6EDCE65403992e310A62460808c4b910D972f10f;

    /// @dev Coston2, the hub. Inside LayerZero's testnet EID band; matches `FLARE_V2_TESTNET`.
    uint32 internal constant HUB_EID = 40294;

    /// @dev Base Sepolia, the spoke used for this deployment.
    uint32 internal constant BASE_SEPOLIA_EID = 40245;

    address internal constant FLARE_CONTRACT_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /// @dev `OFTCore.SEND` / `OFTCore.SEND_AND_CALL`. Enforced options are keyed on (dstEid, msgType),
    ///      and a send that carries a compose message is msgType 2, not 1 — setting only 1 leaves the
    ///      deposit path with no executor gas and the depositor holding a stuck message.
    uint16 internal constant MSG_TYPE_SEND = 1;
    uint16 internal constant MSG_TYPE_SEND_AND_CALL = 2;

    // ---------------------------------------------------------------------
    // Executor gas
    // ---------------------------------------------------------------------
    //
    // These are deliberately generous. Unused `lzReceive` gas is not refunded, so overpaying costs
    // the sender a slightly larger source-chain fee; underpaying strands a message that has already
    // taken custody of the sender's tokens. On a testnet the first is free and the second is not
    // recoverable without manual intervention, so every figure here has headroom.

    /// @dev `lzReceive` on a spoke OFT: `_mint`. A cold-slot mint plus endpoint bookkeeping.
    uint128 internal constant GAS_RECEIVE_MINT = 120_000;

    /// @dev `lzReceive` on a hub adapter: `safeTransfer` out of escrow, wrapped in the try/catch that
    ///      reroutes an undeliverable recipient instead of reverting inside `lzReceive`.
    uint128 internal constant GAS_RECEIVE_TRANSFER = 150_000;

    /// @dev `lzReceive` on a hub adapter when the message also carries a compose: the transfer above,
    ///      plus `endpoint.sendCompose` storing the message hash.
    uint128 internal constant GAS_RECEIVE_TRANSFER_AND_COMPOSE = 200_000;

    /// @dev `lzCompose` on the composer: a full `TacitVault.deposit` (or `redeem`) including the five
    ///      guardrail checks, then the outbound share hop. When the hop terminates on the hub —
    ///      the default, and the case with no native-drop requirement — that hop is a plain transfer.
    uint128 internal constant GAS_COMPOSE = 600_000;

    // ---------------------------------------------------------------------
    // Environment
    // ---------------------------------------------------------------------

    function _deployerKey() internal view returns (uint256) {
        return vm.envUint("PRIVATE_KEY");
    }

    function _deployer() internal view returns (address) {
        return vm.addr(_deployerKey());
    }

    function _endpoint() internal view returns (address) {
        return vm.envOr("LZ_ENDPOINT", LZ_ENDPOINT_V2);
    }

    /// @dev Defaults to the deployer. That is the right default for a testnet deployment and the
    ///      wrong one for anything holding real value — the recovery address is a custodian of other
    ///      people's funds and should be a multisig. `docs/OVAULT.md` §3 says so at more length.
    function _strandedFundsRecipient() internal view returns (address) {
        return vm.envOr("STRANDED_FUNDS_RECIPIENT", _deployer());
    }

    function _spokeEid() internal view returns (uint32) {
        return uint32(vm.envOr("SPOKE_EID", uint256(BASE_SEPOLIA_EID)));
    }

    // ---------------------------------------------------------------------
    // Registry
    // ---------------------------------------------------------------------

    /// @notice Resolves FXRP via `AssetManagerFXRP.fAsset()` on the Flare contract registry.
    /// @dev Only callable against a Flare chain. Spoke-side scripts must not call this.
    function _resolveFXRP() internal view returns (address) {
        (bool ok, bytes memory data) = FLARE_CONTRACT_REGISTRY.staticcall(
            abi.encodeWithSignature("getContractAddressByName(string)", "AssetManagerFXRP")
        );
        require(ok && data.length >= 32, "registry lookup failed");
        address assetManager = abi.decode(data, (address));

        (bool ok2, bytes memory data2) = assetManager.staticcall(abi.encodeWithSignature("fAsset()"));
        require(ok2 && data2.length >= 32, "fAsset lookup failed");
        return abi.decode(data2, (address));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev LayerZero addresses peers as `bytes32` so a pathway can terminate on a non-EVM chain.
    function _asPeer(address _addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_addr)));
    }

    /// @notice Points `_oapp` at `_peer` on `_eid`, skipping the write if it already points there.
    /// @dev Idempotent on purpose. Wiring is the step most likely to be re-run — one leg failed, an
    ///      address was corrected, a spoke was added — and a re-run should cost nothing for the legs
    ///      that were already right rather than burning gas to write the same word.
    ///
    ///      A peer is one-directional. Setting it here lets the hub *send*; the spoke will still drop
    ///      inbound messages until its own `setPeer` runs. Both wiring scripts must complete.
    function _setPeer(address _oapp, string memory _label, uint32 _eid, address _peer) internal {
        bytes32 want = _asPeer(_peer);
        bytes32 have = IOAppWiring(_oapp).peers(_eid);

        if (have == want) {
            console2.log("  [skip] %s peer already set", _label);
            return;
        }
        if (have != bytes32(0)) {
            console2.log("  [warn] %s peer is being REPLACED, old value:", _label);
            console2.logBytes32(have);
        }

        IOAppWiring(_oapp).setPeer(_eid, want);
        console2.log("  [ok]   %s peer -> %s", _label, _peer);
    }

    function _logHeader(string memory _title) internal pure {
        console2.log("");
        console2.log(_title);
        console2.log("---------------------------------------------");
    }
}
