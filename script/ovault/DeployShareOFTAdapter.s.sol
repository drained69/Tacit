// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OVaultBase} from "./OVaultBase.sol";
import {TacitShareOFTAdapter} from "../../src/ovault/TacitShareOFTAdapter.sol";

/// @notice Deploys the hub-side share OFT adapter on Coston2. One per deployment, hub chain only.
///
/// @dev A **lockbox**, not mint-burn, and the constructor's own assertions below make that concrete.
///      `tFXRP.totalSupply()` is one half of the exchange rate every depositor is priced against, so
///      destroying supply here to recreate it on a spoke would silently rewrite that rate for
///      everyone who never left the hub. `docs/OVAULT.md` §1.
///
///      Usage:
///        forge script script/ovault/DeployShareOFTAdapter.s.sol:DeployShareOFTAdapter \
///          --rpc-url coston2 --broadcast --verify
contract DeployShareOFTAdapter is OVaultBase {
    function run() external returns (address adapter) {
        address vault = vm.envAddress("TACIT_VAULT");
        address endpoint = _endpoint();
        address delegate = _deployer();
        address recovery = _strandedFundsRecipient();

        _logHeader("Deploying TacitShareOFTAdapter (hub)");
        console2.log("Vault / share   :", vault);
        console2.log("LZ endpoint     :", endpoint);
        console2.log("Owner/delegate  :", delegate);
        console2.log("Recovery address:", recovery);

        vm.startBroadcast(_deployerKey());
        TacitShareOFTAdapter deployed = new TacitShareOFTAdapter(vault, endpoint, delegate, recovery);
        vm.stopBroadcast();

        adapter = address(deployed);

        console2.log("");
        console2.log("ShareOFTAdapter :", adapter);
        console2.log("");
        console2.log("Next: export SHARE_OFT=%s", adapter);

        // The composer's constructor reverts `ShareOFTNotAdapter` unless this is true. Checking here
        // turns that into a failure at the adapter deploy rather than one step later.
        require(deployed.approvalRequired(), "adapter is not a lockbox");
        require(deployed.token() == vault, "adapter token is not the vault");
    }
}
