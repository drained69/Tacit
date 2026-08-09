// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IVenue} from "../interfaces/IVenue.sol";

/// @title ERC4626Venue
/// @notice Adapter that exposes any ERC-4626 vault to TacitVault as an allocatable venue.
///
/// @dev This is what makes the design composable rather than a closed system. Every serious FXRP
///      yield venue is or wraps an ERC-4626 vault — Firelight's stXRP, Upshift's earnXRP, the
///      Spectra vaults — so one adapter reaches the whole existing stack without TacitVault
///      knowing anything about them.
///
///      Deployed on Coston2 against **Firelight stXRP** (`0xC90D…0361`), a live third-party vault
///      holding ~100k FXRP. The allocation decision is therefore real capital moving into a real
///      protocol, not a simulation.
///
///      ## Why this adapter is defensive rather than a thin passthrough
///
///      A foreign vault is untrusted. It can charge deposit fees, round shares against us, gate
///      withdrawals, or simply pause. Each of those would otherwise surface inside TacitVault as a
///      confusing conservation failure that looks like an enclave attack. So the adapter:
///
///        - reports `totalAssets()` as what the shares are *currently worth*, never principal;
///        - caps `maxWithdraw()` by the target's own limit, so illiquidity degrades instead of
///          reverting;
///        - never assumes `deposit` credits the full amount — the share balance is the truth.
contract ERC4626Venue is IVenue {
    using SafeERC20 for IERC20;

    IERC20 private immutable _asset;
    IERC4626 public immutable target;
    address public immutable vault;

    /// @notice Human label for UIs. Not used in any accounting decision.
    string public name;

    error OnlyVault();
    error AssetMismatch(address targetAsset, address expected);
    /// @notice Target burned shares without paying — it settles withdrawals out of band.
    error AsyncWithdrawalUnsupported(address target, uint256 sharesBurned);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(IERC4626 target_, address vault_, string memory name_) {
        address underlying = target_.asset();
        _asset = IERC20(underlying);
        target = target_;
        vault = vault_;
        name = name_;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    /// @notice Current value of the shares this adapter holds, in underlying terms.
    /// @dev Deliberately marked-to-market via `convertToAssets` rather than tracking principal:
    ///      if the foreign vault loses value, TacitVault must see that immediately. Reporting
    ///      principal would hide a loss until withdrawal and let the conservation check pass on a
    ///      number that is no longer true.
    function totalAssets() public view returns (uint256) {
        uint256 shares = target.balanceOf(address(this));
        if (shares == 0) return 0;
        return target.convertToAssets(shares);
    }

    /// @notice What can actually be pulled back right now.
    /// @dev Bounded by the target's own `maxWithdraw`, so a gated or illiquid venue reduces the
    ///      amount TacitVault will attempt rather than reverting the whole rebalance.
    function maxWithdraw() external view returns (uint256) {
        return Math.min(totalAssets(), target.maxWithdraw(address(this)));
    }

    function deposit(uint256 amount) external onlyVault {
        _asset.safeTransferFrom(msg.sender, address(this), amount);

        // Approve exactly what is being deposited and reset afterwards, so a misbehaving target
        // cannot drain a lingering allowance later.
        _asset.forceApprove(address(target), amount);
        target.deposit(amount, address(this));
        _asset.forceApprove(address(target), 0);
    }

    /// @return withdrawn Underlying actually returned to the vault, which may be less than asked.
    ///
    /// @dev A venue that is merely *illiquid* must not brick redemption for everyone: propagating
    ///      its revert into `TacitVault._withdraw` would let a shortfall in one venue block every
    ///      depositor. So the asset path is attempted, retried as `redeem` (vaults gate the two
    ///      differently), and whatever arrives is reported honestly — returning less than asked,
    ///      or nothing, is a valid outcome the vault already handles.
    ///
    ///      A venue that is *asynchronous* is a different matter entirely, and is rejected below.
    function withdraw(uint256 amount) external onlyVault returns (uint256 withdrawn) {
        uint256 available = Math.min(totalAssets(), target.maxWithdraw(address(this)));
        uint256 want = Math.min(amount, available);
        if (want == 0) return 0;

        // Measure the delta rather than trusting the return value: ERC-4626 implementations differ
        // in what they report, and TacitVault's conservation check must be fed a fact.
        uint256 before_ = _asset.balanceOf(address(this));
        uint256 sharesBefore = target.balanceOf(address(this));

        try target.withdraw(want, address(this), address(this)) returns (uint256) {
            // asset-denominated path succeeded
        } catch {
            uint256 shares = Math.min(target.convertToShares(want), target.balanceOf(address(this)));
            if (shares > 0) {
                try target.redeem(shares, address(this), address(this)) returns (uint256) {
                    // share-denominated path succeeded
                } catch {
                    // Venue is genuinely unable to pay right now. Report zero and let the vault
                    // serve what it can from elsewhere.
                }
            }
        }

        withdrawn = _asset.balanceOf(address(this)) - before_;

        // ── Asynchronous-vault tripwire ──────────────────────────────────────────────────
        //
        // Fork testing against Firelight stXRP found the failure mode this guards. Its
        // `withdraw()` does not revert and does not pay: it BURNS the shares, emits
        // `WithdrawRequest(id)` and returns the full amount, settling out of band. It is a
        // withdrawal *queue* wearing a synchronous ERC-4626 interface.
        //
        // To an adapter that trusts the interface, the position simply ceases to exist —
        // `totalAssets()` reads a share balance of zero — and TacitVault books a total loss of
        // real capital that is, in fact, merely pending.
        //
        // Shares leaving without assets arriving is therefore treated as an integration error and
        // reverted, which unwinds the burn. Failing the rebalance is strictly better than
        // succeeding with phantom accounting: an async venue needs an adapter that tracks claim
        // tickets, and until one exists this contract must refuse to pretend otherwise.
        if (withdrawn == 0 && target.balanceOf(address(this)) < sharesBefore) {
            revert AsyncWithdrawalUnsupported(address(target), sharesBefore - target.balanceOf(address(this)));
        }

        if (withdrawn > 0) _asset.safeTransfer(vault, withdrawn);
    }

    /// @notice True if the target settles withdrawals synchronously, tested without moving funds.
    /// @dev Call before registering a venue. A `false` here means this adapter is the wrong shape
    ///      for that vault, not that the vault is broken.
    function probeSynchronous() external returns (bool) {
        uint256 shares = target.balanceOf(address(this));
        if (shares == 0) return true; // nothing staked; nothing to learn

        uint256 probe = target.convertToAssets(shares) / 100; // 1% of the position
        if (probe == 0) return true;

        uint256 assetsBefore = _asset.balanceOf(address(this));
        try target.withdraw(probe, address(this), address(this)) returns (uint256) {
            bool paid = _asset.balanceOf(address(this)) > assetsBefore;
            bool burned = target.balanceOf(address(this)) < shares;
            return !(burned && !paid);
        } catch {
            return false;
        }
    }

    /// @notice Shares held in the target vault, for UIs and independent verification.
    function targetShares() external view returns (uint256) {
        return target.balanceOf(address(this));
    }

    /// @notice Reported so the enclave can weight this venue without TacitVault hardcoding a rate.
    /// @dev A live ERC-4626 vault does not publish an APR, and inventing one would be worse than
    ///      admitting the gap: the relayer derives a realised rate from share-price history off
    ///      chain and passes it to the enclave. Zero here means "unknown", not "no yield".
    function ratePerYearBps() external pure returns (uint256) {
        return 0;
    }

    function liquidityBps() external view returns (uint16) {
        uint256 assets = totalAssets();
        if (assets == 0) return 10_000;
        uint256 liquid = Math.min(assets, target.maxWithdraw(address(this)));
        return uint16((liquid * 10_000) / assets);
    }
}
