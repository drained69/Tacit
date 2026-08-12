// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {EnforcedOptionParam} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";

import {OVaultBase, IOAppWiring} from "./OVaultBase.sol";

/// @notice Wires the hub side: both Coston2 adapters learn their spoke counterparts.
///
/// @dev A peer is **one-directional**. This script only teaches the hub where to send; until
///      `WireSpoke` has also run, a message from the spoke arrives at the hub endpoint and is
///      rejected as coming from an unrecognised sender. Both scripts must complete before any
///      cross-chain deposit will work, and the failure mode of forgetting one is a silently
///      undeliverable message rather than a revert at send time.
///
///      Usage:
///        forge script script/ovault/WireHub.s.sol:WireHub --rpc-url coston2 --broadcast
contract WireHub is OVaultBase {
    using OptionsBuilder for bytes;

    function run() external {
        address assetOFT = vm.envAddress("ASSET_OFT");
        address shareOFT = vm.envAddress("SHARE_OFT");
        address spokeAssetOFT = vm.envAddress("SPOKE_ASSET_OFT");
        address spokeShareOFT = vm.envAddress("SPOKE_SHARE_OFT");
        uint32 spokeEid = _spokeEid();

        _logHeader("Wiring hub -> spoke");
        console2.log("Spoke EID       :", spokeEid);
        console2.log("Asset OFT (hub) :", assetOFT);
        console2.log("Share OFT (hub) :", shareOFT);

        // Everything the hub sends to a spoke is a plain delivery: the composer's outbound hop mints
        // to a recipient and stops. Nothing on a spoke composes further, so msgType 1 is the whole
        // surface — and the destination work is an OFT `_mint` in both cases.
        bytes memory mintOptions = OptionsBuilder.newOptions().addExecutorLzReceiveOption(GAS_RECEIVE_MINT, 0);

        EnforcedOptionParam[] memory opts = new EnforcedOptionParam[](1);
        opts[0] = EnforcedOptionParam({eid: spokeEid, msgType: MSG_TYPE_SEND, options: mintOptions});

        vm.startBroadcast(_deployerKey());

        _setPeer(assetOFT, "asset", spokeEid, spokeAssetOFT);
        IOAppWiring(assetOFT).setEnforcedOptions(opts);
        console2.log("  [ok]   asset enforced options set (SEND)");

        _setPeer(shareOFT, "share", spokeEid, spokeShareOFT);
        IOAppWiring(shareOFT).setEnforcedOptions(opts);
        console2.log("  [ok]   share enforced options set (SEND)");

        vm.stopBroadcast();

        console2.log("");
        console2.log("Hub wired. Run WireSpoke against the spoke before depositing.");
    }
}
