// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IVenue} from "../interfaces/IVenue.sol";

/// @title LendingVenue
/// @notice A yield venue that accrues interest at a fixed per-second rate.
///
/// @dev **This is a testnet stand-in, not a production integration.** Coston2 does not host the
///      live FXRP money markets (Kinetic, SparkDEX, Enosys, Firelight) that this vault targets on
///      mainnet, so the demo needs venues that actually pay yield in order to show allocation
///      mattering. The `IVenue` surface is what a real adapter implements; swapping this for a
///      Kinetic adapter changes no vault code.
///
///      Yield is pre-funded by the deployer into `reserve`. If the reserve runs dry, accrual
///      silently stops rather than reverting, so a depleted venue degrades instead of bricking
///      the vault's rebalance path.
contract LendingVenue is IVenue, Ownable {
    using SafeERC20 for IERC20;

    IERC20 private immutable _asset;
    address public immutable vault;

    /// @notice Annualised rate in basis points, applied linearly per second.
    uint256 public ratePerYearBps;

    uint256 public principal;
    uint256 public accrued;
    uint256 public lastAccrualAt;

    /// @notice Liquidity fraction available for immediate withdrawal, in bps. Models venues that
    ///         cannot return the full balance on demand.
    uint16 public liquidityBps = 10_000;

    error OnlyVault();
    error WrongAsset();

    event Accrued(uint256 amount, uint256 totalAccrued);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(IERC20 asset_, address vault_, uint256 ratePerYearBps_, address owner_) Ownable(owner_) {
        _asset = asset_;
        vault = vault_;
        ratePerYearBps = ratePerYearBps_;
        lastAccrualAt = block.timestamp;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    /// @notice Principal plus interest earned to date, capped by what the venue actually holds.
    /// @dev Capping at the real balance is deliberate: a venue must never report assets it cannot
    ///      produce, or the vault's conservation check would pass on paper while funds were gone.
    function totalAssets() public view returns (uint256) {
        uint256 claim = principal + accrued + _pendingAccrual();
        uint256 held = _asset.balanceOf(address(this));
        return Math.min(claim, held);
    }

    function maxWithdraw() external view returns (uint256) {
        return (totalAssets() * liquidityBps) / 10_000;
    }

    function deposit(uint256 amount) external onlyVault {
        _accrue();
        principal += amount;
        _asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256 withdrawn) {
        _accrue();

        uint256 available = (totalAssets() * liquidityBps) / 10_000;
        withdrawn = Math.min(amount, available);
        if (withdrawn == 0) return 0;

        // Interest is consumed before principal so that `principal` stays a truthful high-water
        // mark of deposited capital rather than drifting with withdrawals.
        uint256 fromAccrued = Math.min(withdrawn, accrued);
        accrued -= fromAccrued;
        principal -= (withdrawn - fromAccrued);

        _asset.safeTransfer(msg.sender, withdrawn);
    }

    function _pendingAccrual() internal view returns (uint256) {
        if (block.timestamp <= lastAccrualAt || principal == 0) return 0;
        uint256 elapsed = block.timestamp - lastAccrualAt;
        return (principal * ratePerYearBps * elapsed) / (10_000 * 365 days);
    }

    function _accrue() internal {
        uint256 pending = _pendingAccrual();
        lastAccrualAt = block.timestamp;
        if (pending == 0) return;

        // Only recognise interest the venue can actually pay out.
        uint256 held = _asset.balanceOf(address(this));
        uint256 claimed = principal + accrued;
        uint256 headroom = held > claimed ? held - claimed : 0;
        uint256 recognised = Math.min(pending, headroom);
        if (recognised == 0) return;

        accrued += recognised;
        emit Accrued(recognised, accrued);
    }

    // --- admin (testnet operations) ---

    /// @notice Pre-fund the yield reserve. Tokens sent here become claimable interest over time.
    function fundReserve(uint256 amount) external {
        _asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    function setRate(uint256 ratePerYearBps_) external onlyOwner {
        _accrue();
        ratePerYearBps = ratePerYearBps_;
    }

    /// @notice Simulate an illiquid venue, to exercise the vault's partial-withdrawal path.
    function setLiquidityBps(uint16 liquidityBps_) external onlyOwner {
        require(liquidityBps_ <= 10_000, "bad bps");
        liquidityBps = liquidityBps_;
    }
}
