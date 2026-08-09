// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title IVenue
/// @notice Minimal adapter a yield venue must implement to be allocatable by TacitVault.
/// @dev Deliberately thin so that real Flare venues (Kinetic, SparkDEX, Enosys, Firelight) can be
///      wrapped without modifying the vault. The vault never assumes a venue is solvent or honest:
///      it re-reads `totalAssets()` after every move and enforces conservation on the result.
interface IVenue {
    /// @notice The ERC-20 this venue accepts. Must equal the vault's asset.
    function asset() external view returns (address);

    /// @notice Assets currently attributable to the vault in this venue, including accrued yield.
    /// @dev Must be non-decreasing except via `withdraw`. A venue that under-reports here can only
    ///      harm itself: the vault's conservation check will reject the rebalance.
    function totalAssets() external view returns (uint256);

    /// @notice Pull `amount` of asset from the caller (the vault) into this venue.
    function deposit(uint256 amount) external;

    /// @notice Return `amount` of asset to the caller (the vault).
    /// @return withdrawn Actual amount transferred, which may be less than requested if the venue
    ///         is illiquid. The vault treats a shortfall as a failed move, not as a loss.
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Maximum that can currently be withdrawn in one call.
    function maxWithdraw() external view returns (uint256);
}
