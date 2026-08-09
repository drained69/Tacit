// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {TacitVault} from "../src/TacitVault.sol";
import {ERC4626Venue} from "../src/venues/ERC4626Venue.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";

/// @notice Fork tests against **Firelight stXRP**, a live third-party FXRP vault on Coston2.
///
/// @dev This is the difference between claiming the adapter composes with real protocols and
///      showing it. Everything here runs against the actual deployed bytecode of a vault nobody on
///      this project wrote or controls, holding ~100k FXRP of other people's money.
///
///      Skipped automatically when no Coston2 RPC is reachable, so the suite stays runnable
///      offline. Run explicitly with:
///
///        forge test --match-contract FirelightFork --fork-url coston2 -vv
contract FirelightForkIntegrationTest is Test {
    // Live on Coston2. Resolved from the Flare docs and verified on-chain before use.
    address constant FIRELIGHT_STXRP = 0xC90D6847747b85d1fa2E07859869fb9fB72c0361;
    address constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;

    uint256 constant M = 1e6; // FXRP has 6 decimals, not 18

    TacitVault vault;
    ERC4626Venue venue;
    IERC20 fxrp = IERC20(FXRP);

    address owner = address(this);
    address alice = makeAddr("alice");

    bool forked;

    function setUp() public {
        try vm.createSelectFork("coston2") {
            forked = true;
        } catch {
            return; // no RPC configured; every test below no-ops
        }

        vault = new TacitVault(fxrp, "Tacit FXRP", "tFXRP", owner);
        venue = new ERC4626Venue(IERC4626(FIRELIGHT_STXRP), address(vault), "Firelight stXRP");
        // Declared NOT liquid-on-demand: probeSynchronous() reports false for Firelight.
        vault.addVenue(IVenue(address(venue)), 5_000, false);

        // Source FXRP by transferring from an existing holder rather than with `deal`.
        //
        // FXRP is a proxy over an FAsset implementation with checkpointed balances, so writing the
        // balance slot directly leaves `totalSupply` and the checkpoint history inconsistent and
        // the next transfer underflows. Moving real tokens keeps every internal invariant intact,
        // which is the whole point of testing against live bytecode.
        _fundFromHolder(alice, 600 * M);

        vm.prank(alice);
        fxrp.approve(address(vault), type(uint256).max);
    }

    /// @dev The AssetManager holds a working FXRP balance and is not the contract under test, so
    ///      borrowing from it does not perturb Firelight's own share price.
    function _fundFromHolder(address to, uint256 amount) internal {
        address holder = 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA; // AssetManagerFXRP
        require(fxrp.balanceOf(holder) >= amount, "holder drained; pick another source");
        vm.prank(holder);
        fxrp.transfer(to, amount);
    }

    modifier onlyForked() {
        if (!forked) {
            console2.log("SKIP: no Coston2 fork available");
            return;
        }
        _;
    }

    /// @notice The live vault is what we think it is. Guards against the address going stale.
    function test_firelightIsALiveFxrpVault() public onlyForked {
        IERC4626 st = IERC4626(FIRELIGHT_STXRP);
        assertEq(st.asset(), FXRP, "Firelight must be denominated in FXRP");
        assertGt(st.totalAssets(), 0, "Firelight should hold real deposits");
        assertEq(st.decimals(), 6, "FXRP-denominated shares are 6dp");

        console2.log("Firelight stXRP TVL (FXRP):", st.totalAssets() / M);
    }

    /// @notice Capital reaches the real vault, and the adapter refuses to lose track of it.
    ///
    /// @dev This test documents the most valuable thing fork testing found. Firelight stXRP looks
    ///      like a synchronous ERC-4626 vault and is not: `withdraw()` returns success, burns the
    ///      shares, emits `WithdrawRequest(id)` — and transfers nothing. Settlement happens out of
    ///      band.
    ///
    ///      An adapter that trusted the interface would report the position as gone, because
    ///      `totalAssets()` is derived from a share balance that is now zero. TacitVault would then
    ///      book real, merely-pending capital as a total loss. The adapter reverts instead.
    function test_adapterRefusesAsyncWithdrawalRatherThanLosingFunds() public onlyForked {
        vm.prank(alice);
        vault.deposit(300 * M, alice);

        vm.prank(address(vault));
        fxrp.approve(address(venue), 200 * M);
        vm.prank(address(vault));
        venue.deposit(200 * M);

        assertGt(venue.targetShares(), 0, "adapter holds real stXRP shares");
        assertApproxEqRel(venue.totalAssets(), 200 * M, 0.01e18, "venue values its position");
        console2.log("stXRP shares held:", venue.targetShares());

        uint256 pullable = venue.maxWithdraw();
        assertGt(pullable, 0, "Firelight advertises the full position as withdrawable");

        // The revert is the correct outcome: it unwinds the share burn, so the position survives.
        vm.prank(address(vault));
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Venue.AsyncWithdrawalUnsupported.selector, FIRELIGHT_STXRP, 200 * M
            )
        );
        venue.withdraw(pullable);

        assertGt(venue.targetShares(), 0, "shares survive - the burn was rolled back");
        assertApproxEqRel(venue.totalAssets(), 200 * M, 0.01e18, "position intact, nothing lost");
        console2.log("after refused withdrawal, shares still held:", venue.targetShares());
    }

    /// @notice The compatibility probe reports the mismatch without moving capital irreversibly.
    function test_probeDetectsAsyncVault() public onlyForked {
        vm.prank(alice);
        vault.deposit(300 * M, alice);
        vm.prank(address(vault));
        fxrp.approve(address(venue), 200 * M);
        vm.prank(address(vault));
        venue.deposit(200 * M);

        assertFalse(venue.probeSynchronous(), "Firelight must be detected as asynchronous");
        console2.log("probeSynchronous(Firelight) = false, as expected");
    }

    /// @notice Depositors stay whole even with capital parked in an uncooperative venue.
    function test_depositorsRemainWholeDespiteAsyncVenue() public onlyForked {
        uint256 startBal = fxrp.balanceOf(alice);

        vm.prank(alice);
        vault.deposit(300 * M, alice);

        vm.prank(address(vault));
        fxrp.approve(address(venue), 150 * M);
        vm.prank(address(vault));
        venue.deposit(150 * M);

        // Because the venue was registered as NOT liquid-on-demand, its 150 FXRP is never counted
        // toward what depositors can redeem. The quote is honest from the first call — no failed
        // redemption is needed to discover it.
        uint256 redeemable = vault.maxRedeem(alice);
        uint256 quotedAssets = vault.convertToAssets(redeemable);
        assertGt(quotedAssets, 0, "the idle reserve keeps the vault partially liquid");
        assertLt(quotedAssets, 300 * M, "quote excludes the illiquid venue");
        console2.log("honestly redeemable now (FXRP):", quotedAssets / M);

        vm.prank(alice);
        vault.redeem(redeemable, alice, alice);

        assertLe(fxrp.balanceOf(alice), startBal, "round trip must not mint value");
        assertGt(fxrp.balanceOf(alice), 0, "user recovered the liquid portion");

        uint256 residual = vault.convertToAssets(vault.balanceOf(alice));
        console2.log("recovered now (FXRP) :", fxrp.balanceOf(alice) / M);
        console2.log("still claimable (FXRP):", residual / M);
        assertApproxEqRel(
            fxrp.balanceOf(alice) + residual, startBal, 0.01e18, "no value lost overall"
        );
    }

    /// @notice The adapter reports the foreign vault's liquidity rather than assuming it.
    function test_adapterReportsRealLiquidity() public onlyForked {
        vm.prank(alice);
        vault.deposit(300 * M, alice);

        vm.prank(address(vault));
        fxrp.approve(address(venue), 100 * M);
        vm.prank(address(vault));
        venue.deposit(100 * M);

        uint16 liq = venue.liquidityBps();
        assertLe(liq, 10_000, "liquidity is a fraction");
        console2.log("Firelight liquidity (bps):", liq);

        // maxWithdraw must never over-promise relative to the position's value.
        assertLe(venue.maxWithdraw(), venue.totalAssets() + 1, "maxWithdraw cannot exceed value");
    }
}
