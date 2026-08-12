// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOFT, SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";

import {OVaultBase} from "./OVaultBase.sol";

/// @notice Bridges FXRP from the hub to a spoke — the step that gives a spoke-side depositor something
///         to deposit.
///
/// @dev Nothing mints FXRP on Base Sepolia. `SpokeFxrpOFT` supply only exists as the mirror of FXRP
///      escrowed in `FxrpOFTAdapter` on Coston2, so the spoke starts empty and has to be seeded from
///      the hub once. After that, a spoke depositor is self-sufficient.
///
///      This is a plain msgType 1 send: no compose, no vault interaction. If this leg does not work,
///      nothing about the deposit path is worth debugging yet.
///
///      Usage:
///        AMOUNT=5000000 forge script script/ovault/BridgeAssetToSpoke.s.sol:BridgeAssetToSpoke \
///          --rpc-url coston2 --broadcast
contract BridgeAssetToSpoke is OVaultBase {
    function run() external {
        address assetOFT = vm.envAddress("ASSET_OFT");
        uint32 spokeEid = _spokeEid();
        address sender = _deployer();
        address recipient = vm.envOr("RECIPIENT", sender);

        // FXRP is 6 decimals. 5000000 == 5 FXRP.
        uint256 amount = vm.envOr("AMOUNT", uint256(5_000_000));

        address fxrp = _resolveFXRP();

        _logHeader("Bridging FXRP hub -> spoke");
        console2.log("FXRP            :", fxrp);
        console2.log("Adapter         :", assetOFT);
        console2.log("Amount (6dp)    :", amount);
        console2.log("Recipient       :", recipient);
        console2.log("Spoke EID       :", spokeEid);

        uint256 balance = IERC20(fxrp).balanceOf(sender);
        console2.log("Sender balance  :", balance);
        require(balance >= amount, "insufficient FXRP");

        SendParam memory sendParam = SendParam({
            dstEid: spokeEid,
            to: _asPeer(recipient),
            amountLD: amount,
            // FXRP's 6 decimals equal LayerZero's shared decimals, so the conversion rate is 1 and
            // nothing is truncated on this leg. The exact amount is a safe floor.
            minAmountLD: amount,
            // Empty: the enforced options set by `WireHub` supply the executor gas.
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        MessagingFee memory fee = IOFT(assetOFT).quoteSend(sendParam, false);
        console2.log("Native fee (wei):", fee.nativeFee);
        require(sender.balance >= fee.nativeFee, "insufficient native for LZ fee");

        vm.startBroadcast(_deployerKey());
        // A lockbox adapter pulls the underlying, so it needs an allowance. The mint-burn spoke OFT
        // will not — which is why a depositor arriving from the spoke needs no approval transaction.
        IERC20(fxrp).approve(assetOFT, amount);
        IOFT(assetOFT).send{value: fee.nativeFee}(sendParam, fee, sender);
        vm.stopBroadcast();

        console2.log("");
        console2.log("Sent. Track delivery at https://testnet.layerzeroscan.com");
    }
}
