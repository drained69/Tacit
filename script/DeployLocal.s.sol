// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TacitVault} from "../src/TacitVault.sol";
import {LendingVenue} from "../src/venues/LendingVenue.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {MockFXRP} from "../src/mocks/Mocks.sol";

/// @notice Stands up a fully-populated vault on a local node so the UI can be exercised against
///         real contract state rather than an empty page.
///
/// @dev Uses `MockFXRP` and seeds deposits, so the read path — TVL, share price, allocation bars,
///      guardrail values — renders with real numbers. It does *not* perform a rebalance: that
///      needs a genuine FDC proof, which only exists on a live network. The UI's
///      "no rebalance yet" state is therefore the honest thing to show here.
///
///        anvil &
///        forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 \
///          --broadcast --private-key 0xac09...ff80
contract DeployLocal is Script {
    // anvil's second account, used as the enclave identity so it is visibly distinct from the owner.
    address constant TEE_IDENTITY = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockFXRP fxrp = new MockFXRP();
        fxrp.mint(deployer, 500_000e6);

        TacitVault vault = new TacitVault(IERC20(address(fxrp)), "Tacit FXRP", "tFXRP", deployer);

        LendingVenue venueA = new LendingVenue(IERC20(address(fxrp)), address(vault), 800, deployer);
        LendingVenue venueB = new LendingVenue(IERC20(address(fxrp)), address(vault), 1_500, deployer);

        vault.addVenue(IVenue(address(venueA)), 6_000, true);
        vault.addVenue(IVenue(address(venueB)), 6_000, true);
        vault.setTeeIdentity(TEE_IDENTITY);

        // Pre-fund venue yield reserves so accrual is payable, then seed a deposit.
        fxrp.approve(address(venueA), type(uint256).max);
        fxrp.approve(address(venueB), type(uint256).max);
        venueA.fundReserve(20_000e6);
        venueB.fundReserve(20_000e6);

        fxrp.approve(address(vault), type(uint256).max);
        vault.deposit(12_480e6, deployer);

        vm.stopBroadcast();

        console2.log("FXRP  :", address(fxrp));
        console2.log("Vault :", address(vault));
        console2.log("VenueA:", address(venueA));
        console2.log("VenueB:", address(venueB));
        console2.log("");
        console2.log("UI: http://localhost:8123/?rpc=http://127.0.0.1:8545&vault=%s", address(vault));
    }
}
