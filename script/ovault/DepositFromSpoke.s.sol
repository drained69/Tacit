// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console2} from "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOFT, SendParam, MessagingFee} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";

import {OVaultBase} from "./OVaultBase.sol";

/// @notice The whole point of the OVault layer: deposit into `TacitVault` on Coston2 from Base Sepolia,
///         in one transaction, holding no Coston2 gas.
///
/// @dev ## One send, two effects
///
/// This is a single `send()` on the spoke FXRP OFT carrying a compose message. The spoke burns the
/// FXRP mirror, the hub adapter releases the real FXRP to the composer, and the composer runs
/// `vault.deposit()` and forwards the shares. The depositor signs once, on Base Sepolia, paying in
/// Base Sepolia ETH.
///
/// ## Why the shares land on Coston2 by default
///
/// `hopSendParam.dstEid` defaults to `HUB_EID`, which routes the composer's outbound hop through
/// `_sendLocal` — a plain `transfer` of the real vault shares, with no second LayerZero message, no
/// second fee, and no native drop on Coston2. That last part is not a stylistic preference: the
/// Coston2 executor advertises `nativeCap = 0` for the Base Sepolia pathway, so a hop that needs
/// native delivered on Coston2 is not fundable at any price. Terminating on the hub sidesteps it.
///
/// Set `SHARES_TO_SPOKE=true` for the variant that bridges the shares back to Base Sepolia. That leg
/// does require a native drop, funded from the outer send's `msg.value` — hence `minMsgValue`.
///
/// ## No approval transaction
///
/// `SpokeFxrpOFT` is mint-burn, so `approvalRequired()` is false and it burns the sender's balance
/// directly. A depositor arriving from the spoke signs exactly one transaction, not two.
///
///      Usage:
///        AMOUNT=2000000 forge script script/ovault/DepositFromSpoke.s.sol:DepositFromSpoke \
///          --rpc-url base_sepolia --broadcast
contract DepositFromSpoke is OVaultBase {
    function run() external {
        address spokeAssetOFT = vm.envAddress("SPOKE_ASSET_OFT");
        address composer = vm.envAddress("TACIT_OVAULT_COMPOSER");
        address sender = _deployer();
        address recipient = vm.envOr("RECIPIENT", sender);

        // FXRP is 6 decimals. 2000000 == 2 FXRP.
        uint256 amount = vm.envOr("AMOUNT", uint256(2_000_000));
        bool sharesToSpoke = vm.envOr("SHARES_TO_SPOKE", false);

        require(block.chainid != 114, "run this against the spoke, not the hub");

        _logHeader("Cross-chain deposit: spoke -> hub vault");
        console2.log("Spoke FXRP OFT  :", spokeAssetOFT);
        console2.log("Composer (hub)  :", composer);
        console2.log("Amount (6dp)    :", amount);
        console2.log("Share recipient :", recipient);
        console2.log("Shares land on  :", sharesToSpoke ? "the spoke (extra hop)" : "the hub (local transfer)");

        uint256 balance = IERC20(spokeAssetOFT).balanceOf(sender);
        console2.log("Sender balance  :", balance);
        require(balance >= amount, "insufficient spoke FXRP - run BridgeAssetToSpoke first");

        // ---------------------------------------------------------------
        // The hop: what the composer does with the shares it just minted
        // ---------------------------------------------------------------
        //
        // `amountLD` is ignored — `_depositAndSend` overwrites it with the shares actually minted. It
        // is `minAmountLD` that does the work, and it is denominated in *shares* (9dp), not assets.
        // Left at 0 the deposit accepts any share count, which is the honest default for a script that
        // has not quoted the vault; a UI should compute it from `previewDeposit` and a tolerance.
        SendParam memory hop = SendParam({
            dstEid: sharesToSpoke ? _spokeEid() : HUB_EID,
            to: _asPeer(recipient),
            amountLD: 0,
            minAmountLD: vm.envOr("MIN_SHARES", uint256(0)),
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        // Native the composer must be handed to fund the hop. Zero for the local case — `_sendLocal` is
        // a transfer, and our override refunds anything sent anyway. Non-zero only for the spoke hop,
        // where it pays a real LayerZero fee on Coston2.
        uint256 minMsgValue = sharesToSpoke ? vm.envUint("HOP_MSG_VALUE") : 0;

        SendParam memory outer = SendParam({
            dstEid: HUB_EID,
            to: _asPeer(composer),
            amountLD: amount,
            minAmountLD: amount,
            // Empty: `WireSpoke` set enforced options for msgType 2, which is what a send carrying a
            // compose message resolves to. This is the field whose emptiness only works because that
            // wiring ran.
            extraOptions: "",
            composeMsg: abi.encode(hop, minMsgValue),
            oftCmd: ""
        });

        MessagingFee memory fee = IOFT(spokeAssetOFT).quoteSend(outer, false);
        console2.log("");
        console2.log("Native fee (wei):", fee.nativeFee);
        console2.log("Hop msg.value   :", minMsgValue);

        uint256 total = fee.nativeFee + minMsgValue;
        require(sender.balance >= total, "insufficient native for LZ fee");

        vm.startBroadcast(_deployerKey());
        // No approve: mint-burn OFTs debit the sender directly.
        IOFT(spokeAssetOFT).send{value: total}(outer, MessagingFee(total, 0), sender);
        vm.stopBroadcast();

        console2.log("");
        console2.log("Sent. Track both legs at https://testnet.layerzeroscan.com");
        console2.log("Shares arrive as tFXRP for:", recipient);
    }
}
