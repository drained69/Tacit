// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {VaultComposerSync} from "@layerzerolabs/ovault-evm/contracts/VaultComposerSync.sol";
import {IOFT, SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {OFTComposeMsgCodec} from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";

/// @title TacitOVaultComposer
/// @notice Lets a holder of FXRP on another chain deposit into `TacitVault` — and a holder of
///         `tFXRP` on another chain redeem out of it — in one transaction, without ever holding
///         Coston2 gas.
///
/// @dev ## What this contract is, and what it deliberately is not
///
/// It is a LayerZero *composer*: the endpoint delivers FXRP here along with a compose message, and
/// this contract turns that into `vault.deposit()` plus an outbound share send. It holds no
/// position, quotes no price, and has no view on strategy. It is plumbing between two things that
/// already exist — the live Coston2 FXRP OFT adapter and the vault.
///
/// It does **not** widen the enclave's authority by one basis point. Every deposit still enters
/// through `TacitVault.deposit`, every redemption still exits through `TacitVault.redeem`, and both
/// are still subject to the five on-chain guardrails documented in `TacitVault`. A cross-chain
/// depositor is an ordinary depositor who happened to arrive by bridge. The trust boundary —
/// *the enclave controls strategy quality, never fund safety* — is unchanged, because this contract
/// sits entirely on the depositor's side of it.
///
/// ## Where the risk actually is
///
/// The base `VaultComposerSync` is written for the happy path. The failure modes worth naming are
/// all the same shape: **value arrives, the intended action cannot complete, and the value has
/// nowhere to go.** Three of them are fixed by the four overrides below. They matter more here than in a
/// generic vault, because `TacitVault` has a state that *intentionally* rejects deposits:
///
///   - `deposit` and `mint` are `whenNotPaused`, and `maxDeposit` returns 0 while paused.
///   - `withdraw` and `redeem` are never paused — exits stay open by design.
///
/// So "compose arrives while deposits are paused" is not an exotic edge case, it is a state an
/// operator can and should enter. When it happens: `handleCompose` reverts, `lzCompose` catches,
/// and `_refund` sends the FXRP home. The override of `_refund` below is what happens when that
/// refund *also* fails — which is the only remaining way for a depositor's FXRP to end up stuck.
///
/// Fixes carried here, each traceable to a base-contract behaviour rather than a hypothetical:
///
///   1. `_depositAndSend` / `_redeemAndSend` — the base zeroes `minAmountLD` before the outbound
///      send, so the slippage bound the user paid for is enforced against the vault and then
///      discarded before the bridge leg. Both overrides preserve it.
///   2. `_sendLocal` — the base ignores `msg.value` on a same-chain delivery, and its own comment
///      concedes the native "accumulates in the contract and is locked". The override refunds it.
///   3. `_refund` — the base refund is a bare remote send with no fallback. If it reverts, the
///      tokens stay here forever. The override catches and escrows to a recovery address.
contract TacitOVaultComposer is VaultComposerSync, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error NativeRefundFailed();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a refund could not be delivered and was escrowed instead.
    /// @dev Watch this event. Each one is a depositor whose funds are safe but not where they asked
    ///      for them, recoverable only by a human reading `refundAddress` off the source chain.
    event StrandedFundsRecovered(address indexed oft, uint256 amount, uint256 msgValue, address refundAddress);

    event StrandedFundsRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    event NativeRescued(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Where tokens go when neither the intended destination nor the refund can accept them.
    /// @dev Should be a multisig. It is a custodian of other people's funds, not a treasury.
    address public strandedFundsRecipient;

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _vault `TacitVault`. Must be synchronous at the ERC-4626 surface — it is: `redeem`
    ///        unwinds venues pro-rata inline, and the async Firelight venue is excluded from
    ///        redeemable liquidity rather than settled in two steps.
    /// @param _assetOFT The FXRP OFT adapter. `VaultComposerSync` checks `token() == vault.asset()`.
    /// @param _shareOFT `TacitShareOFTAdapter`. `VaultComposerSync` checks `token() == vault` and
    ///        that it is a lockbox, not mint-burn.
    /// @param _strandedFundsRecipient Recovery address for undeliverable refunds.
    constructor(address _vault, address _assetOFT, address _shareOFT, address _strandedFundsRecipient)
        VaultComposerSync(_vault, _assetOFT, _shareOFT)
        Ownable(msg.sender)
    {
        if (_strandedFundsRecipient == address(0)) revert ZeroAddress();
        strandedFundsRecipient = _strandedFundsRecipient;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setStrandedFundsRecipient(address _strandedFundsRecipient) external onlyOwner {
        if (_strandedFundsRecipient == address(0)) revert ZeroAddress();
        emit StrandedFundsRecipientUpdated(strandedFundsRecipient, _strandedFundsRecipient);
        strandedFundsRecipient = _strandedFundsRecipient;
    }

    /// @notice Sweep native left behind by a failed refund.
    /// @dev This contract is never meant to hold native at rest: composes forward it, local sends
    ///      refund it, and failed refunds escrow it. The one gap is a recovery address that cannot
    ///      accept native — which leaves a balance here with no other way out. Native only; this
    ///      function cannot touch FXRP or shares.
    function rescueNative(address _to) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool sent,) = _to.call{value: amount}("");
        if (!sent) revert NativeRefundFailed();
        emit NativeRescued(_to, amount);
    }

    // ---------------------------------------------------------------------
    // Overrides — slippage
    // ---------------------------------------------------------------------

    /// @inheritdoc VaultComposerSync
    /// @dev Identical to the base except that `minAmountLD` survives into the send. The base
    ///      asserts slippage against the vault output and then sets `minAmountLD = 0`, so the OFT
    ///      leg is unbounded: decimal truncation, or a fee-taking OFT on the far side, can deliver
    ///      less than the user asked for — or nothing, leaving a dust residue trapped here — and
    ///      the send still succeeds. Keeping the bound means the message reverts instead, and
    ///      `lzCompose` refunds.
    function _depositAndSend(
        bytes32 _depositor,
        uint256 _assetAmount,
        SendParam memory _sendParam,
        address _refundAddress,
        uint256 _msgValue
    ) internal virtual override {
        uint256 preShareBalance = IERC20(SHARE_ERC20).balanceOf(address(this));
        _deposit(_depositor, _assetAmount);
        uint256 postShareBalance = IERC20(SHARE_ERC20).balanceOf(address(this));

        uint256 shareAmountReceived = postShareBalance - preShareBalance;

        uint256 minAmountLD = _sendParam.minAmountLD;
        _assertSlippage(shareAmountReceived, minAmountLD);

        _sendParam.amountLD = shareAmountReceived;
        _sendParam.minAmountLD = minAmountLD;

        _send(SHARE_OFT, _sendParam, _refundAddress, _msgValue);
        emit Deposited(_depositor, _sendParam.to, _sendParam.dstEid, _assetAmount, shareAmountReceived);
    }

    /// @inheritdoc VaultComposerSync
    /// @dev Mirror of `_depositAndSend` on the exit leg. Preserving the bound matters more here:
    ///      `TacitVault.redeem` can pay out less than the preview when a venue is illiquid — it
    ///      degrades rather than reverts, on purpose — and the withdrawing user's `minAmountLD` is
    ///      the only thing that turns that shortfall into a refund instead of a silent haircut.
    function _redeemAndSend(
        bytes32 _redeemer,
        uint256 _shareAmount,
        SendParam memory _sendParam,
        address _refundAddress,
        uint256 _msgValue
    ) internal virtual override {
        uint256 preAssetBalance = IERC20(ASSET_ERC20).balanceOf(address(this));
        _redeem(_redeemer, _shareAmount);
        uint256 postAssetBalance = IERC20(ASSET_ERC20).balanceOf(address(this));

        uint256 assetAmountReceived = postAssetBalance - preAssetBalance;

        uint256 minAmountLD = _sendParam.minAmountLD;
        _assertSlippage(assetAmountReceived, minAmountLD);

        _sendParam.amountLD = assetAmountReceived;
        _sendParam.minAmountLD = minAmountLD;

        _send(ASSET_OFT, _sendParam, _refundAddress, _msgValue);
        emit Redeemed(_redeemer, _sendParam.to, _sendParam.dstEid, _shareAmount, assetAmountReceived);
    }

    // ---------------------------------------------------------------------
    // Overrides — stranded value
    // ---------------------------------------------------------------------

    /// @inheritdoc VaultComposerSync
    /// @dev A same-chain destination needs no LayerZero fee, but the executor still forwards
    ///      whatever `msg.value` the compose carried. The base drops it here. This returns it,
    ///      falling back to the caller if the refund address rejects native.
    function _sendLocal(
        address _oft,
        SendParam memory _sendParam,
        address _refundAddress,
        uint256 _msgValue
    ) internal virtual override {
        super._sendLocal(_oft, _sendParam, _refundAddress, _msgValue);

        if (_msgValue > 0) {
            (bool sent,) = _refundAddress.call{value: _msgValue}("");
            if (!sent) {
                (bool sentToCaller,) = msg.sender.call{value: _msgValue}("");
                if (!sentToCaller) revert NativeRefundFailed();
            }
        }
    }

    /// @inheritdoc VaultComposerSync
    /// @dev The last line of defence. `lzCompose` already caught the failed action; if this refund
    ///      reverts too, the base leaves the tokens here permanently. The remote send is therefore
    ///      attempted in a `try`, and on failure the tokens are escrowed to a recovery address and
    ///      an event names the intended recipient.
    ///
    ///      Escrow is not a good outcome — it replaces a trustless refund with a human one. It is
    ///      better than the alternative, which is funds that provably cannot move again.
    function _refund(
        address _oft,
        bytes calldata _message,
        uint256 _amount,
        address _refundAddress,
        uint256 _msgValue
    ) internal virtual override {
        SendParam memory refundSendParam;
        refundSendParam.dstEid = OFTComposeMsgCodec.srcEid(_message);
        refundSendParam.to = OFTComposeMsgCodec.composeFrom(_message);
        refundSendParam.amountLD = _amount;

        try IOFT(_oft).send{value: _msgValue}(refundSendParam, MessagingFee(_msgValue, 0), _refundAddress) {
            // Refunded across the bridge, as intended.
        } catch {
            address token = _oft == ASSET_OFT ? ASSET_ERC20 : SHARE_ERC20;
            IERC20(token).safeTransfer(strandedFundsRecipient, _amount);

            if (_msgValue > 0) {
                // Keep the unspent fee with the tokens so a manual re-dispatch has both. If the
                // recipient cannot take native, it stays here for `rescueNative`.
                (bool sent,) = strandedFundsRecipient.call{value: _msgValue}("");
                sent; // Intentionally unchecked — the event records the amount either way.
            }

            emit StrandedFundsRecovered(_oft, _amount, _msgValue, _refundAddress);
        }
    }
}
