// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {OFTAdapter} from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";

/// @title FxrpOFTAdapter
/// @notice The FXRP transport layer for the OVault: locks FXRP on Coston2 so a peer OFT can mint a
///         representation of it on a spoke chain, and unlocks it when that representation comes home.
///
/// @dev ## Why this exists at all
///
/// `TacitOVaultComposer`'s constructor requires an asset OFT whose `token()` equals `vault.asset()`.
/// FXRP had no OFT on Coston2, so a cross-chain deposit had no transport and could not complete —
/// this is the blocking prerequisite named in `docs/OVAULT.md` §2, now met.
///
/// Nothing here is Tacit-specific. This is generic FXRP transport: it holds no position, knows
/// nothing about the vault, and would work identically for anyone else bridging FXRP. That is
/// deliberate, and it is also a constraint — `OFTAdapter` carries an upstream warning that **only
/// one** should exist for a given mesh, because each one is a separate escrow with its own peer set.
/// If FXRP later gets a canonical OFT adapter, this is the piece to replace, and the composer takes
/// the new address without any other change.
///
/// ## Decimals
///
/// FXRP has 6 decimals and LayerZero's `sharedDecimals()` is also 6, so `decimalConversionRate` is 1
/// and nothing truncates. The dust step documented for the *share* adapter — where a 9-decimal token
/// meets 6 shared decimals — has no analogue on this side.
///
/// ## The one deviation from a stock adapter
///
/// `_credit` is overridden, for the same reason it is in `TacitShareOFTAdapter`: the stock
/// `OFTAdapter` unlocks with a bare `safeTransfer`, and a spoke-side sender picks the recipient. Pick
/// one the transfer cannot succeed to — `address(0)` being the trivial case, since OpenZeppelin's
/// ERC-20 reverts on it — and the revert happens inside `lzReceive`, so the message can never be
/// delivered and the FXRP behind it stays locked here forever.
///
/// Note that the mint-burn `OFT` on the spoke side of this same mesh already handles this upstream:
/// its `_credit` rewrites `address(0)` to `address(0xdead)`. So the choice is not *whether* to handle
/// undeliverable credits, only where the value lands. Upstream burns it; this reroutes it to a
/// recovery address, because burning someone's bridged FXRP to work around a typo is a worse outcome
/// than a support ticket.
contract FxrpOFTAdapter is OFTAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when an inbound delivery could not reach its recipient and was rerouted.
    /// @dev Watch this event. Each one is someone's FXRP sitting somewhere they did not ask for, and
    ///      the only record of who it belongs to is `to` plus the source-chain transaction.
    event StrandedAssetsRecovered(address indexed to, uint256 amountLD, uint32 srcEid);

    event StrandedFundsRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Where FXRP goes when its intended recipient cannot receive it.
    /// @dev Should be a multisig, not an EOA — it is a custodian of other people's assets.
    address public strandedFundsRecipient;

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _fxrp FXRP on Coston2. Resolve it from the Flare contract registry rather than
    ///        hardcoding — `script/ovault/DeployAssetOFTAdapter.s.sol` does.
    /// @param _lzEndpoint LayerZero EndpointV2 on this chain.
    /// @param _delegate Owner, and the address allowed to configure this OApp at the endpoint.
    /// @param _strandedFundsRecipient Recovery address for undeliverable inbound FXRP.
    constructor(address _fxrp, address _lzEndpoint, address _delegate, address _strandedFundsRecipient)
        OFTAdapter(_fxrp, _lzEndpoint, _delegate)
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

    /// @dev `OFTAdapter` and `Ownable2Step` both derive from `Ownable`, so two-step behaviour has to
    ///      be selected explicitly rather than inherited. Same reasoning as `TacitShareOFTAdapter`:
    ///      this owner is also the LayerZero delegate, so a one-step transfer to a mistyped address
    ///      would hand away control of the escrow's peer set with no way back.
    ///
    ///      And as there: completing a handover does **not** move the delegate. Call `setDelegate`
    ///      explicitly afterwards.
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
    ///      always consumed — a message that can never be delivered is FXRP that can never move again.
    function _credit(address _to, uint256 _amountLD, uint32 _srcEid) internal override returns (uint256) {
        if (!_tryTransfer(_to, _amountLD)) {
            IERC20(innerToken).safeTransfer(strandedFundsRecipient, _amountLD);
            emit StrandedAssetsRecovered(_to, _amountLD, _srcEid);
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
