// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {SendParam} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {OFTComposeMsgCodec} from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import {IVaultComposerSync} from "@layerzerolabs/ovault-evm/contracts/interfaces/IVaultComposerSync.sol";

import {TacitOVaultComposer} from "../../src/ovault/TacitOVaultComposer.sol";
import {MockFXRP, MockFdcVerification, MockFtsoV2} from "../../src/mocks/Mocks.sol";
import {TestVault} from "../TacitVault.t.sol";
import {
    MockLzEndpoint,
    MockOFT,
    NativeRejecter,
    RejectingCaller,
    ReentrantOrigin
} from "./OVaultMocks.sol";

/// @notice Tests for `TacitOVaultComposer` — the cross-chain deposit/redeem entrypoint.
///
/// @dev Everything here is about **value that arrives and cannot complete its journey.** The base
/// `VaultComposerSync` is written for the happy path, and three of its behaviours lose funds when the
/// path is unhappy:
///
///   1. it zeroes `minAmountLD` before the bridge leg, so the slippage bound the user paid for is
///      enforced against the vault and then thrown away;
///   2. it ignores `msg.value` on a same-chain delivery, and says so in its own comment: the native
///      "accumulates in the contract and is locked";
///   3. its refund is a bare remote send — if that reverts, the tokens never move again.
///
/// The overrides fix all three. These tests are the evidence, so each one asserts on the *fixed*
/// behaviour and would fail against the unmodified base.
///
/// The composer is also the only place a cross-chain depositor meets `TacitVault`, and the vault has
/// a state that intentionally rejects deposits: `deposit` and `mint` are `whenNotPaused` while
/// `withdraw` and `redeem` never are. "Compose arrives while deposits are paused" is therefore an
/// operator state, not an exotic edge case, and it gets its own test.
///
/// ## Why hand-rolled mocks rather than `TestHelperOz5`
///
/// LayerZero's `test-devtools-evm-foundry` package is not installed, and it would not help: their
/// ovault mocks wrap the real `OFT` / `OFTAdapter`, which need a real endpoint to construct. What the
/// composer actually touches is small and fully determined by `VaultComposerSync` — see the notes in
/// `OVaultMocks.sol`. `lzCompose` is called *on* the composer *by* the endpoint, so pranking as the
/// endpoint is a faithful simulation of the only inbound path.
///
/// The vault, by contrast, is the **real** `TacitVault`, via the same `TestVault` harness the vault's
/// own suite uses. A mock vault would make the slippage and pause tests vacuous.
contract TacitOVaultComposerTest is Test {
    // Abstract endpoint ids. Only the hub/spoke distinction matters: `_send` routes locally when
    // `dstEid == VAULT_EID`, and that branch is what tests 11-15 exercise.
    uint32 constant HUB_EID = 1;
    uint32 constant SPOKE_EID = 2;

    uint256 constant M = 1e6; // one FXRP (6 decimals)
    uint256 constant S = 1e9; // one tFXRP share (6 asset decimals + the vault's 3-decimal offset)

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address multisig = makeAddr("multisig");

    MockFXRP fxrp;
    TestVault vault;
    MockLzEndpoint endpoint;
    MockOFT assetOFT;
    MockOFT shareOFT;
    TacitOVaultComposer composer;

    function setUp() public {
        fxrp = new MockFXRP();
        vault = new TestVault(
            IERC20(address(fxrp)), owner, address(new MockFdcVerification()), address(new MockFtsoV2())
        );

        endpoint = new MockLzEndpoint(HUB_EID);
        assetOFT = new MockOFT(address(fxrp), address(endpoint), true);
        shareOFT = new MockOFT(address(vault), address(endpoint), true);

        // No venues are configured. Every asset stays idle, so deposits and redemptions are exact and
        // the assertions below are about the composer rather than about strategy accounting.
        composer = new TacitOVaultComposer(address(vault), address(assetOFT), address(shareOFT), multisig);

        // Bootstrap so the exchange rate is established and there is liquidity to redeem against.
        fxrp.mint(address(this), 1_000_000 * M);
        fxrp.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * M, address(this));

        fxrp.mint(alice, 10_000 * M);
        vault.transfer(alice, 1_000 * S);
        vm.deal(alice, 100 ether);

        vm.startPrank(alice);
        fxrp.approve(address(composer), type(uint256).max);
        vault.approve(address(composer), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev `amountLD` is left at zero: the composer overwrites it with the vault's actual output.
    function _params(uint32 _dstEid, address _to, uint256 _minAmountLD) internal pure returns (SendParam memory) {
        return SendParam({
            dstEid: _dstEid,
            to: OFTComposeMsgCodec.addressToBytes32(_to),
            amountLD: 0,
            minAmountLD: _minAmountLD,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });
    }

    /// @dev Builds what the endpoint hands to `lzCompose`. The OFT prefixes the sender to the compose
    ///      payload, and `OFTComposeMsgCodec.encode` prepends nonce / srcEid / amount — so the layout
    ///      has to be assembled in that order for `composeFrom` and `composeMsg` to read back right.
    function _compose(address _from, SendParam memory _sendParam, uint256 _minMsgValue, uint256 _amountLD)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory payload =
            abi.encodePacked(OFTComposeMsgCodec.addressToBytes32(_from), abi.encode(_sendParam, _minMsgValue));
        return OFTComposeMsgCodec.encode(1, SPOKE_EID, _amountLD, payload);
    }

    /// @dev A well-formed envelope around a compose message that cannot be decoded, so `handleCompose`
    ///      reverts before it touches the vault. The cheapest way to reach the refund path without
    ///      having to arrange for the vault itself to fail.
    function _malformedCompose(address _from, uint256 _amountLD) internal pure returns (bytes memory) {
        bytes memory payload = abi.encodePacked(OFTComposeMsgCodec.addressToBytes32(_from), hex"01");
        return OFTComposeMsgCodec.encode(1, SPOKE_EID, _amountLD, payload);
    }

    /// @dev Mimics the OFT's `lzReceive` crediting the composer before the compose step runs.
    ///      `lzCompose` pulls nothing itself — it assumes the tokens are already here.
    function _creditComposer(uint256 _amount) internal {
        fxrp.mint(address(composer), _amount);
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_Constructor_WiresVaultAssetAndShare() public view {
        assertEq(address(composer.VAULT()), address(vault));
        assertEq(composer.ASSET_OFT(), address(assetOFT));
        assertEq(composer.ASSET_ERC20(), address(fxrp));
        assertEq(composer.SHARE_OFT(), address(shareOFT));
        assertEq(composer.SHARE_ERC20(), address(vault), "TacitVault is its own share token");
        assertEq(composer.ENDPOINT(), address(endpoint), "ENDPOINT is read off the asset OFT");
        assertEq(composer.VAULT_EID(), HUB_EID);
        assertEq(composer.strandedFundsRecipient(), multisig);
        assertEq(composer.owner(), address(this));
    }

    /// @dev The lockbox invariant, enforced at construction. A mint-burn share OFT would move shares
    ///      cross-chain by destroying supply here and recreating it there, which rewrites the
    ///      asset:share rate for everyone who never left the hub. It must be impossible to deploy.
    function test_Constructor_RevertsWhenShareOFTIsMintBurn() public {
        MockOFT mintBurnShare = new MockOFT(address(vault), address(endpoint), false);
        vm.expectRevert(abi.encodeWithSelector(IVaultComposerSync.ShareOFTNotAdapter.selector, address(mintBurnShare)));
        new TacitOVaultComposer(address(vault), address(assetOFT), address(mintBurnShare), multisig);
    }

    function test_Constructor_RevertsWhenShareTokenIsNotTheVault() public {
        MockOFT wrongShare = new MockOFT(address(fxrp), address(endpoint), true);
        vm.expectRevert(
            abi.encodeWithSelector(IVaultComposerSync.ShareTokenNotVault.selector, address(fxrp), address(vault))
        );
        new TacitOVaultComposer(address(vault), address(assetOFT), address(wrongShare), multisig);
    }

    function test_Constructor_RevertsWhenAssetTokenIsNotTheVaultAsset() public {
        MockFXRP otherToken = new MockFXRP();
        MockOFT wrongAsset = new MockOFT(address(otherToken), address(endpoint), true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaultComposerSync.AssetTokenNotVaultAsset.selector, address(otherToken), address(fxrp)
            )
        );
        new TacitOVaultComposer(address(vault), address(wrongAsset), address(shareOFT), multisig);
    }

    function test_Constructor_RevertsOnZeroStrandedRecipient() public {
        vm.expectRevert(TacitOVaultComposer.ZeroAddress.selector);
        new TacitOVaultComposer(address(vault), address(assetOFT), address(shareOFT), address(0));
    }

    // ---------------------------------------------------------------------
    // Slippage: the bound must survive into the bridge leg
    // ---------------------------------------------------------------------

    function test_depositAndSend_PreservesMinAmountLD() public {
        uint256 amount = 100 * M;
        uint256 expectedShares = vault.previewDeposit(amount);
        SendParam memory sendParam = _params(SPOKE_EID, alice, expectedShares);

        vm.prank(alice);
        composer.depositAndSend{value: 0.01 ether}(amount, sendParam, alice);

        SendParam memory sent = shareOFT.lastSendParam();
        assertEq(sent.minAmountLD, expectedShares, "base zeroes this; the override must not");
        assertEq(sent.amountLD, expectedShares);
        assertEq(sent.dstEid, SPOKE_EID);
        assertEq(sent.to, OFTComposeMsgCodec.addressToBytes32(alice));
        assertEq(shareOFT.lastMsgValue(), 0.01 ether, "the LZ fee is forwarded to the OFT");
    }

    /// @dev The narrow regression guard, kept separate from the value assertion above: whatever else
    ///      changes, a caller-supplied bound must never reach the OFT as zero.
    function test_depositAndSend_MinAmountLDIsNotZeroed() public {
        uint256 amount = 100 * M;
        SendParam memory sendParam = _params(SPOKE_EID, alice, 1);

        vm.prank(alice);
        composer.depositAndSend{value: 0.01 ether}(amount, sendParam, alice);

        assertNotEq(shareOFT.lastSendParam().minAmountLD, 0);
    }

    function test_redeemAndSend_PreservesMinAmountLD() public {
        uint256 shares = 100 * S;
        uint256 expectedAssets = vault.previewRedeem(shares);
        SendParam memory sendParam = _params(SPOKE_EID, alice, expectedAssets);

        vm.prank(alice);
        composer.redeemAndSend{value: 0.01 ether}(shares, sendParam, alice);

        SendParam memory sent = assetOFT.lastSendParam();
        assertEq(sent.minAmountLD, expectedAssets, "base zeroes this; the override must not");
        assertEq(sent.amountLD, expectedAssets);
    }

    function test_depositAndSend_RevertsOnVaultSlippage() public {
        uint256 amount = 100 * M;
        uint256 expectedShares = vault.previewDeposit(amount);
        SendParam memory sendParam = _params(SPOKE_EID, alice, expectedShares + 1);

        vm.expectRevert(
            abi.encodeWithSelector(IVaultComposerSync.SlippageExceeded.selector, expectedShares, expectedShares + 1)
        );
        vm.prank(alice);
        composer.depositAndSend{value: 0.01 ether}(amount, sendParam, alice);
    }

    function test_redeemAndSend_RevertsOnVaultSlippage() public {
        uint256 shares = 100 * S;
        uint256 expectedAssets = vault.previewRedeem(shares);
        SendParam memory sendParam = _params(SPOKE_EID, alice, expectedAssets + 1);

        vm.expectRevert(
            abi.encodeWithSelector(IVaultComposerSync.SlippageExceeded.selector, expectedAssets, expectedAssets + 1)
        );
        vm.prank(alice);
        composer.redeemAndSend{value: 0.01 ether}(shares, sendParam, alice);
    }

    /// @dev Documents the decimal step a spoke integrator has to know about. FXRP is 6 decimals; the
    ///      vault's 3-decimal offset makes `tFXRP` 9. So the number crossing the bridge is 9-decimal,
    ///      while LayerZero's default `sharedDecimals()` is 6 — the low 3 digits are dust.
    function test_depositAndSend_SendsNineDecimalShareAmounts() public {
        SendParam memory sendParam = _params(SPOKE_EID, alice, 0);

        vm.prank(alice);
        composer.depositAndSend{value: 0.01 ether}(1 * M, sendParam, alice);

        assertEq(shareOFT.lastSendParam().amountLD, 1 * S, "1 FXRP in, 1e9 share units across the wire");
    }

    // ---------------------------------------------------------------------
    // Local delivery: native must not be stranded
    // ---------------------------------------------------------------------

    function test_depositAndSend_Local_RefundsNativeToRefundAddress() public {
        uint256 amount = 100 * M;
        uint256 expectedShares = vault.previewDeposit(amount);
        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        uint256 aliceSharesBefore = vault.balanceOf(alice);
        uint256 bobBefore = bob.balance;

        vm.prank(alice);
        composer.depositAndSend{value: 1 ether}(amount, sendParam, bob);

        assertEq(vault.balanceOf(alice), aliceSharesBefore + expectedShares, "shares delivered on-chain");
        assertEq(bob.balance, bobBefore + 1 ether, "base locks this native forever");
        assertEq(address(composer).balance, 0, "nothing left behind");
        assertEq(shareOFT.sendCount(), 0, "a hub-eid destination must not touch the bridge");
    }

    function test_redeemAndSend_Local_RefundsNativeToRefundAddress() public {
        uint256 shares = 100 * S;
        uint256 expectedAssets = vault.previewRedeem(shares);
        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        uint256 aliceAssetsBefore = fxrp.balanceOf(alice);
        uint256 bobBefore = bob.balance;

        vm.prank(alice);
        composer.redeemAndSend{value: 1 ether}(shares, sendParam, bob);

        assertEq(fxrp.balanceOf(alice), aliceAssetsBefore + expectedAssets);
        assertEq(bob.balance, bobBefore + 1 ether);
        assertEq(address(composer).balance, 0);
    }

    /// @dev The `_msgValue > 0` guard is load-bearing, not defensive: a zero-value `call` with empty
    ///      calldata to a contract with no `receive` reverts. Without the guard, any refund address
    ///      that happens to be a plain contract would break every free local deposit.
    function test_depositAndSend_Local_ZeroMsgValueSkipsRefund() public {
        NativeRejecter rejecter = new NativeRejecter();
        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        vm.prank(alice);
        composer.depositAndSend{value: 0}(100 * M, sendParam, address(rejecter));

        assertEq(address(rejecter).balance, 0);
    }

    function test_depositAndSend_Local_FallsBackToCallerWhenRefundAddressRejects() public {
        NativeRejecter rejecter = new NativeRejecter();
        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        composer.depositAndSend{value: 1 ether}(100 * M, sendParam, address(rejecter));

        assertEq(alice.balance, aliceBefore, "sent 1 ether, got it straight back");
        assertEq(address(rejecter).balance, 0);
        assertEq(address(composer).balance, 0);
    }

    /// @dev When both legs of the refund reject native there is nowhere left to put it, and the whole
    ///      deposit reverts rather than silently stranding the value. Reaching this needs a caller
    ///      that is itself a contract without a `receive`.
    function test_depositAndSend_Local_RevertsWhenRefundAndCallerBothReject() public {
        uint256 amount = 100 * M;
        RejectingCaller caller = new RejectingCaller();

        fxrp.mint(address(caller), amount);
        vm.deal(address(caller), 1 ether); // the only way to fund a contract that cannot be paid

        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        vm.expectRevert(TacitOVaultComposer.NativeRefundFailed.selector);
        caller.deposit(address(composer), address(fxrp), amount, sendParam, 1 ether);
    }

    /// @dev The refund hands control to an address the caller chose, part-way through a deposit — a
    ///      callback surface the base contract does not have. It is guarded, and this proves the guard
    ///      fires rather than assuming it.
    function test_depositAndSend_Local_ReentrancyIsBlocked() public {
        uint256 amount = 100 * M;
        SendParam memory sendParam = _params(HUB_EID, alice, 0);

        ReentrantOrigin attacker = new ReentrantOrigin();
        attacker.arm(
            address(composer),
            abi.encodeCall(IVaultComposerSync.depositAndSend, (amount, sendParam, address(attacker)))
        );

        vm.prank(alice);
        composer.depositAndSend{value: 1 ether}(amount, sendParam, address(attacker));

        assertTrue(attacker.attempted(), "the refund must actually reach the callback");
        assertFalse(attacker.reentrySucceeded(), "re-entry must be rejected");
        assertEq(
            bytes4(attacker.reentryError()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "rejected by the guard, not by something incidental"
        );
    }

    // ---------------------------------------------------------------------
    // Compose: access control
    // ---------------------------------------------------------------------

    function test_lzCompose_OnlyEndpoint() public {
        vm.expectRevert(abi.encodeWithSelector(IVaultComposerSync.OnlyEndpoint.selector, alice));
        vm.prank(alice);
        composer.lzCompose(address(assetOFT), bytes32(0), _malformedCompose(alice, 1 * M), address(0), "");
    }

    function test_lzCompose_OnlyValidComposeCaller() public {
        vm.expectRevert(abi.encodeWithSelector(IVaultComposerSync.OnlyValidComposeCaller.selector, address(fxrp)));
        vm.prank(address(endpoint));
        composer.lzCompose(address(fxrp), bytes32(0), _malformedCompose(alice, 1 * M), address(0), "");
    }

    function test_handleCompose_OnlySelf() public {
        vm.expectRevert(abi.encodeWithSelector(IVaultComposerSync.OnlySelf.selector, alice));
        vm.prank(alice);
        composer.handleCompose(address(assetOFT), OFTComposeMsgCodec.addressToBytes32(alice), "", 1 * M);
    }

    /// @dev A fee shortfall must revert, not refund. Reverting leaves the message retryable by the
    ///      executor with more value; refunding would send the deposit home over a fee dispute.
    ///      `lzCompose` re-raises this one selector out of its catch block for exactly that reason.
    function test_lzCompose_BubblesInsufficientMsgValue() public {
        uint256 amount = 100 * M;
        _creditComposer(amount);

        SendParam memory sendParam = _params(SPOKE_EID, alice, 0);
        bytes memory message = _compose(alice, sendParam, 1 ether, amount);

        vm.expectRevert(abi.encodeWithSelector(IVaultComposerSync.InsufficientMsgValue.selector, 1 ether, 0));
        vm.prank(address(endpoint), alice);
        composer.lzCompose{value: 0}(address(assetOFT), bytes32("guid"), message, address(0), "");
    }

    // ---------------------------------------------------------------------
    // Compose: refund and escrow
    // ---------------------------------------------------------------------

    /// @dev The pause story. `TacitVault.deposit` is `whenNotPaused` while `redeem` never is, so exits
    ///      stay open while entries close. A compose that lands in that window has to send the FXRP
    ///      home rather than revert the message or hold the funds.
    function test_lzCompose_RefundsWhenVaultDepositsArePaused() public {
        uint256 amount = 100 * M;
        _creditComposer(amount);

        vm.prank(owner);
        vault.pause();

        SendParam memory sendParam = _params(SPOKE_EID, alice, 0);
        bytes memory message = _compose(alice, sendParam, 0, amount);

        vm.prank(address(endpoint), alice);
        composer.lzCompose(address(assetOFT), bytes32("guid"), message, address(0), "");

        assertEq(fxrp.balanceOf(address(assetOFT)), amount, "FXRP went back over the bridge");
        assertEq(fxrp.balanceOf(address(composer)), 0);
        assertEq(vault.balanceOf(address(composer)), 0, "no shares were minted");

        SendParam memory refund = assetOFT.lastSendParam();
        assertEq(refund.dstEid, SPOKE_EID, "refunded to the source chain");
        assertEq(refund.to, OFTComposeMsgCodec.addressToBytes32(alice), "refunded to the source sender");
    }

    function test_lzCompose_RefundBridgesBackWhenSendSucceeds() public {
        uint256 amount = 100 * M;
        _creditComposer(amount);

        vm.prank(address(endpoint), alice);
        composer.lzCompose(address(assetOFT), bytes32("guid"), _malformedCompose(alice, amount), address(0), "");

        assertEq(fxrp.balanceOf(address(assetOFT)), amount);
        assertEq(fxrp.balanceOf(multisig), 0, "escrow is not touched when the refund works");
    }

    /// @dev The last line of defence, and the reference implementation's central omission: the base
    ///      `_refund` is a bare remote send. When it reverts — a paused OFT, a stale peer, an
    ///      un-attestable destination — the base leaves the tokens here with no path out. The override
    ///      escrows them and names the intended recipient in an event.
    function test_lzCompose_EscrowsWhenRefundSendFails() public {
        uint256 amount = 100 * M;
        _creditComposer(amount);
        assetOFT.setFailSends(true);

        vm.expectEmit(true, false, false, true, address(composer));
        emit TacitOVaultComposer.StrandedFundsRecovered(address(assetOFT), amount, 0, alice);

        vm.prank(address(endpoint), alice);
        composer.lzCompose(address(assetOFT), bytes32("guid"), _malformedCompose(alice, amount), address(0), "");

        assertEq(fxrp.balanceOf(multisig), amount, "safe, but now recoverable only by a human");
        assertEq(fxrp.balanceOf(address(composer)), 0, "nothing left stuck here");
    }

    /// @dev Escrow keeps the unspent fee with the tokens so a manual re-dispatch has both. If the
    ///      recipient cannot take native the send is left unchecked on purpose — the tokens still move
    ///      and the event still fires, and the native becomes `rescueNative`'s problem.
    function test_lzCompose_EscrowSurvivesRecipientThatRejectsNative() public {
        uint256 amount = 100 * M;
        NativeRejecter rejecter = new NativeRejecter();
        composer.setStrandedFundsRecipient(address(rejecter));

        _creditComposer(amount);
        assetOFT.setFailSends(true);

        vm.deal(address(endpoint), 1 ether);
        vm.prank(address(endpoint), alice);
        composer.lzCompose{value: 1 ether}(
            address(assetOFT), bytes32("guid"), _malformedCompose(alice, amount), address(0), ""
        );

        assertEq(fxrp.balanceOf(address(rejecter)), amount, "tokens move even though the native cannot");
        assertEq(address(composer).balance, 1 ether, "native stays put, awaiting rescueNative");
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function test_setStrandedFundsRecipient_UpdatesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(composer));
        emit TacitOVaultComposer.StrandedFundsRecipientUpdated(multisig, bob);

        composer.setStrandedFundsRecipient(bob);

        assertEq(composer.strandedFundsRecipient(), bob);
    }

    function test_setStrandedFundsRecipient_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        composer.setStrandedFundsRecipient(bob);
    }

    function test_setStrandedFundsRecipient_RevertsOnZero() public {
        vm.expectRevert(TacitOVaultComposer.ZeroAddress.selector);
        composer.setStrandedFundsRecipient(address(0));
    }

    /// @dev Follows the real path into a native balance rather than writing one in: a failed escrow
    ///      leaves native here, and this is the only way out of that state.
    function test_rescueNative_SweepsNativeLeftByAFailedEscrow() public {
        uint256 amount = 100 * M;
        NativeRejecter rejecter = new NativeRejecter();
        composer.setStrandedFundsRecipient(address(rejecter));

        _creditComposer(amount);
        assetOFT.setFailSends(true);

        vm.deal(address(endpoint), 1 ether);
        vm.prank(address(endpoint), alice);
        composer.lzCompose{value: 1 ether}(
            address(assetOFT), bytes32("guid"), _malformedCompose(alice, amount), address(0), ""
        );
        assertEq(address(composer).balance, 1 ether);

        uint256 bobBefore = bob.balance;

        vm.expectEmit(true, false, false, true, address(composer));
        emit TacitOVaultComposer.NativeRescued(bob, 1 ether);

        composer.rescueNative(bob);

        assertEq(bob.balance, bobBefore + 1 ether);
        assertEq(address(composer).balance, 0);
    }

    function test_rescueNative_OnlyOwner() public {
        vm.deal(address(composer), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        composer.rescueNative(bob);
    }

    function test_rescueNative_RevertsOnZero() public {
        vm.deal(address(composer), 1 ether);
        vm.expectRevert(TacitOVaultComposer.ZeroAddress.selector);
        composer.rescueNative(address(0));
    }

    function test_rescueNative_RevertsWhenDestinationRejectsNative() public {
        NativeRejecter rejecter = new NativeRejecter();
        vm.deal(address(composer), 1 ether);

        vm.expectRevert(TacitOVaultComposer.NativeRefundFailed.selector);
        composer.rescueNative(address(rejecter));
    }

    /// @dev The owner can redirect escrowed funds, so a one-step handover to a mistyped address would
    ///      hand a stranger the recovery path for other people's deposits.
    function test_transferOwnership_IsTwoStep() public {
        composer.transferOwnership(alice);

        assertEq(composer.owner(), address(this), "the handover must not be immediate");
        assertEq(composer.pendingOwner(), alice);

        vm.prank(alice);
        composer.acceptOwnership();

        assertEq(composer.owner(), alice);
    }
}
