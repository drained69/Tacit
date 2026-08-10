// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

import {TacitVault} from "../src/TacitVault.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {LendingVenue} from "../src/venues/LendingVenue.sol";
import {MockFXRP, MockFdcVerification, MockFtsoV2} from "../src/mocks/Mocks.sol";

contract StdVault is TacitVault {
    address public fdcMock;
    address public ftsoMock;

    constructor(IERC20 a, address o, address f, address ft)
        TacitVault(a, "Tacit FXRP", "tFXRP", o)
    {
        fdcMock = f;
        ftsoMock = ft;
    }

    function _fdcVerification() internal view override returns (IFdcVerification) {
        return IFdcVerification(fdcMock);
    }

    function _ftsoV2() internal view override returns (FtsoV2Interface) {
        return FtsoV2Interface(ftsoMock);
    }
}

/// @notice A venue that re-enters the vault the moment it is asked for funds.
/// @dev Models the actual threat: venues are foreign code, and `_withdraw` calls into them
///      *before* `super._withdraw` burns shares. Without a guard the caller's shares still exist
///      during the callback.
contract ReentrantVenue is IVenue {
    IERC20 private immutable _asset;
    TacitVault public immutable vault;
    address public victim;
    bool public armed;
    bool public reentryAttempted;
    bytes public reentryRevertData;

    constructor(IERC20 asset_, TacitVault vault_) {
        _asset = asset_;
        vault = vault_;
    }

    function arm(address victim_) external {
        victim = victim_;
        armed = true;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function totalAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function maxWithdraw() external view returns (uint256) {
        return totalAssets();
    }

    function deposit(uint256 amount) external {
        _asset.transferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external returns (uint256) {
        if (armed) {
            armed = false;
            reentryAttempted = true;
            // Re-enter while the victim's shares are still outstanding. The revert *reason* is
            // captured, not just the fact of it: a reentrant call fails for several possible
            // reasons, and only one of them means the guard did its job.
            try vault.redeem(vault.balanceOf(victim), victim, victim) {
                reentryRevertData = "";
            } catch (bytes memory err) {
                reentryRevertData = err;
            }
        }
        uint256 amt = amount > totalAssets() ? totalAssets() : amount;
        if (amt > 0) _asset.transfer(msg.sender, amt);
        return amt;
    }
}

/// @notice Conformance to the standards this vault claims: ERC-4626, ERC-165, and the ordinary
///         safety conventions an integrator assumes are present.
contract StandardsComplianceTest is Test {
    uint256 constant M = 1e6;

    MockFXRP fxrp;
    StdVault vault;
    LendingVenue venue;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        fxrp = new MockFXRP();
        vault = new StdVault(
            IERC20(address(fxrp)), owner, address(new MockFdcVerification()), address(new MockFtsoV2())
        );
        venue = new LendingVenue(IERC20(address(fxrp)), address(vault), 800, owner);
        vault.addVenue(IVenue(address(venue)), 6_000, true);

        fxrp.mint(address(this), 100_000 * M);
        fxrp.approve(address(venue), type(uint256).max);
        venue.fundReserve(10_000 * M);

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            fxrp.mint(who, 10_000 * M);
            vm.prank(who);
            fxrp.approve(address(vault), type(uint256).max);
        }
    }

    // ── ERC-165 ───────────────────────────────────────────────────

    function test_advertisesItsInterfaces() public view {
        assertTrue(vault.supportsInterface(type(IERC4626).interfaceId), "ERC-4626");
        assertTrue(vault.supportsInterface(type(IERC20).interfaceId), "ERC-20");
        assertTrue(vault.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertFalse(vault.supportsInterface(0xdeadbeef), "must not claim everything");
    }

    // ── ERC-4626 round-trip semantics ─────────────────────────────

    function test_previewsMatchActuals() public {
        vm.prank(alice);
        uint256 predicted = vault.previewDeposit(1_000 * M);
        vm.prank(alice);
        uint256 actual = vault.deposit(1_000 * M, alice);
        assertEq(actual, predicted, "previewDeposit must match deposit");

        uint256 predictedAssets = vault.previewRedeem(actual);
        vm.prank(alice);
        uint256 actualAssets = vault.redeem(actual, alice, alice);
        assertEq(actualAssets, predictedAssets, "previewRedeem must match redeem");
    }

    function test_mintAndWithdrawPathsWork() public {
        uint256 sharesWanted = 500 * 1e9; // vault decimals = asset + 3
        vm.prank(alice);
        uint256 assetsPaid = vault.mint(sharesWanted, alice);
        assertEq(vault.balanceOf(alice), sharesWanted, "mint credits exact shares");
        assertGt(assetsPaid, 0);

        vm.prank(alice);
        vault.withdraw(100 * M, alice, alice);
        assertEq(fxrp.balanceOf(alice), 10_000 * M - assetsPaid + 100 * M);
    }

    function test_thirdPartyRedeemRequiresAllowance() public {
        vm.prank(alice);
        vault.deposit(1_000 * M, alice);
        uint256 shares = vault.balanceOf(alice);

        vm.prank(bob);
        vm.expectRevert();
        vault.redeem(shares, bob, alice);

        vm.prank(alice);
        vault.approve(bob, shares);
        vm.prank(bob);
        vault.redeem(shares, bob, alice);
        assertGt(fxrp.balanceOf(bob), 10_000 * M, "bob received the assets");
    }

    // ── Reentrancy ────────────────────────────────────────────────

    /// @notice A venue cannot re-enter redemption while the caller's shares still exist.
    /// @dev This is the concrete reason every ERC-4626 entry point is `nonReentrant`. `_withdraw`
    ///      calls into venue code before `super._withdraw` burns anything, so without the guard the
    ///      callback sees a state where the shares are still outstanding.
    function test_venueCannotReenterRedemption() public {
        ReentrantVenue evil = new ReentrantVenue(IERC20(address(fxrp)), TacitVault(payable(address(vault))));
        vault.addVenue(IVenue(address(evil)), 6_000, true);

        vm.prank(alice);
        vault.deposit(1_000 * M, alice);

        // Put funds in the hostile venue by hand; a rebalance would need a signed plan.
        vm.prank(address(vault));
        fxrp.approve(address(evil), 500 * M);
        vm.prank(address(vault));
        evil.deposit(500 * M);

        evil.arm(alice);

        uint256 aliceSharesBefore = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceSharesBefore, alice, alice);

        assertTrue(evil.reentryAttempted(), "the venue must actually have tried to re-enter");

        // Assert the guard specifically. Without this the test passes even with `nonReentrant`
        // removed, because the reentrant call happens to fail on liquidity instead — a green test
        // that proves nothing. Verified by mutation: deleting the modifier makes this line fail.
        bytes memory err = evil.reentryRevertData();
        assertEq(err.length, 4, "expected a bare custom-error selector");
        bytes4 selector = bytes4(bytes.concat(err[0], err[1], err[2], err[3]));
        assertEq(
            selector,
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentrancy must be stopped by the guard, not incidentally by something else"
        );

        assertLe(fxrp.balanceOf(alice), 10_000 * M, "alice cannot end up with more than she started");
    }

    // ── Pause semantics ───────────────────────────────────────────

    /// @notice Pausing stops money coming in. It must never stop money going out.
    /// @dev An operator who can freeze exits can rug. This asymmetry is the whole point of the
    ///      control, so it is asserted rather than left to a code comment.
    function test_pauseBlocksDepositsButNeverWithdrawals() public {
        vm.prank(alice);
        vault.deposit(1_000 * M, alice);

        vault.pause();

        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must report the pause");
        assertEq(vault.maxMint(alice), 0, "maxMint must report the pause");

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1 * M, alice);

        // Exits still work, in full.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertApproxEqAbs(fxrp.balanceOf(alice), 10_000 * M, 2, "withdrawal unaffected by pause");

        vault.unpause();
        vm.prank(alice);
        vault.deposit(1 * M, alice);
    }

    // ── Ownership ─────────────────────────────────────────────────

    /// @notice Ownership transfer is two-step, so a typo cannot orphan the vault.
    function test_ownershipTransferIsTwoStep() public {
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner, "ownership does not move until accepted");
        assertEq(vault.pendingOwner(), bob);

        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob, "ownership moves only on acceptance");
    }

    function test_onlyOwnerControlsGuardrailsAndPause() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.pause();

        vm.prank(alice);
        vm.expectRevert();
        vault.setGuardrails(9_000, 0, 2_000, 86_400, 100);

        vm.prank(alice);
        vm.expectRevert();
        vault.addVenue(IVenue(address(venue)), 5_000, true);
    }

    // ── Metadata ──────────────────────────────────────────────────

    function test_metadataIsSaneForIntegrators() public view {
        assertEq(vault.asset(), address(fxrp));
        assertEq(vault.decimals(), fxrp.decimals() + 3, "shares carry the virtual-offset decimals");
        assertEq(vault.symbol(), "tFXRP");
        assertEq(vault.name(), "Tacit FXRP");
    }
}
