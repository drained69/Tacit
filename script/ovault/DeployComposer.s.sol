// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OVaultBase} from "./OVaultBase.sol";
import {TacitOVaultComposer} from "../../src/ovault/TacitOVaultComposer.sol";

/// @notice Deploys the composer on Coston2. Run after both hub adapters exist.
///
/// @dev The constructor does three checks that between them catch every wiring mistake worth
///      catching, so a successful deploy is meaningful: `ASSET_OFT.token() == vault.asset()`,
///      `SHARE_OFT.token() == vault`, and `SHARE_OFT.approvalRequired() == true`. It also sets its
///      own internal approvals — vault to pull FXRP, share adapter to pull `tFXRP`.
///
///      Usage:
///        forge script script/ovault/DeployComposer.s.sol:DeployComposer \
///          --rpc-url coston2 --broadcast --verify
contract DeployComposer is OVaultBase {
    function run() external returns (address composer) {
        address vault = vm.envAddress("TACIT_VAULT");
        address assetOFT = vm.envAddress("ASSET_OFT");
        address shareOFT = vm.envAddress("SHARE_OFT");
        address recovery = _strandedFundsRecipient();

        _logHeader("Deploying TacitOVaultComposer (hub)");
        console2.log("Vault           :", vault);
        console2.log("Asset OFT       :", assetOFT);
        console2.log("Share OFT       :", shareOFT);
        console2.log("Recovery address:", recovery);

        vm.startBroadcast(_deployerKey());
        TacitOVaultComposer deployed = new TacitOVaultComposer(vault, assetOFT, shareOFT, recovery);
        vm.stopBroadcast();

        composer = address(deployed);

        console2.log("");
        console2.log("Composer        :", composer);
        console2.log("");
        console2.log("Next: export TACIT_OVAULT_COMPOSER=%s", composer);
        console2.log("Then register it as the compose target on each spoke.");
    }
}
