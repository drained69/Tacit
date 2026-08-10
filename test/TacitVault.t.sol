// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

import {TacitVault} from "../src/TacitVault.sol";
import {SignalTypes} from "../src/lib/SignalTypes.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";
import {LendingVenue} from "../src/venues/LendingVenue.sol";
import {MockFXRP, MockFdcVerification, MockFtsoV2, SiphoningVenue} from "../src/mocks/Mocks.sol";

/// @dev Test harness that redirects the two Flare system lookups at mocks. Production code path
///      is otherwise untouched — the overrides exist only so the suite can run without a fork.
contract TestVault is TacitVault {
    address public fdcMock;
    address public ftsoMock;

    constructor(IERC20 asset_, address owner_, address fdc_, address ftso_)
        TacitVault(asset_, "Tacit FXRP", "tFXRP", owner_)
    {
        fdcMock = fdc_;
        ftsoMock = ftso_;
    }

    function _fdcVerification() internal view override returns (IFdcVerification) {
        return IFdcVerification(fdcMock);
    }

    function _ftsoV2() internal view override returns (FtsoV2Interface) {
        return FtsoV2Interface(ftsoMock);
    }
}

contract TacitVaultTest is Test {
    uint256 constant TEE_PK = 0xA11CE;
    uint256 constant M = 1e6; // one FXRP (6 decimals)

    MockFXRP fxrp;
    MockFdcVerification fdc;
    MockFtsoV2 ftso;
    TestVault vault;
    LendingVenue venueA;
    LendingVenue venueB;

    address owner = address(this);
    address teeIdentity;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address attacker = makeAddr("attacker");

    function setUp() public {
        teeIdentity = vm.addr(TEE_PK);

        fxrp = new MockFXRP();
        fdc = new MockFdcVerification();
        ftso = new MockFtsoV2();
        vault = new TestVault(IERC20(address(fxrp)), owner, address(fdc), address(ftso));

        venueA = new LendingVenue(IERC20(address(fxrp)), address(vault), 800, owner); // 8% APR
        venueB = new LendingVenue(IERC20(address(fxrp)), address(vault), 1500, owner); // 15% APR

        vault.addVenue(IVenue(address(venueA)), 6_000, true);
        vault.addVenue(IVenue(address(venueB)), 6_000, true);
        vault.setTeeIdentity(teeIdentity);

        // Pre-fund venue yield reserves so accrual is actually payable.
        fxrp.mint(address(this), 1_000_000 * M);
        fxrp.approve(address(venueA), type(uint256).max);
        fxrp.approve(address(venueB), type(uint256).max);
        venueA.fundReserve(50_000 * M);
        venueB.fundReserve(50_000 * M);

        _fund(alice, 10_000 * M);
        _fund(bob, 10_000 * M);
        _fund(carol, 10_000 * M);
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    function _fund(address who, uint256 amount) internal {
        fxrp.mint(who, amount);
        vm.prank(who);
        fxrp.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount, who);
    }

    function _signal() internal view returns (SignalTypes.MarketSignal memory) {
        return SignalTypes.MarketSignal({
            priceMicroUsd: 1_037_218,
            volume24hUsd: 594_409_405,
            change1hBps: 8,
            change6hBps: -54,
            change24hBps: -39
        });
    }

    // Mirrors of the vault's voting-epoch constants. Kept local and `pure` on purpose: a helper
    // that calls the vault would issue a *non-reverting* call after `vm.expectRevert()` is armed,
    // which Foundry then reports as "next call did not revert as expected" — a failure with no
    // relationship to what is being tested.
    uint64 constant ROUND_ZERO_TS = 1_658_430_000;
    uint64 constant ROUND_SECONDS = 90;

    function _roundAt(uint256 ts) internal pure returns (uint64) {
        if (ts <= ROUND_ZERO_TS) return 0;
        return uint64((ts - ROUND_ZERO_TS) / ROUND_SECONDS);
    }

    /// @dev Freshness is derived from the attestation's voting round rather than a payload
    ///      timestamp, so tests date their proofs the same way the chain does.
    function _proof(SignalTypes.MarketSignal memory s) internal view returns (IWeb2Json.Proof memory p) {
        p.data.responseBody.abiEncodedData = abi.encode(s);
        p.data.votingRound = _roundAt(block.timestamp);
    }

    function _proofAtRound(SignalTypes.MarketSignal memory s, uint64 round)
        internal
        pure
        returns (IWeb2Json.Proof memory p)
    {
        p.data.responseBody.abiEncodedData = abi.encode(s);
        p.data.votingRound = round;
    }

    function _plan(uint16[] memory targets, SignalTypes.MarketSignal memory s)
        internal
        view
        returns (SignalTypes.RebalancePlan memory)
    {
        return SignalTypes.RebalancePlan({
            nonce: vault.rebalanceNonce(),
            deadline: uint64(block.timestamp + 1 hours),
            signalHash: SignalTypes.hashSignal(s),
            refPriceMicroUsd: s.priceMicroUsd,
            targetBps: targets
        });
    }

    function _sign(SignalTypes.RebalancePlan memory p, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(vault), SignalTypes.hashPlan(p)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _targets(uint16 a, uint16 b) internal pure returns (uint16[] memory t) {
        t = new uint16[](2);
        t[0] = a;
        t[1] = b;
    }

    /// @dev Executes an honest rebalance to the given split, advancing time past the rate limit.
    function _rebalance(uint16 a, uint16 b) internal {
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(a, b), s);
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    // ===============================================================
    // Vault accounting
    // ===============================================================

    function test_deposit_mintsSharesAndTracksAssets() public {
        _deposit(alice, 1_000 * M);
        assertEq(vault.totalAssets(), 1_000 * M, "assets");
        assertGt(vault.balanceOf(alice), 0, "shares");
        assertEq(vault.convertToAssets(vault.balanceOf(alice)), 1_000 * M, "roundtrip");
    }

    function test_withdraw_unwindsVenuesToServeRedemption() public {
        _deposit(alice, 1_000 * M);
        _rebalance(5_000, 4_000); // 90% deployed, 10% idle

        assertGt(venueA.totalAssets(), 0);
        assertGt(venueB.totalAssets(), 0);

        uint256 before_ = fxrp.balanceOf(alice);
        // Resolve the share balance *before* pranking: `vm.prank` applies to the next call only,
        // and a `balanceOf` read would otherwise consume it.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        // Alice gets essentially everything back; only integer-division dust may remain.
        assertApproxEqAbs(fxrp.balanceOf(alice) - before_, 1_000 * M, 10, "redeemed");
    }

    function test_yieldAccrues_toShareholdersProRata() public {
        _deposit(alice, 1_000 * M);
        _deposit(bob, 1_000 * M);
        _rebalance(0, 6_000); // concentrate in the 15% APR venue, within its 60% cap

        uint256 assetsBefore = vault.totalAssets();
        vm.warp(block.timestamp + 365 days);
        uint256 assetsAfter = vault.totalAssets();

        assertGt(assetsAfter, assetsBefore, "yield accrued");

        // Both holders share the gain in proportion to their equal stakes.
        uint256 aliceAssets = vault.convertToAssets(vault.balanceOf(alice));
        uint256 bobAssets = vault.convertToAssets(vault.balanceOf(bob));
        assertApproxEqAbs(aliceAssets, bobAssets, 2, "pro rata");
        assertGt(aliceAssets, 1_000 * M, "alice gained");
    }

    function test_firstDepositorCannotInflateShares() public {
        // Classic ERC-4626 inflation attack: deposit 1 wei, donate a large balance, then let the
        // victim deposit and try to round their shares to zero.
        _deposit(attacker == address(0) ? alice : alice, 1);
        fxrp.mint(address(vault), 5_000 * M); // donation

        _deposit(bob, 1_000 * M);
        assertGt(vault.balanceOf(bob), 0, "bob must receive non-zero shares");
    }

    // ===============================================================
    // Happy path
    // ===============================================================

    function test_rebalance_movesFundsToTargets() public {
        _deposit(alice, 1_000 * M);
        _rebalance(3_000, 5_000);

        assertApproxEqAbs(venueA.totalAssets(), 300 * M, 1, "venueA 30%");
        assertApproxEqAbs(venueB.totalAssets(), 500 * M, 1, "venueB 50%");
        assertApproxEqAbs(fxrp.balanceOf(address(vault)), 200 * M, 1, "20% idle");
        assertEq(vault.rebalanceNonce(), 1, "nonce advanced");
    }

    function test_rebalance_idleRemainderIsLegal() public {
        _deposit(alice, 1_000 * M);
        _rebalance(0, 0); // fully defensive: everything stays idle
        assertEq(fxrp.balanceOf(address(vault)), 1_000 * M);
    }

    // ===============================================================
    // INVARIANT 1 — conservation
    // ===============================================================

    function test_revert_conservation_whenVenueSiphonsFunds() public {
        _deposit(alice, 1_000 * M);

        // Owner is tricked into listing a venue that steals 10% of every deposit.
        SiphoningVenue evil = new SiphoningVenue(IERC20(address(fxrp)), address(vault), attacker, 1_000);
        vault.addVenue(IVenue(address(evil)), 6_000, true);

        vm.warp(block.timestamp + 601);
        uint16[] memory t = new uint16[](3);
        t[2] = 5_000;

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(t, s);

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.ConservationViolated.selector, 1_000 * M, 950 * M)
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));

        assertEq(fxrp.balanceOf(attacker), 0, "attacker got nothing");
    }

    // ===============================================================
    // INVARIANT 2 — venue caps
    // ===============================================================

    function test_revert_venueCap_whenPlanOverConcentrates() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(9_500, 0), s); // 95% into a 60%-capped venue

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.VenueCapExceeded.selector, 0, 950 * M, 600 * M)
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    function test_revert_targetsOverAllocate() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(6_000, 6_000), s); // 120%

        vm.expectRevert(abi.encodeWithSelector(TacitVault.TargetsOverAllocate.selector, 12_000));
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    // ===============================================================
    // INVARIANT 3 — rate limiting
    // ===============================================================

    function test_revert_rebalanceTooSoon() public {
        _deposit(alice, 1_000 * M);
        _rebalance(3_000, 3_000);

        vm.warp(block.timestamp + 10); // inside the 300s minimum
        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(1_000, 1_000), s);

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.RebalanceTooSoon.selector, vault.lastRebalanceAt(), uint32(300))
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    function test_revert_turnoverExceeded() public {
        _deposit(alice, 1_000 * M);
        _rebalance(5_000, 0); // 500 into A

        // Now demand a full 50%->0 / 0->50% swap: 1000 of turnover against a 3000bps (300) cap.
        vault.setGuardrails(1_000, 300, 500, 3_600, 10); // tighten turnover to 10%
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(0, 5_000), s);

        vm.expectRevert();
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    // ===============================================================
    // INVARIANT 4 — FTSO price band
    // ===============================================================

    function test_revert_priceOutOfBand_high() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        s.priceMicroUsd = 2_000_000; // enclave claims $2.00 while FTSO says ~$1.04
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.PriceOutOfBand.selector, 2_000_000, 1_038_910, uint16(500))
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    function test_priceBand_toleratesSmallDeviation() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        s.priceMicroUsd = 1_058_000; // ~1.8% above FTSO, inside the 5% band
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
        assertEq(vault.rebalanceNonce(), 1);
    }

    function test_priceBand_handlesNonSixDecimalFeed() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        ftso.set(1_038_910_000_000_000_000, 18); // same $1.03891, expressed with 18dp
        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
        assertEq(vault.rebalanceNonce(), 1, "18dp feed rescaled correctly");
    }

    // ===============================================================
    // INVARIANT 5 — signal binding and freshness
    // ===============================================================

    function test_revert_invalidProof() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);
        fdc.setAccept(false);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        vm.expectRevert(TacitVault.InvalidProof.selector);
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    function test_revert_signalMismatch_whenPlanBoundToDifferentObservation() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory attested = _signal();
        SignalTypes.MarketSignal memory claimed = _signal();
        claimed.volume24hUsd = 999_999_999; // enclave pretends it saw a volume spike

        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), claimed);

        vm.expectRevert(
            abi.encodeWithSelector(
                TacitVault.SignalMismatch.selector,
                SignalTypes.hashSignal(attested),
                SignalTypes.hashSignal(claimed)
            )
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(attested));
    }

    /// @dev The observation is dated by the round it was attested in, so an old round is stale
    ///      however recently the relayer submits it — which is the property that matters.
    function test_revert_staleSignal() public {
        // Move to a realistic wall-clock so voting rounds are meaningful.
        vm.warp(uint256(ROUND_ZERO_TS) + 4_000_000 * uint256(ROUND_SECONDS));
        _deposit(alice, 1_000 * M);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        // Two hours older than now, against a one-hour maximum age.
        uint64 staleRound = _roundAt(block.timestamp) - uint64(2 hours / ROUND_SECONDS);
        uint256 observedAt = uint256(ROUND_ZERO_TS) + uint256(staleRound) * ROUND_SECONDS;

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.SignalStale.selector, observedAt, uint32(3_600))
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proofAtRound(s, staleRound));
    }

    /// @notice A freshly-attested observation is accepted at realistic wall-clock times.
    function test_freshRoundIsAccepted() public {
        vm.warp(uint256(ROUND_ZERO_TS) + 4_000_000 * uint256(ROUND_SECONDS));
        _deposit(alice, 1_000 * M);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
        assertEq(vault.rebalanceNonce(), 1);
    }

    // ===============================================================
    // Authorisation
    // ===============================================================

    function test_revert_wrongSigner() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        uint256 rogue = 0xBADBAD;
        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.BadSigner.selector, vm.addr(rogue), teeIdentity)
        );
        vault.executeRebalance(p, _sign(p, rogue), _proof(s));
    }

    function test_revert_replayedPlan() public {
        _deposit(alice, 1_000 * M);

        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);
        bytes memory sig = _sign(p, TEE_PK);
        vault.executeRebalance(p, sig, _proof(s));

        vm.warp(block.timestamp + 601);
        vm.expectRevert(abi.encodeWithSelector(TacitVault.BadNonce.selector, 0, 1));
        vault.executeRebalance(p, sig, _proof(s));
    }

    function test_revert_expiredPlan() public {
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);
        p.deadline = uint64(block.timestamp - 1);

        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.PlanExpired.selector, p.deadline, block.timestamp)
        );
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    /// @dev A signature for vault A must not be replayable against vault B.
    function test_revert_crossVaultReplay() public {
        TestVault other = new TestVault(IERC20(address(fxrp)), owner, address(fdc), address(ftso));
        LendingVenue oa = new LendingVenue(IERC20(address(fxrp)), address(other), 800, owner);
        LendingVenue ob = new LendingVenue(IERC20(address(fxrp)), address(other), 800, owner);
        other.addVenue(IVenue(address(oa)), 6_000, true);
        other.addVenue(IVenue(address(ob)), 6_000, true);
        other.setTeeIdentity(teeIdentity);

        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);
        bytes memory sigForThisVault = _sign(p, TEE_PK);

        vm.expectRevert(); // recovers a different address against `other`
        other.executeRebalance(p, sigForThisVault, _proof(s));
    }

    function test_revert_noTeeIdentity() public {
        vault.setTeeIdentity(address(0));
        _deposit(alice, 1_000 * M);
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(3_000, 3_000), s);

        vm.expectRevert(TacitVault.NoTeeIdentity.selector);
        vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s));
    }

    // ===============================================================
    // Guardrail administration
    // ===============================================================

    function test_revert_guardrailsCannotBeDisabled() public {
        vm.expectRevert(TacitVault.BadParam.selector);
        vault.setGuardrails(0, 300, 500, 3_600, 10); // zero turnover

        vm.expectRevert(TacitVault.BadParam.selector);
        vault.setGuardrails(3_000, 300, 0, 3_600, 10); // zero price band

        vm.expectRevert(TacitVault.BadParam.selector);
        vault.setGuardrails(3_000, 300, 5_000, 3_600, 10); // band wider than 20%

        vm.expectRevert(TacitVault.BadParam.selector);
        vault.setGuardrails(3_000, 300, 500, 3_600, 500); // 5% "conservation tolerance"
    }

    function test_revert_onlyOwnerAdmin() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setTeeIdentity(attacker);

        vm.prank(attacker);
        vm.expectRevert();
        vault.setGuardrails(9_000, 0, 2_000, 86_400, 100);
    }

    function test_venueAssetMismatchRejected() public {
        MockFXRP other = new MockFXRP();
        LendingVenue bad = new LendingVenue(IERC20(address(other)), address(vault), 800, owner);
        vm.expectRevert(
            abi.encodeWithSelector(TacitVault.VenueAssetMismatch.selector, address(other), address(fxrp))
        );
        vault.addVenue(IVenue(address(bad)), 6_000, true);
    }

    function test_deactivateVenue_repatriatesFunds() public {
        _deposit(alice, 1_000 * M);
        _rebalance(5_000, 0);
        assertGt(venueA.totalAssets(), 0);

        uint256 totalBefore = vault.totalAssets();
        vault.deactivateVenue(0);

        assertEq(venueA.totalAssets(), 0, "venue drained");
        assertApproxEqAbs(vault.totalAssets(), totalBefore, 2, "assets preserved");
    }

    // ===============================================================
    // Illiquidity
    // ===============================================================

    function test_illiquidVenue_doesNotBlockRedemption() public {
        _deposit(alice, 1_000 * M);
        _rebalance(5_000, 0);

        venueA.setLiquidityBps(5_000); // only half returnable

        uint256 maxW = vault.maxWithdraw(alice);
        assertLt(maxW, 1_000 * M, "capped by venue liquidity");
        assertGt(maxW, 0, "still partially redeemable");

        vm.prank(alice);
        vault.withdraw(maxW, alice, alice);
        assertApproxEqAbs(fxrp.balanceOf(alice), 9_000 * M + maxW, 2);
    }

    // ===============================================================
    // Fuzz
    // ===============================================================

    /// @dev Whatever split the enclave picks, conservation and caps must hold.
    function testFuzz_anyValidPlanPreservesInvariants(uint16 a, uint16 b, uint256 amount) public {
        amount = bound(amount, 1 * M, 5_000 * M);
        a = uint16(bound(a, 0, 6_000));
        b = uint16(bound(b, 0, 6_000));

        _deposit(alice, amount);
        uint256 before_ = vault.totalAssets();

        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        SignalTypes.RebalancePlan memory p = _plan(_targets(a, b), s);

        try vault.executeRebalance(p, _sign(p, TEE_PK), _proof(s)) {
            uint256 after_ = vault.totalAssets();
            assertGe(after_ + (before_ * 10) / 10_000, before_, "conservation");

            uint256 total = vault.totalAssets();
            assertLe(venueA.totalAssets() * 10_000, total * 6_000 + 10_000, "cap A");
            assertLe(venueB.totalAssets() * 10_000, total * 6_000 + 10_000, "cap B");
        } catch {
            // Rejection is always an acceptable outcome; silent violation is not.
        }
    }

    function testFuzz_depositRedeemRoundTripNeverMintsValue(uint256 amount) public {
        amount = bound(amount, 1 * M, 9_000 * M);

        uint256 startBal = fxrp.balanceOf(alice);
        _deposit(alice, amount);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        assertLe(fxrp.balanceOf(alice), startBal, "round trip must not create value");
    }
}
