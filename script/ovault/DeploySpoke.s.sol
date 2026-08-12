// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OVaultBase} from "./OVaultBase.sol";
import {SpokeFxrpOFT} from "../../src/ovault/SpokeFxrpOFT.sol";
import {SpokeTacitShareOFT} from "../../src/ovault/SpokeTacitShareOFT.sol";

/// @notice Deploys both spoke-side OFTs on Base Sepolia in one transaction batch.
///
/// @dev These are the only two mint-burn contracts in the deployment. Everything on the hub escrows.
///      `SpokeTacitShareOFT`'s doc header explains why that pair of decisions is really one decision.
///
///      Run against the spoke, never the hub — deploying an FXRP OFT on Coston2 would create a second
///      representation of a token that already exists there natively.
///
///      Usage:
///        forge script script/ovault/DeploySpoke.s.sol:DeploySpoke \
///          --rpc-url base_sepolia --broadcast --verify
contract DeploySpoke is OVaultBase {
    function run() external returns (address assetOFT, address shareOFT) {
        address endpoint = _endpoint();
        address delegate = _deployer();

        require(block.chainid != 114, "this is the hub: FXRP already exists natively here");

        _logHeader("Deploying spoke OFTs");
        console2.log("Chain id        :", block.chainid);
        console2.log("LZ endpoint     :", endpoint);
        console2.log("Owner/delegate  :", delegate);

        vm.startBroadcast(_deployerKey());
        SpokeFxrpOFT asset = new SpokeFxrpOFT(endpoint, delegate);
        SpokeTacitShareOFT share = new SpokeTacitShareOFT(endpoint, delegate);
        vm.stopBroadcast();

        assetOFT = address(asset);
        shareOFT = address(share);

        console2.log("");
        console2.log("SpokeFxrpOFT    :", assetOFT);
        console2.log("SpokeShareOFT   :", shareOFT);
        console2.log("");
        console2.log("Next: export SPOKE_ASSET_OFT=%s", assetOFT);
        console2.log("      export SPOKE_SHARE_OFT=%s", shareOFT);

        // Decimals have to match the hub or every bridged amount is off by a factor of 1000, and
        // silently, because both sides still balance against themselves. Assert rather than trust.
        require(asset.decimals() == 6, "spoke FXRP decimals must be 6");
        require(share.decimals() == 9, "spoke share decimals must be 9");
    }
}
