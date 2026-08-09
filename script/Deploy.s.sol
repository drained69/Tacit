// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TacitVault} from "../src/TacitVault.sol";
import {LendingVenue} from "../src/venues/LendingVenue.sol";
import {ERC4626Venue} from "../src/venues/ERC4626Venue.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";

/// @notice Deploys TacitVault and two venues to Coston2.
///
/// @dev FXRP is resolved from `AssetManagerFXRP.fAsset()` via the Flare contract registry rather
///      than hardcoded, so this script keeps working when Flare rotates addresses.
///
///      Usage:
///        forge script script/Deploy.s.sol:Deploy --rpc-url coston2 --broadcast \
///          --private-key $PRIVATE_KEY --sig "run(address)" $TEE_IDENTITY
contract Deploy is Script {
    address constant CONTRACT_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /// @notice Live Firelight stXRP vault on Coston2, holding ~100k FXRP.
    address constant FIRELIGHT_STXRP = 0xC90D6847747b85d1fa2E07859869fb9fB72c0361;

    function run(address teeIdentity) external {
        address fxrp = _resolveFXRP();
        console2.log("FXRP           :", fxrp);
        console2.log("TEE identity   :", teeIdentity);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        TacitVault vault = new TacitVault(IERC20(fxrp), "Tacit FXRP", "tFXRP", deployer);
        console2.log("TacitVault  :", address(vault));

        // Two venues with different risk/return profiles, so allocation is a real decision.
        LendingVenue conservative = new LendingVenue(IERC20(fxrp), address(vault), 800, deployer);
        LendingVenue aggressive = new LendingVenue(IERC20(fxrp), address(vault), 1_500, deployer);
        console2.log("Venue A (8%)   :", address(conservative));
        console2.log("Venue B (15%)  :", address(aggressive));

        // Caps sum to more than 100% on purpose: the enclave has room to choose, but neither
        // venue can ever hold more than 60% of the vault.
        vault.addVenue(IVenue(address(conservative)), 6_000, true);
        vault.addVenue(IVenue(address(aggressive)), 6_000, true);

        // Firelight stXRP: a live third-party FXRP vault, not a stand-in.
        //
        // Registered as NOT liquid-on-demand. Fork testing showed it settles withdrawals
        // asynchronously behind a synchronous ERC-4626 interface, so its balance must never be
        // counted toward what depositors can redeem right now. Capital may still be allocated
        // there; the cap bounds how much can be waiting on a queue at any moment.
        ERC4626Venue firelight =
            new ERC4626Venue(IERC4626(FIRELIGHT_STXRP), address(vault), "Firelight stXRP");
        vault.addVenue(IVenue(address(firelight)), 3_000, false);
        console2.log("Firelight stXRP:", address(firelight));
        vault.setTeeIdentity(teeIdentity);

        vm.stopBroadcast();

        console2.log("");
        console2.log("Guardrails:");
        console2.log("  max turnover / rebalance : 30%");
        console2.log("  min rebalance interval   : 300s");
        console2.log("  FTSO price band          : 5%");
        console2.log("  max signal age           : 3600s");
        console2.log("  per-venue cap            : 60%");
    }

    function _resolveFXRP() internal view returns (address) {
        (bool ok, bytes memory data) = CONTRACT_REGISTRY.staticcall(
            abi.encodeWithSignature("getContractAddressByName(string)", "AssetManagerFXRP")
        );
        require(ok && data.length >= 32, "registry lookup failed");
        address assetManager = abi.decode(data, (address));

        (bool ok2, bytes memory data2) = assetManager.staticcall(abi.encodeWithSignature("fAsset()"));
        require(ok2 && data2.length >= 32, "fAsset lookup failed");
        return abi.decode(data2, (address));
    }
}
