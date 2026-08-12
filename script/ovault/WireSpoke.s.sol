// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {EnforcedOptionParam} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";

import {OVaultBase, IOAppWiring} from "./OVaultBase.sol";

/// @notice Wires the spoke side: both Base Sepolia OFTs learn their hub counterparts, and — the part
///         that actually makes cross-chain depositing work — get executor gas for the compose hop.
///
/// @dev Enforced options are keyed on `(dstEid, msgType)`, and a send carrying a compose message is
///      msgType **2**, not 1. Setting only msgType 1 is the single most likely wiring mistake here: a
///      plain bridge would work perfectly, and every deposit would arrive at the hub with no gas
///      budgeted for `lzCompose`, leaving FXRP sitting in the composer with a stuck message. Both
///      msg types are set below for both tokens.
///
///      Both directions of the round trip need msgType 2: the asset OFT carries a deposit compose to
///      the hub, and the share OFT carries a redeem compose to the hub.
///
///      Usage:
///        forge script script/ovault/WireSpoke.s.sol:WireSpoke --rpc-url base_sepolia --broadcast
contract WireSpoke is OVaultBase {
    using OptionsBuilder for bytes;

    function run() external {
        address assetOFT = vm.envAddress("ASSET_OFT");
        address shareOFT = vm.envAddress("SHARE_OFT");
        address spokeAssetOFT = vm.envAddress("SPOKE_ASSET_OFT");
        address spokeShareOFT = vm.envAddress("SPOKE_SHARE_OFT");

        require(block.chainid != 114, "run this against the spoke, not the hub");

        _logHeader("Wiring spoke -> hub");
        console2.log("Hub EID         :", HUB_EID);
        console2.log("Asset OFT (spoke):", spokeAssetOFT);
        console2.log("Share OFT (spoke):", spokeShareOFT);

        // msgType 1: a plain bridge. The hub adapter releases from escrow and stops.
        bytes memory sendOptions =
            OptionsBuilder.newOptions().addExecutorLzReceiveOption(GAS_RECEIVE_TRANSFER, 0);

        // msgType 2: a deposit or redeem. The hub adapter releases to the composer and registers the
        // compose message, then the executor calls `lzCompose`, which runs the vault operation and the
        // outbound hop. Compose index is 0 — there is exactly one compose per message.
        bytes memory composeOptions = OptionsBuilder.newOptions().addExecutorLzReceiveOption(
            GAS_RECEIVE_TRANSFER_AND_COMPOSE, 0
        ).addExecutorLzComposeOption(0, GAS_COMPOSE, 0);

        EnforcedOptionParam[] memory opts = new EnforcedOptionParam[](2);
        opts[0] = EnforcedOptionParam({eid: HUB_EID, msgType: MSG_TYPE_SEND, options: sendOptions});
        opts[1] =
            EnforcedOptionParam({eid: HUB_EID, msgType: MSG_TYPE_SEND_AND_CALL, options: composeOptions});

        vm.startBroadcast(_deployerKey());

        _setPeer(spokeAssetOFT, "asset", HUB_EID, assetOFT);
        IOAppWiring(spokeAssetOFT).setEnforcedOptions(opts);
        console2.log("  [ok]   asset enforced options set (SEND + SEND_AND_CALL)");

        _setPeer(spokeShareOFT, "share", HUB_EID, shareOFT);
        IOAppWiring(spokeShareOFT).setEnforcedOptions(opts);
        console2.log("  [ok]   share enforced options set (SEND + SEND_AND_CALL)");

        vm.stopBroadcast();

        console2.log("");
        console2.log("Spoke wired. The pathway is now live in both directions.");
    }
}
