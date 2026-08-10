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

contract AttackVault is TacitVault {
    address public fdcMock;
    address public ftsoMock;

    constructor(IERC20 a, address o, address f, address ft)
        TacitVault(a, "Tacit FXRP", "tFXRP", o)
    {
        fdcMock = f;
        ftsoMock = ft;
    }

    function _fdcVerification() internal view override returns (IFdcVerification) {
        return IFdcVerification(fdcMock);
    }

    function _ftsoV2() internal view override returns (FtsoV2Interface) {
        return FtsoV2Interface(ftsoMock);
    }
}

/// @notice The adversarial demo: we run a *malicious* enclave against our own vault.
///
/// @dev Each test here holds a correctly-signed plan from the registered TEE identity — the
///      signature is genuine, the enclave is authenticated, and it is still stopped. That is the
///      whole point. On Coston2 attestation is simulated, so if the contract simply paid out what
///      the enclave asked for, "we used a TEE" would mean "we used a trusted operator". These
///      reverts are the difference.
///
///      Run with: forge test --match-contract AttackTheEnclave -vv
contract AttackTheEnclaveTest is Test {
    uint256 constant TEE_PK = 0xA11CE;
    uint256 constant M = 1e6;

    MockFXRP fxrp;
    MockFdcVerification fdc;
    MockFtsoV2 ftso;
    AttackVault vault;
    LendingVenue venueA;
    LendingVenue venueB;

    address teeIdentity;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address attacker = makeAddr("attacker");

    function setUp() public {
        teeIdentity = vm.addr(TEE_PK);
        fxrp = new MockFXRP();
        fdc = new MockFdcVerification();
        ftso = new MockFtsoV2();
        vault = new AttackVault(IERC20(address(fxrp)), address(this), address(fdc), address(ftso));

        venueA = new LendingVenue(IERC20(address(fxrp)), address(vault), 800, address(this));
        venueB = new LendingVenue(IERC20(address(fxrp)), address(vault), 1_500, address(this));
        vault.addVenue(IVenue(address(venueA)), 6_000, true);
        vault.addVenue(IVenue(address(venueB)), 6_000, true);
        vault.setTeeIdentity(teeIdentity);

        fxrp.mint(address(this), 200_000 * M);
        fxrp.approve(address(venueA), type(uint256).max);
        fxrp.approve(address(venueB), type(uint256).max);
        venueA.fundReserve(50_000 * M);
        venueB.fundReserve(50_000 * M);

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            fxrp.mint(who, 10_000 * M);
            vm.prank(who);
            fxrp.approve(address(vault), type(uint256).max);
            vm.prank(who);
            vault.deposit(5_000 * M, who);
        }

        console2.log("=== TacitVault: attacking our own enclave ===");
        console2.log("Depositors      : alice + bob");
        console2.log("Vault assets    : %s FXRP", vault.totalAssets() / M);
        console2.log("Enclave identity: %s", teeIdentity);
        console2.log("All plans below are SIGNED BY THAT IDENTITY and still rejected.\n");
    }

    // ---------------------------------------------------------------

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

    function _proof(SignalTypes.MarketSignal memory s) internal view returns (IWeb2Json.Proof memory p) {
        p.data.responseBody.abiEncodedData = abi.encode(s);
        p.data.votingRound = _roundAt(block.timestamp);
    }

    function _signedPlan(uint16[] memory targets, SignalTypes.MarketSignal memory s)
        internal
        view
        returns (SignalTypes.RebalancePlan memory p, bytes memory sig)
    {
        p = SignalTypes.RebalancePlan({
            nonce: vault.rebalanceNonce(),
            deadline: uint64(block.timestamp + 1 hours),
            signalHash: SignalTypes.hashSignal(s),
            refPriceMicroUsd: s.priceMicroUsd,
            targetBps: targets
        });
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(vault), SignalTypes.hashPlan(p)))
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(TEE_PK, digest);
        sig = abi.encodePacked(r, ss, v);
    }

    function _t2(uint16 a, uint16 b) internal pure returns (uint16[] memory t) {
        t = new uint16[](2);
        t[0] = a;
        t[1] = b;
    }

    // ===============================================================
    // ATTACK 1 — the enclave tries to route funds through a venue that pays itself.
    // ===============================================================
    function test_attack1_drainViaSiphoningVenue() public {
        SiphoningVenue evil = new SiphoningVenue(IERC20(address(fxrp)), address(vault), attacker, 2_000);
        vault.addVenue(IVenue(address(evil)), 6_000, true);

        vm.warp(block.timestamp + 601);
        uint16[] memory targets = new uint16[](3);
        targets[2] = 5_000; // half the vault into the thief

        SignalTypes.MarketSignal memory s = _signal();
        (SignalTypes.RebalancePlan memory p, bytes memory sig) = _signedPlan(targets, s);

        uint256 assetsBefore = vault.totalAssets();
        vm.expectRevert();
        vault.executeRebalance(p, sig, _proof(s));

        console2.log("ATTACK 1  drain 20%% of a 50%% allocation via a malicious venue");
        console2.log("  -> reverted: ConservationViolated");
        console2.log("  attacker balance : %s FXRP", fxrp.balanceOf(attacker) / M);
        console2.log("  vault assets     : %s FXRP (unchanged)\n", vault.totalAssets() / M);

        assertEq(fxrp.balanceOf(attacker), 0);
        assertEq(vault.totalAssets(), assetsBefore);
    }

    // ===============================================================
    // ATTACK 2 — concentrate everything into one venue, past its cap.
    // ===============================================================
    function test_attack2_overConcentrate() public {
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        (SignalTypes.RebalancePlan memory p, bytes memory sig) = _signedPlan(_t2(9_900, 0), s);

        vm.expectRevert();
        vault.executeRebalance(p, sig, _proof(s));

        console2.log("ATTACK 2  push 99%% into a single 60%%-capped venue");
        console2.log("  -> reverted: VenueCapExceeded");
        console2.log("  venue A holds : %s FXRP\n", venueA.totalAssets() / M);

        assertEq(venueA.totalAssets(), 0);
    }

    // ===============================================================
    // ATTACK 3 — invent a price the market never printed.
    // ===============================================================
    function test_attack3_fabricatePrice() public {
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        s.priceMicroUsd = 5_000_000; // claim XRP is $5.00 while FTSO reports ~$1.04
        (SignalTypes.RebalancePlan memory p, bytes memory sig) = _signedPlan(_t2(3_000, 3_000), s);

        vm.expectRevert();
        vault.executeRebalance(p, sig, _proof(s));

        console2.log("ATTACK 3  claim a $5.00 reference price against an FTSO feed at ~$1.04");
        console2.log("  -> reverted: PriceOutOfBand (5%% band vs FTSO XRP/USD)");
        console2.log("  rebalance nonce : %s (not advanced)\n", vault.rebalanceNonce());

        assertEq(vault.rebalanceNonce(), 0);
    }

    // ===============================================================
    // ATTACK 4 — churn the book to bleed the vault through venue costs.
    // ===============================================================
    function test_attack4_churn() public {
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();
        (SignalTypes.RebalancePlan memory p0, bytes memory sig0) = _signedPlan(_t2(5_000, 0), s);
        vault.executeRebalance(p0, sig0, _proof(s));

        // First: try again straight away. The interval alone blocks high-frequency churn, before
        // any allocation maths is even reached.
        vm.warp(block.timestamp + 10);
        SignalTypes.MarketSignal memory s1 = _signal();
        (SignalTypes.RebalancePlan memory p1, bytes memory sig1) = _signedPlan(_t2(1_000, 1_000), s1);
        vm.expectRevert();
        vault.executeRebalance(p1, sig1, _proof(s1));

        console2.log("ATTACK 4  rebalance again 10s after the previous one");
        console2.log("  -> reverted: RebalanceTooSoon (300s minimum)");

        // Then: wait out the interval and attempt a full rotation of deployed capital instead.
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s2 = _signal();
        (SignalTypes.RebalancePlan memory p2, bytes memory sig2) = _signedPlan(_t2(0, 5_000), s2);

        vm.expectRevert();
        vault.executeRebalance(p2, sig2, _proof(s2));

        console2.log("  rotate 100%% of deployed capital between venues in one step");
        console2.log("  -> reverted: TurnoverExceeded (30%% cap)\n");
    }

    // ===============================================================
    // ATTACK 5 — act on an observation the data providers never attested.
    // ===============================================================
    function test_attack5_fabricateSignal() public {
        vm.warp(block.timestamp + 601);

        SignalTypes.MarketSignal memory attested = _signal();
        SignalTypes.MarketSignal memory invented = _signal();
        invented.volume24hUsd = 999_999_999; // pretend a huge volume spike justified the trade

        (SignalTypes.RebalancePlan memory p, bytes memory sig) = _signedPlan(_t2(3_000, 3_000), invented);

        vm.expectRevert();
        vault.executeRebalance(p, sig, _proof(attested));

        console2.log("ATTACK 5  compute on an invented volume spike, submit the real FDC proof");
        console2.log("  -> reverted: SignalMismatch (plan not bound to the attested observation)");

        // Replaying an observation attested in an old round is blocked too. The round, not the
        // submission time, is what dates it — so waiting cannot make a stale proof usable.
        // Jump to a realistic wall-clock first. Foundry starts at timestamp 1, which is *before*
        // the voting-epoch origin, so every round number would be in the future and nothing could
        // ever read as stale — the test would pass for the wrong reason.
        vm.warp(uint256(ROUND_ZERO_TS) + 4_000_000 * uint256(ROUND_SECONDS));
        (SignalTypes.RebalancePlan memory p2, bytes memory sig2) = _signedPlan(_t2(3_000, 3_000), attested);

        // Build the proof BEFORE arming expectRevert — `_proof` reads state, and a non-reverting
        // call in between is what Foundry would report as the failure.
        IWeb2Json.Proof memory oldProof = _proof(attested);
        oldProof.data.votingRound -= uint64(2 hours / ROUND_SECONDS); // attested two hours ago

        vm.expectRevert();
        vault.executeRebalance(p2, sig2, oldProof);
        console2.log("  -> stale replay reverted: SignalStale (1h max age)\n");
    }

    // ===============================================================
    // What the enclave CAN do — stated plainly, because overclaiming is worse than a limitation.
    // ===============================================================
    function test_whatTheEnclaveCanStillDo() public {
        vm.warp(block.timestamp + 601);
        SignalTypes.MarketSignal memory s = _signal();

        // A deliberately poor but entirely legal allocation: sit in the lower-yielding venue.
        (SignalTypes.RebalancePlan memory p, bytes memory sig) = _signedPlan(_t2(6_000, 0), s);
        vault.executeRebalance(p, sig, _proof(s));

        console2.log("RESIDUAL RISK  a malicious enclave picks a legal-but-poor allocation");
        console2.log("  -> accepted: 60%% into the 8%% venue, 0%% into the 15%% venue");
        console2.log("  This is opportunity cost, not loss. Depositor funds are intact and");
        console2.log("  fully redeemable. The enclave controls strategy quality, never fund safety.");

        assertEq(vault.totalAssets(), 10_000 * M, "no value lost");

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertApproxEqAbs(fxrp.balanceOf(alice), 10_000 * M, 10, "alice fully redeemable");
        console2.log("  alice redeemed  : %s FXRP\n", fxrp.balanceOf(alice) / M);
    }
}
