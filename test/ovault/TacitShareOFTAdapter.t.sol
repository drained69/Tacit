// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IOFT} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";

import {TacitShareOFTAdapter} from "../../src/ovault/TacitShareOFTAdapter.sol";
import {MockFXRP, MockFdcVerification, MockFtsoV2} from "../../src/mocks/Mocks.sol";
import {TestVault} from "../TacitVault.t.sol";
import {MockLzEndpoint, HostileShareToken} from "./OVaultMocks.sol";

/// @dev Exposes the two internal hooks that carry all of the adapter's behaviour.
///
/// `_credit` and `_debit` are called by `OFTCore` from inside `lzReceive` and `send`, both of which
/// need a real endpoint, a configured peer, and a signed message to reach. Subclassing to call them
/// directly tests the same code with none of that scaffolding — and unlike a full endpoint
/// simulation, it can express the cases that matter here, where the *recipient* is the problem.
contract AdapterHarness is TacitShareOFTAdapter {
    constructor(address _shareToken, address _lzEndpoint, address _delegate, address _strandedFundsRecipient)
        TacitShareOFTAdapter(_shareToken, _lzEndpoint, _delegate, _strandedFundsRecipient)
    {}

    function credit(address _to, uint256 _amountLD, uint32 _srcEid) external returns (uint256) {
        return _credit(_to, _amountLD, _srcEid);
    }

    function debit(address _from, uint256 _amountLD, uint256 _minAmountLD, uint32 _dstEid)
        external
        returns (uint256 amountSentLD, uint256 amountReceivedLD)
    {
        return _debit(_from, _amountLD, _minAmountLD, _dstEid);
    }
}

/// @notice Tests for `TacitShareOFTAdapter` — the lockbox that holds every `tFXRP` share currently
///         living on a spoke chain.
///
/// @dev Three properties are worth proving, and each maps to a group below.
///
/// **It is a lockbox, not a mint-burn adapter.** The share token's `totalSupply()` is one half of the
/// exchange rate every depositor is priced against, so moving shares cross-chain by destroying supply
/// here and recreating it there would silently rewrite that rate for everyone who never left the hub.
/// `approvalRequired() == true` is the flag `VaultComposerSync` gates on to enforce this, so it gets
/// asserted rather than assumed.
///
/// **An inbound delivery must always be consumable.** The default `OFTAdapter._credit` unlocks with a
/// bare `safeTransfer`. The recipient is chosen on the spoke, where nothing constrains it to an
/// address this transfer can succeed to — and a revert inside `_credit` happens inside `lzReceive`,
/// so the message can never be delivered and the shares behind it stay locked here with no path out.
/// The override reroutes instead. Its three failure branches are `address(0)`, a token that reverts,
/// and a token that returns `false`; the real `TacitVault` can only produce the first, so
/// `HostileShareToken` supplies the other two. They are not hypothetical — blocklists, freeze lists
/// and the older no-revert ERC-20s all behave that way.
///
/// **The decimal step is real and bounded.** `tFXRP` has 9 decimals (FXRP's 6 plus the vault's
/// 3-decimal virtual-share offset) against LayerZero's 6 shared decimals, so every cross-chain send
/// truncates. Two tests pin down what that costs and who pays it.
///
/// The vault is the **real** `TacitVault`, via the same `TestVault` harness its own suite uses: a mock
/// with convenient decimals would make the dust tests vacuous.
contract TacitShareOFTAdapterTest is Test {
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
    AdapterHarness adapter;

    function setUp() public {
        fxrp = new MockFXRP();
        vault = new TestVault(IERC20(address(fxrp)), owner, address(new MockFdcVerification()), address(new MockFtsoV2()));
        endpoint = new MockLzEndpoint(HUB_EID);
        adapter = new AdapterHarness(address(vault), address(endpoint), owner, multisig);

        fxrp.mint(address(this), 1_000_000 * M);
        fxrp.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * M, address(this));

        // Alice holds shares to send out; the adapter holds the escrow behind shares already on a
        // spoke. Both are the steady state — an adapter with no balance cannot credit anything.
        vault.transfer(alice, 1_000 * S);
        vault.transfer(address(adapter), 500 * S);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev A second adapter over a token that can be made to fail on transfer. 9 decimals to match
    ///      `tFXRP`, so amounts and the dust step read the same as in the primary fixture.
    function _hostileAdapter(uint256 _escrow)
        internal
        returns (AdapterHarness hostileAdapter, HostileShareToken hostile)
    {
        hostile = new HostileShareToken(9);
        hostileAdapter = new AdapterHarness(address(hostile), address(endpoint), owner, multisig);
        hostile.mint(address(hostileAdapter), _escrow);
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_Constructor_WiresTokenEndpointOwnerAndRecipient() public view {
        assertEq(adapter.token(), address(vault), "the share token is the vault itself");
        assertEq(address(adapter.endpoint()), address(endpoint));
        assertEq(adapter.owner(), owner);
        assertEq(adapter.strandedFundsRecipient(), multisig);
        assertEq(endpoint.delegates(address(adapter)), owner, "OAppCore registers the delegate at construction");
    }

    /// @dev The invariant the whole design rests on. `VaultComposerSync`'s constructor reverts
    ///      `ShareOFTNotAdapter` unless this is true, so it is also the composer's only guarantee that
    ///      share supply is not being rewritten underneath hub-only holders.
    function test_Constructor_IsALockboxNotMintBurn() public view {
        assertTrue(adapter.approvalRequired());
        assertEq(vault.totalSupply(), 10_000 * S, "escrow moves custody, never supply");
    }

    function test_Constructor_RevertsOnZeroStrandedRecipient() public {
        vm.expectRevert(TacitShareOFTAdapter.ZeroAddress.selector);
        new AdapterHarness(address(vault), address(endpoint), owner, address(0));
    }

    /// @dev Not `InvalidDelegate()`, which is what `OAppCore` would raise: C3 linearization runs
    ///      `Ownable`'s constructor before `OAppCore`'s body, and `OAppCore` never calls `Ownable`
    ///      itself, so the zero owner is rejected first. Asserted because the two errors point at
    ///      different mistakes and a deploy script reading the wrong one looks in the wrong place.
    function test_Constructor_RevertsOnZeroDelegate() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new AdapterHarness(address(vault), address(endpoint), address(0), multisig);
    }

    /// @dev The one decimal configuration that cannot be adapted around: LayerZero's shared decimals
    ///      are the floor, and a share token below it has no faithful cross-chain representation.
    ///      `tFXRP` sits above the floor, so this is a guard on future share tokens, not on this one.
    function test_Constructor_RevertsWhenShareTokenIsTooCoarseForSharedDecimals() public {
        HostileShareToken coarse = new HostileShareToken(4);

        vm.expectRevert(IOFT.InvalidLocalDecimals.selector);
        new AdapterHarness(address(coarse), address(endpoint), owner, multisig);
    }

    function test_Constructor_DocumentsTheThreeDecimalDustStep() public view {
        assertEq(vault.decimals(), 9, "FXRP's 6 plus the vault's 3-decimal offset");
        assertEq(adapter.sharedDecimals(), 6, "LayerZero's default, unchanged");
        assertEq(adapter.decimalConversionRate(), 1000, "10 ** (9 - 6): the size of one indivisible step");
    }

    // ---------------------------------------------------------------------
    // Delivery: an inbound message must always be consumable
    // ---------------------------------------------------------------------

    function test_credit_UnlocksToTheRecipient() public {
        uint256 amount = 10 * S;

        uint256 returned = adapter.credit(bob, amount, SPOKE_EID);

        assertEq(returned, amount);
        assertEq(vault.balanceOf(bob), amount);
        assertEq(vault.balanceOf(address(adapter)), 490 * S);
        assertEq(vault.balanceOf(multisig), 0, "the happy path never touches the recovery address");
    }

    /// @dev The trivial case, and the only one the real vault can produce: OpenZeppelin's ERC-20
    ///      reverts on a zero recipient. `_tryTransfer` short-circuits before attempting it, but the
    ///      outcome that matters is the same either way — the message is consumed, not bricked.
    function test_credit_ReroutesWhenRecipientIsZeroAddress() public {
        uint256 amount = 10 * S;

        vm.expectEmit(true, false, false, true, address(adapter));
        emit TacitShareOFTAdapter.StrandedSharesRecovered(address(0), amount, SPOKE_EID);

        uint256 returned = adapter.credit(address(0), amount, SPOKE_EID);

        assertEq(returned, amount, "the base would have reverted here, locking the shares forever");
        assertEq(vault.balanceOf(multisig), amount);
        assertEq(vault.balanceOf(address(adapter)), 490 * S);
    }

    function test_credit_ReroutesWhenTheTokenRevertsOnTransfer() public {
        (AdapterHarness hostileAdapter, HostileShareToken hostile) = _hostileAdapter(500 * S);
        hostile.setBlocked(bob, true);

        vm.expectEmit(true, false, false, true, address(hostileAdapter));
        emit TacitShareOFTAdapter.StrandedSharesRecovered(bob, 10 * S, SPOKE_EID);

        uint256 returned = hostileAdapter.credit(bob, 10 * S, SPOKE_EID);

        assertEq(returned, 10 * S);
        assertEq(hostile.balanceOf(bob), 0);
        assertEq(hostile.balanceOf(multisig), 10 * S);
    }

    /// @dev The branch a `try/catch` alone would miss. An ERC-20 that returns `false` without
    ///      reverting moves nothing and reports nothing, so treating a `false` return as success would
    ///      credit the recipient in LayerZero's accounting while the shares sat here.
    function test_credit_ReroutesWhenTheTokenReturnsFalse() public {
        (AdapterHarness hostileAdapter, HostileShareToken hostile) = _hostileAdapter(500 * S);
        hostile.setFailsSilently(bob, true);

        vm.expectEmit(true, false, false, true, address(hostileAdapter));
        emit TacitShareOFTAdapter.StrandedSharesRecovered(bob, 10 * S, SPOKE_EID);

        uint256 returned = hostileAdapter.credit(bob, 10 * S, SPOKE_EID);

        assertEq(returned, 10 * S);
        assertEq(hostile.balanceOf(bob), 0);
        assertEq(hostile.balanceOf(multisig), 10 * S);
    }

    /// @dev The limit of the fallback, stated rather than hidden: it has exactly one destination, and
    ///      if that destination is also unreachable the message reverts and the shares stay locked.
    ///      This is the failure mode `setStrandedFundsRecipient` exists to get ahead of — the recovery
    ///      address must be verified reachable before it is set, not after.
    function test_credit_RevertsWhenEvenTheRecoveryTransferFails() public {
        (AdapterHarness hostileAdapter, HostileShareToken hostile) = _hostileAdapter(500 * S);
        hostile.setBlocked(bob, true);
        hostile.setBlocked(multisig, true);

        // `safeTransfer` bubbles the token's own revert rather than wrapping it.
        vm.expectRevert(abi.encodeWithSelector(HostileShareToken.Blocked.selector, multisig));
        hostileAdapter.credit(bob, 10 * S, SPOKE_EID);
    }

    /// @dev An adapter can only unlock what it escrowed. A credit larger than the escrow means the
    ///      hub's accounting has already diverged from the spokes', and reverting is correct — the
    ///      fallback must not turn a supply inconsistency into a silent transfer out of someone
    ///      else's escrow.
    function test_credit_RevertsWhenTheLockboxIsUnderfunded() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter), 500 * S, 600 * S)
        );
        adapter.credit(bob, 600 * S, SPOKE_EID);
    }

    // ---------------------------------------------------------------------
    // Send: the 9-vs-6 decimal step
    // ---------------------------------------------------------------------

    /// @dev The dust is truncated *before* the escrow pull, so the sender keeps it. The alternative —
    ///      pulling the full amount and sending the rounded-down figure — would leave a growing
    ///      residue in this contract that no share on any chain accounts for.
    function test_debit_TruncatesDustBelowSharedDecimals() public {
        vm.prank(alice);
        vault.approve(address(adapter), type(uint256).max);

        uint256 aliceBefore = vault.balanceOf(alice);
        uint256 escrowBefore = vault.balanceOf(address(adapter));

        (uint256 sent, uint256 received) = adapter.debit(alice, 1 * S + 999, 0, SPOKE_EID);

        assertEq(sent, 1 * S, "the low three digits have no cross-chain representation");
        assertEq(received, 1 * S, "a lockbox takes no fee, so sent and received match");
        assertEq(vault.balanceOf(alice), aliceBefore - 1 * S, "999 units of dust stay with the sender");
        assertEq(vault.balanceOf(address(adapter)), escrowBefore + 1 * S, "escrow matches what crossed");
    }

    /// @dev Truncation is a form of slippage, and it is bounded by the same check. Worth its own test
    ///      because it is the one case where a send fails with nothing wrong on either chain: 1999
    ///      share units simply cannot be expressed at 6 shared decimals, and a caller who demands all
    ///      of them arrive gets a revert rather than 1000.
    function test_debit_RevertsWhenDustTruncationBreachesMinAmount() public {
        vm.prank(alice);
        vault.approve(address(adapter), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(IOFT.SlippageExceeded.selector, 1000, 1999));
        adapter.debit(alice, 1999, 1999, SPOKE_EID);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function test_setStrandedFundsRecipient_UpdatesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(adapter));
        emit TacitShareOFTAdapter.StrandedFundsRecipientUpdated(multisig, bob);

        vm.prank(owner);
        adapter.setStrandedFundsRecipient(bob);

        assertEq(adapter.strandedFundsRecipient(), bob);
    }

    function test_setStrandedFundsRecipient_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        adapter.setStrandedFundsRecipient(bob);
    }

    function test_setStrandedFundsRecipient_RevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(TacitShareOFTAdapter.ZeroAddress.selector);
        adapter.setStrandedFundsRecipient(address(0));
    }

    // ---------------------------------------------------------------------
    // Ownership
    // ---------------------------------------------------------------------

    /// @dev Two-step because this owner is also the LayerZero delegate: it can rewrite this OApp's
    ///      peers and message libraries at the endpoint, so a one-step transfer to a mistyped address
    ///      would hand away control of the escrow's configuration with no way back.
    function test_transferOwnership_IsTwoStep() public {
        vm.prank(owner);
        adapter.transferOwnership(bob);

        assertEq(adapter.owner(), owner, "the handover must not be immediate");
        assertEq(adapter.pendingOwner(), bob);

        vm.prank(bob);
        adapter.acceptOwnership();

        assertEq(adapter.owner(), bob);
    }

    function test_transferOwnership_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        adapter.transferOwnership(bob);
    }

    /// @dev A deploy-runbook step, pinned as a test because it is silent when missed. Ownership and
    ///      the endpoint delegate are set together at construction and then diverge: completing a
    ///      handover leaves the *old* owner as delegate, still able to reconfigure peers and libraries
    ///      on an adapter it no longer owns. `setDelegate` has to be called explicitly afterwards.
    function test_transferOwnership_DoesNotMoveTheLayerZeroDelegate() public {
        vm.prank(owner);
        adapter.transferOwnership(bob);
        vm.prank(bob);
        adapter.acceptOwnership();

        assertEq(endpoint.delegates(address(adapter)), owner, "the delegate does not follow ownership");

        vm.prank(bob);
        adapter.setDelegate(bob);

        assertEq(endpoint.delegates(address(adapter)), bob);
    }
}
