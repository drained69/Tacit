// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";

/// @title SpokeTacitShareOFT
/// @notice `tFXRP` as it appears on a spoke chain: a mint-burn OFT whose supply is backed 1:1 by
///         real vault shares escrowed in `TacitShareOFTAdapter` on Coston2.
///
/// @dev ## This does not change the exchange rate, and that is the whole point
///
/// `docs/OVAULT.md` §1 forbids mint-burn on the *hub* side, because `TacitVault.totalSupply()` is one
/// half of the exchange rate every depositor is priced against — burning real shares on Coston2 to
/// recreate them elsewhere would silently reprice everyone who never left the hub.
///
/// Minting here does not do that. The real shares stay escrowed in the hub adapter, counted in
/// `totalSupply()` the entire time. This contract's supply is a claim on that escrow, denominated to
/// match; the vault cannot see it and is not priced against it. The pair of decisions is one
/// decision: escrow on the hub, represent on the spoke.
///
/// ## Decimals must be hardcoded
///
/// `OFT`'s constructor evaluates `decimals()` while building `OFTCore`, before any derived
/// constructor body runs, so this cannot read from an immutable — it would see 0 and revert
/// `InvalidLocalDecimals`. See `SpokeFxrpOFT` for the full note.
///
/// 9 matches `tFXRP`: FXRP's 6 decimals plus `TacitVault`'s 3-decimal virtual-share offset. It must
/// match, or every bridged share amount would be misdenominated by a factor of 1000 — and silently,
/// since both sides would still balance against themselves.
///
/// ## The dust step lands on this pathway
///
/// 9 local decimals against LayerZero's 6 shared decimals gives `decimalConversionRate = 1000`, so a
/// share send truncates its low three digits — at most 999 share units, one wei of FXRP at the
/// vault's initial rate. Truncation happens before the escrow pull on the hub, so the dust stays with
/// the sender rather than accumulating here unaccounted. `docs/OVAULT.md` §8 has the consequences,
/// including the `SlippageExceeded` case that looks like a bug and is not.
contract SpokeTacitShareOFT is OFT, Ownable2Step {
    /// @param _lzEndpoint LayerZero EndpointV2 on the spoke chain.
    /// @param _delegate Owner, and the address allowed to configure this OApp at the endpoint.
    constructor(address _lzEndpoint, address _delegate)
        OFT("Tacit FXRP Vault Share", "tFXRP", _lzEndpoint, _delegate)
        Ownable(_delegate)
    {}

    /// @notice Decimals of this token, and of `tFXRP` on the hub.
    /// @dev Must be a literal — see the note above. 9 = FXRP's 6 + the vault's 3-decimal offset.
    function decimals() public pure override returns (uint8) {
        return 9;
    }

    /// @dev Two-step ownership selected explicitly; `OFT` and `Ownable2Step` share an `Ownable` base.
    ///      Completing a handover does **not** move the LayerZero delegate — call `setDelegate` after.
    function transferOwnership(address newOwner) public virtual override(Ownable, Ownable2Step) onlyOwner {
        super.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override(Ownable, Ownable2Step) {
        super._transferOwnership(newOwner);
    }
}
