// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";

/// @title SpokeFxrpOFT
/// @notice FXRP as it appears on a spoke chain: a mint-burn OFT whose supply is backed 1:1 by FXRP
///         escrowed in `FxrpOFTAdapter` on Coston2.
///
/// @dev ## Mint-burn here, lockbox there
///
/// Exactly one side of a pathway may hold the escrow. Coston2 holds the real FXRP, so this side
/// mints on inbound delivery and burns on outbound send. It has no underlying token to hold and no
/// reserve of its own: `totalSupply()` here is a claim on the hub adapter's balance, nothing more.
///
/// The inverse of the share-adapter argument in `docs/OVAULT.md` §1. There, mint-burn was forbidden
/// because `tFXRP.totalSupply()` prices the vault. Here it is required, because FXRP on a spoke is
/// only ever a representation — there is no local FXRP to lock.
///
/// ## Decimals must be hardcoded
///
/// `OFT`'s constructor passes `decimals()` to `OFTCore` *during base construction*:
///
/// ```solidity
/// constructor(...) ERC20(_name, _symbol) OFTCore(decimals(), _lzEndpoint, _delegate) {}
/// ```
///
/// A derived contract that stored decimals in an immutable and returned it here would return 0 at
/// that moment — the derived constructor body has not run — and `OFTCore` reverts
/// `InvalidLocalDecimals` because 0 is below `sharedDecimals()`. Hence a literal, and hence a
/// separate contract per token rather than one parameterised by decimals. The duplication is the
/// price of a base contract that calls a virtual function on itself before it is fully built.
///
/// 6 matches FXRP on Coston2 and equals LayerZero's `sharedDecimals()`, so `decimalConversionRate`
/// is 1 and no amount ever truncates on this leg.
contract SpokeFxrpOFT is OFT, Ownable2Step {
    /// @param _lzEndpoint LayerZero EndpointV2 on the spoke chain.
    /// @param _delegate Owner, and the address allowed to configure this OApp at the endpoint.
    constructor(address _lzEndpoint, address _delegate)
        OFT("Tacit Bridged FXRP", "FXRP", _lzEndpoint, _delegate)
        Ownable(_delegate)
    {}

    /// @notice Decimals of this token, and of FXRP on the hub.
    /// @dev Must be a literal — see the note above. Mirrors FXRP's 6 decimals on Coston2.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev `OFT` and `Ownable2Step` both derive from `Ownable`, so the two-step behaviour has to be
    ///      selected explicitly. The owner is also the LayerZero delegate: a one-step transfer to a
    ///      mistyped address would hand away this OFT's peer set irrecoverably.
    ///
    ///      Completing a handover does **not** move the delegate. Call `setDelegate` afterwards.
    function transferOwnership(address newOwner) public virtual override(Ownable, Ownable2Step) onlyOwner {
        super.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override(Ownable, Ownable2Step) {
        super._transferOwnership(newOwner);
    }
}
