// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {OVaultBase} from "./OVaultBase.sol";
import {FxrpOFTAdapter} from "../../src/ovault/FxrpOFTAdapter.sol";

/// @notice Deploys the hub-side FXRP OFT adapter on Coston2.
///
/// @dev This is the blocking prerequisite from `docs/OVAULT.md` §2: until FXRP has an OFT on Coston2
///      with a wired peer on a spoke, the composer can be deployed but no cross-chain deposit can
///      complete.
///
///      Deploy this **first**. The composer's constructor reads `ASSET_OFT.token()` and reverts
///      unless it equals `vault.asset()`.
///
///      Usage:
///        forge script script/ovault/DeployAssetOFTAdapter.s.sol:DeployAssetOFTAdapter \
///          --rpc-url coston2 --broadcast --verify
contract DeployAssetOFTAdapter is OVaultBase {
    function run() external returns (address adapter) {
        address fxrp = _resolveFXRP();
        address endpoint = _endpoint();
        address delegate = _deployer();
        address recovery = _strandedFundsRecipient();

        _logHeader("Deploying FxrpOFTAdapter (hub)");
        console2.log("FXRP            :", fxrp);
        console2.log("LZ endpoint     :", endpoint);
        console2.log("Owner/delegate  :", delegate);
        console2.log("Recovery address:", recovery);

        vm.startBroadcast(_deployerKey());
        FxrpOFTAdapter deployed = new FxrpOFTAdapter(fxrp, endpoint, delegate, recovery);
        vm.stopBroadcast();

        adapter = address(deployed);

        console2.log("");
        console2.log("FxrpOFTAdapter  :", adapter);
        console2.log("");
        console2.log("Next: export ASSET_OFT=%s", adapter);

        // A lockbox adapter always requires approval of the underlying to send. If this were ever
        // false the composer would treat it as mint-burn and the escrow accounting would be wrong.
        require(deployed.approvalRequired(), "adapter is not a lockbox");
        require(deployed.token() == fxrp, "adapter token mismatch");
    }
}
