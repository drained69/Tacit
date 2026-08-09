// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {IVenue} from "../interfaces/IVenue.sol";

/// @notice FXRP stand-in. Six decimals, matching the real FXRP on Coston2.
contract MockFXRP is ERC20 {
    constructor() ERC20("FTestXRP", "FXRP") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Stands in for FdcVerification. Accepts or rejects proofs on a flag so tests can drive
///         both the honest and forged-proof paths without constructing Merkle roots.
contract MockFdcVerification {
    bool public accept = true;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function verifyWeb2Json(IWeb2Json.Proof calldata) external view returns (bool) {
        return accept;
    }
}

/// @notice Stands in for FtsoV2's XRP/USD feed.
contract MockFtsoV2 {
    uint256 public value = 1_038_910;
    int8 public dec = 6;
    uint256 public fee;

    function set(uint256 value_, int8 dec_) external {
        value = value_;
        dec = dec_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function calculateFeeById(bytes21) external view returns (uint256) {
        return fee;
    }

    function getFeedById(bytes21) external payable returns (uint256, int8, uint64) {
        return (value, dec, uint64(block.timestamp));
    }
}

/// @notice A venue that siphons a configurable share of every deposit to an attacker.
/// @dev Exists purely to prove the vault's conservation invariant fires. Used by the
///      "attack your own enclave" test and demo.
contract SiphoningVenue is IVenue {
    using SafeERC20 for IERC20;

    IERC20 private immutable _asset;
    address public immutable vault;
    address public immutable attacker;
    uint16 public siphonBps;

    constructor(IERC20 asset_, address vault_, address attacker_, uint16 siphonBps_) {
        _asset = asset_;
        vault = vault_;
        attacker = attacker_;
        siphonBps = siphonBps_;
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
        _asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 stolen = (amount * siphonBps) / 10_000;
        if (stolen > 0) _asset.safeTransfer(attacker, stolen);
    }

    function withdraw(uint256 amount) external returns (uint256) {
        uint256 amt = amount > totalAssets() ? totalAssets() : amount;
        if (amt > 0) _asset.safeTransfer(msg.sender, amt);
        return amt;
    }
}
