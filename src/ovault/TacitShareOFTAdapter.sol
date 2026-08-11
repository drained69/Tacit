// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {OFTAdapter} from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";

/// @title TacitShareOFTAdapter
/// @notice A LayerZero OFT adapter that lets `tFXRP` vault shares move between chains, by locking
///         them here on Coston2 rather than minting or burning them.
///
/// @dev ## Why a lockbox, and not a mint-burn adapter
///
/// The share token is an ERC-4626 receipt: its `totalSupply()` is one half of the exchange rate
/// every depositor is priced against. A mint-burn adapter would move shares cross-chain by
/// destroying supply here and recreating it there — which silently rewrites the asset:share ratio
/// for everyone who never left the hub chain. So the shares are *escrowed* instead. Supply is
/// constant; only custody moves. `VaultComposerSync` enforces this on our behalf: its constructor
/// reverts `ShareOFTNotAdapter` unless `approvalRequired()` is true, which only the lockbox
/// implementation returns.
///
/// This contract is therefore hub-chain-only. There is exactly one of it, and the shares it holds
/// are the on-chain accounting of every share that currently lives on a spoke.
///
/// ## Decimals
///
/// FXRP has 6 decimals; `TacitVault` adds a 3-decimal virtual-share offset, so `tFXRP` has 9.
/// LayerZero's default `sharedDecimals()` is 6, so a cross-chain send truncates the low 3 digits —
/// at most 999 share units, which at the vault's initial rate is one wei of FXRP. The dust stays
/// with the sender rather than being lost. Documented rather than fixed: raising `sharedDecimals`
/// would exclude any future spoke chain that cannot represent 9 decimals, which is a worse trade.
///
/// ## Why `_credit` has a fallback
///
/// The default adapter unlocks with a bare `safeTransfer`. A spoke-side sender chooses the
/// recipient, and nothing on the spoke stops them choosing one this transfer cannot succeed to —
/// `address(0)` being the trivial case, since OpenZeppelin's ERC-20 reverts on it. That revert
/// happens inside `lzReceive`, so the message can never be delivered, and the shares behind it stay
/// locked in this contract with no path out. The fallback below routes those shares to a recovery
/// address instead, so a malformed destination costs a support ticket rather than the shares.
contract TacitShareOFTAdapter is OFTAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when an inbound delivery could not reach its recipient and was rerouted.
    /// @dev Watch this event. It means someone's shares arrived somewhere they did not ask for, and
    ///      the only record of who they belong to is `to` plus the source-chain transaction.
    event StrandedSharesRecovered(address indexed to, uint256 amountLD, uint32 srcEid);

    event StrandedFundsRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Where shares go when their intended recipient cannot receive them.
    /// @dev Should be a multisig, not an EOA — it is a custodian of other people's shares.
    address public strandedFundsRecipient;

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _shareToken The vault itself. `TacitVault` is its own share token.
    /// @param _lzEndpoint LayerZero EndpointV2 on this chain.
    /// @param _delegate Owner, and the address allowed to configure this OApp at the endpoint.
    /// @param _strandedFundsRecipient Recovery address for undeliverable inbound shares.
    constructor(address _shareToken, address _lzEndpoint, address _delegate, address _strandedFundsRecipient)
        OFTAdapter(_shareToken, _lzEndpoint, _delegate)
        Ownable(_delegate)
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

    // ---------------------------------------------------------------------
    // Ownership
    // ---------------------------------------------------------------------

    /// @dev `OFTAdapter` and `Ownable2Step` both derive from `Ownable`, so the two-step behaviour has
    ///      to be selected explicitly rather than inherited. `super` resolves to `Ownable2Step`, which
    ///      makes a handover a proposal plus an `acceptOwnership()` from the new owner. That matters
    ///      here because this owner is also the LayerZero delegate: it can rewrite this OApp's peers
    ///      and message libraries at the endpoint, so a one-step transfer to a mistyped address would
    ///      hand away control of the escrow's configuration with no way back. The `onlyOwner` below
    ///      repeats the base's check, and is kept so the access control is legible where it is
    ///      declared rather than only in the resolved base.
    function transferOwnership(address newOwner) public virtual override(Ownable, Ownable2Step) onlyOwner {
        super.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override(Ownable, Ownable2Step) {
        super._transferOwnership(newOwner);
    }

    // ---------------------------------------------------------------------
    // Delivery
    // ---------------------------------------------------------------------

    /// @inheritdoc OFTAdapter
    /// @dev Unlocks to `_to`, and if that cannot be done, unlocks to the recovery address instead.
    ///      Either way this returns `_amountLD` and does not revert, so the LayerZero message is
    ///      always consumed. That is the point: a message that can never be delivered is a message
    ///      whose shares can never be moved again.
    function _credit(address _to, uint256 _amountLD, uint32 _srcEid) internal override returns (uint256) {
        if (!_tryTransfer(_to, _amountLD)) {
            IERC20(innerToken).safeTransfer(strandedFundsRecipient, _amountLD);
            emit StrandedSharesRecovered(_to, _amountLD, _srcEid);
        }
        return _amountLD;
    }

    /// @dev `transfer` rather than `safeTransfer` so a revert is catchable, and a `false` return is
    ///      treated as failure too. Only ever called by `_credit`.
    function _tryTransfer(address _to, uint256 _amount) private returns (bool) {
        if (_to == address(0)) return false;
        try IERC20(innerToken).transfer(_to, _amount) returns (bool success) {
            return success;
        } catch {
            return false;
        }
    }
}
