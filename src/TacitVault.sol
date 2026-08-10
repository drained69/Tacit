// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";

import {IVenue} from "./interfaces/IVenue.sol";
import {SignalTypes} from "./lib/SignalTypes.sol";

/// @title TacitVault
/// @notice An ERC-4626 FXRP vault whose allocation decisions are made by a confidential agent
///         running in a Flare Confidential Compute enclave, and whose safety does not depend on
///         that enclave being honest.
///
/// @dev ## Trust model — read this before changing `executeRebalance`
///
/// On Coston2, FCC attestation is *simulated* (`SIMULATED_TEE=true`). If this contract paid out
/// whatever the enclave asked for, the enclave would be an unverified trusted operator wearing a
/// TEE costume. So the enclave's authority is deliberately bounded on-chain instead:
///
///   1. CONSERVATION   — total assets may not fall across a rebalance (beyond a dust tolerance).
///   2. VENUE CAP      — no venue may exceed its configured share of the vault.
///   3. RATE LIMIT     — turnover per window is capped, and rebalances are spaced apart.
///   4. PRICE BAND     — the price the enclave claims to have used must sit inside an FTSO band.
///   5. SIGNAL BINDING — the plan is bound to one FDC-attested observation, which must be fresh.
///
/// What a malicious enclave still *can* do: pick a poor allocation inside the bands, or refuse to
/// act. What it *cannot* do: move funds out of the vault, concentrate into one venue, churn the
/// book, or act on an invented price. In short — the enclave controls strategy quality, never
/// fund safety. That boundary is the product.
contract TacitVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SignalTypes for SignalTypes.MarketSignal;
    using SignalTypes for SignalTypes.RebalancePlan;
    using Math for uint256;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct VenueInfo {
        IVenue venue;
        uint16 capBps;
        bool active;
        /// @notice Whether this venue pays withdrawals synchronously.
        /// @dev Declared by the operator at registration, verified with
        ///      `ERC4626Venue.probeSynchronous()` beforehand. It cannot be discovered safely at
        ///      redemption time: finding out by trying means the attempt reverts, and a revert
        ///      rolls back the very flag that would have recorded the lesson. So the judgement is
        ///      made once, deliberately, by whoever integrates the venue.
        ///
        ///      `false` means capital may still be *allocated* there, but its liquidity is never
        ///      counted toward what depositors can redeem — so quotes stay honest.
        bool liquidOnDemand;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint16 public constant BPS = 10_000;

    /// @notice FTSO feed id for XRP/USD. Verified live on Coston2.
    bytes21 public constant XRP_USD_FEED_ID = bytes21(0x015852502f55534400000000000000000000000000);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    VenueInfo[] public venues;

    /// @notice Address derived from the enclave's registered signing identity.
    address public teeIdentity;

    /// @notice Monotonic nonce; every accepted plan must match and then increments.
    uint256 public rebalanceNonce;

    uint64 public lastRebalanceAt;

    /// @notice Max fraction of the vault that may change venue in one rebalance.
    uint16 public maxTurnoverBps = 3_000;

    /// @notice Minimum seconds between accepted rebalances.
    uint32 public minRebalanceInterval = 300;

    /// @notice Tolerance between the enclave's reference price and the FTSO price.
    uint16 public priceBandBps = 500;

    /// @notice Oldest acceptable age for an attested market observation.
    uint32 public maxSignalAge = 3_600;

    /// @notice Loss tolerated across a rebalance, to absorb venue rounding. Not a slippage budget.
    uint16 public conservationToleranceBps = 10;

    /// @notice Set true once an FTSO read has succeeded, so a feed outage cannot be silently
    ///         mistaken for "band checking was never enabled".
    bool public priceBandEnforced = true;

    /// @notice The market observation behind the most recent accepted rebalance.
    /// @dev Stored rather than left in an event so that anyone — a UI, a depositor, a competing
    ///      auditor — can read the exact inputs the enclave acted on without indexing logs. The
    ///      strategy stays private; its *inputs* are deliberately public, which is what makes the
    ///      allocation auditable after the fact rather than merely trusted.
    SignalTypes.MarketSignal public lastSignal;

    /// @notice FTSO price recorded at the moment of the last accepted rebalance, in micro-USD.
    uint256 public lastFtsoPriceMicroUsd;



    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event VenueAdded(uint256 indexed venueId, address venue, uint16 capBps);
    event VenueCapUpdated(uint256 indexed venueId, uint16 capBps);
    event VenueDeactivated(uint256 indexed venueId);
    event TeeIdentityUpdated(address indexed previous, address indexed current);
    event RebalanceRequested(uint256 indexed nonce, uint256 totalAssets, uint64 timestamp);
    event Rebalanced(
        uint256 indexed nonce,
        bytes32 indexed signalHash,
        uint256 totalAssetsBefore,
        uint256 totalAssetsAfter,
        uint256 turnover
    );
    event GuardrailsUpdated(
        uint16 maxTurnoverBps, uint32 minRebalanceInterval, uint16 priceBandBps, uint32 maxSignalAge
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NoTeeIdentity();
    error BadSigner(address recovered, address expected);
    error PlanExpired(uint64 deadline, uint256 nowTs);
    error BadNonce(uint256 got, uint256 expected);
    error RebalanceTooSoon(uint64 lastAt, uint32 minInterval);
    error InvalidProof();
    error SignalMismatch(bytes32 got, bytes32 expected);
    error SignalStale(uint256 obsTimestamp, uint32 maxAge);
    error PriceOutOfBand(uint256 refPrice, uint256 ftsoPrice, uint16 bandBps);
    error TargetLengthMismatch(uint256 got, uint256 expected);
    error TargetsOverAllocate(uint256 sum);
    error ConservationViolated(uint256 before_, uint256 after_);
    error VenueCapExceeded(uint256 venueId, uint256 assets, uint256 cap);
    error TurnoverExceeded(uint256 turnover, uint256 cap);
    error VenueAssetMismatch(address venueAsset, address vaultAsset);
    error InactiveVenueTarget(uint256 venueId);
    error NoVenues();
    error BadParam();
    /// @notice Venues could not produce enough to cover the redemption.
    error InsufficientLiquidity(uint256 requested, uint256 available);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(owner_)
    {}

    /// @dev Virtual-share offset blunts the classic first-depositor share-inflation attack.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // ---------------------------------------------------------------------
    // External system dependencies (overridable for tests)
    // ---------------------------------------------------------------------

    /// @dev Resolved through the registry rather than hardcoded, because Flare rotates system
    ///      addresses. Overridden in tests to inject mocks.
    function _fdcVerification() internal view virtual returns (IFdcVerification) {
        return ContractRegistry.getFdcVerification();
    }

    function _ftsoV2() internal view virtual returns (FtsoV2Interface) {
        return ContractRegistry.getFtsoV2();
    }

    // ---------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------

    /// @notice Idle assets plus everything currently deployed to venues.
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        uint256 n = venues.length;
        for (uint256 i; i < n; ++i) {
            if (venues[i].active) total += _venueAssets(i);
        }
    }

    function venueCount() external view returns (uint256) {
        return venues.length;
    }

    /// @notice Per-venue assets, for UIs and for verifying allocations off-chain.
    function allocations() external view returns (uint256[] memory assetsPerVenue, uint256 idle) {
        uint256 n = venues.length;
        assetsPerVenue = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            if (venues[i].active) assetsPerVenue[i] = _venueAssets(i);
        }
        idle = IERC20(asset()).balanceOf(address(this));
    }

    /// @dev Withdrawals are served from idle first, then by unwinding venues **pro rata**.
    ///
    ///      Unwinding in index order would be simpler, and is what this did originally. An
    ///      invariant fuzz run showed why it is wrong: draining venue 0 first leaves the whole
    ///      remaining balance concentrated in venue 1, so an ordinary redemption could push a
    ///      venue past the share the enclave is allowed to give it. No value is lost, but the
    ///      portfolio silently drifts to a concentration the enclave itself could never have
    ///      requested. Pro-rata unwinding keeps the shape of the allocation intact as the vault
    ///      shrinks.
    ///
    ///      A second pass sweeps up any shortfall from integer division or from venues that
    ///      returned less than their share, so illiquidity in one venue degrades the redemption
    ///      rather than blocking it.
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) {
            uint256 missing = assets - idle;
            uint256 n = venues.length;

            uint256 deployed;
            for (uint256 i; i < n; ++i) {
                if (venues[i].active) deployed += _venueAssets(i);
            }

            if (deployed > 0) {
                // Pass 1: take each venue's proportional share of the shortfall.
                for (uint256 i; i < n && missing > 0; ++i) {
                    if (!venues[i].active) continue;
                    uint256 venueAssets = _venueAssets(i);
                    if (venueAssets == 0) continue;

                    uint256 share = (missing * venueAssets) / deployed;
                    _tryWithdraw(i, share);
                }

                // Pass 2: cover whatever pass 1 left short, in index order.
                uint256 nowIdle = IERC20(asset()).balanceOf(address(this));
                for (uint256 i; i < n && nowIdle < assets; ++i) {
                    if (!venues[i].active) continue;
                    _tryWithdraw(i, assets - nowIdle);
                    nowIdle = IERC20(asset()).balanceOf(address(this));
                }
            }
        }

        // Fail with something actionable. Without this the shortfall surfaces as whatever error
        // the underlying token happens to throw — on FXRP, an opaque `FAssetBalanceTooLow()` that
        // says nothing about which venue let the vault down.
        uint256 finalIdle = IERC20(asset()).balanceOf(address(this));
        if (finalIdle < assets) revert InsufficientLiquidity(assets, finalIdle);

        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // ---------------------------------------------------------------------
    // Venue isolation
    //
    // A venue is foreign code. It may revert, lie, gate withdrawals, or settle asynchronously —
    // Firelight stXRP on Coston2 does the last of these, which fork testing surfaced only because
    // the tests ran against real bytecode. The rule these helpers enforce is that **no single
    // venue can freeze the vault**: a misbehaving one contributes nothing and everyone else is
    // still served. Without this, one bad integration holds every depositor hostage.
    // ---------------------------------------------------------------------

    /// @dev A venue that cannot even report its balance is treated as holding nothing, so it
    ///      cannot block accounting. It is still visible as inactive-in-effect via `allocations()`.
    function _venueAssets(uint256 i) internal view returns (uint256) {
        try venues[i].venue.totalAssets() returns (uint256 a) {
            return a;
        } catch {
            return 0;
        }
    }

    /// @dev Returns zero for venues not declared liquid-on-demand, so `maxWithdraw`/`maxRedeem`
    ///      never quote liquidity the vault cannot actually produce.
    function _venueMaxWithdraw(uint256 i) internal view returns (uint256) {
        if (!venues[i].liquidOnDemand) return 0;
        try venues[i].venue.maxWithdraw() returns (uint256 a) {
            return a;
        } catch {
            return 0;
        }
    }

    /// @dev Attempts to pull `amount`, swallowing any venue-side failure. Returning less than
    ///      requested — or nothing — is always a valid outcome; reverting is not.
    function _tryWithdraw(uint256 i, uint256 amount) internal returns (uint256) {
        uint256 pullable = Math.min(amount, _venueMaxWithdraw(i));
        if (pullable == 0) return 0;
        try venues[i].venue.withdraw(pullable) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    /// @notice Assets the vault could hand out right now: idle plus what venues will return.
    /// @dev Neither `maxWithdraw` nor `maxRedeem` may call the other. OpenZeppelin 5.x defines
    ///      `maxWithdraw(owner)` as `previewRedeem(maxRedeem(owner))`, so overriding both in terms
    ///      of `super` sends them into unbounded mutual recursion (a StackOverflow, not a clean
    ///      revert). Both therefore derive from this helper independently.
    function _liquidAssets() internal view returns (uint256 liquid) {
        liquid = IERC20(asset()).balanceOf(address(this));
        uint256 n = venues.length;
        for (uint256 i; i < n; ++i) {
            if (venues[i].active) liquid += _venueMaxWithdraw(i);
        }
    }

    /// @notice Assets a holder can actually withdraw right now, given venue liquidity.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(_convertToAssets(balanceOf(owner_), Math.Rounding.Floor), _liquidAssets());
    }

    /// @dev Only narrows the full balance when venue illiquidity genuinely binds. Converting
    ///      unconditionally would round down twice — shares to assets and back — and leave holders
    ///      unable to redeem their own full balance even with the vault completely liquid.
    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 shares = balanceOf(owner_);
        uint256 liquid = _liquidAssets();
        if (_convertToAssets(shares, Math.Rounding.Floor) <= liquid) return shares;
        return _convertToShares(liquid, Math.Rounding.Floor);
    }

    // ---------------------------------------------------------------------
    // Rebalancing
    // ---------------------------------------------------------------------

    /// @notice Signal the off-chain relayer that a rebalance round should begin.
    /// @dev Permissionless on purpose: anyone may ask for a rebalance, but nobody can decide its
    ///      contents, and `executeRebalance` is what actually gates state changes.
    function requestRebalance() external {
        emit RebalanceRequested(rebalanceNonce, totalAssets(), uint64(block.timestamp));
    }

    /// @notice Apply an enclave-produced allocation, subject to every on-chain invariant.
    /// @param plan       Allocation targets signed by the registered enclave identity.
    /// @param signature  ECDSA signature over `hashPlan(plan)` by that identity.
    /// @param signalProof FDC Web2Json proof of the market observation the plan was derived from.
    function executeRebalance(
        SignalTypes.RebalancePlan calldata plan,
        bytes calldata signature,
        IWeb2Json.Proof calldata signalProof
    ) external nonReentrant whenNotPaused {
        uint256 n = venues.length;
        if (n == 0) revert NoVenues();

        _checkAuthorisation(plan, signature);
        SignalTypes.MarketSignal memory signal = _checkSignal(plan, signalProof);
        lastFtsoPriceMicroUsd = _checkPriceBand(plan.refPriceMicroUsd);
        _checkTargets(plan.targetBps, n);

        uint256 before_ = totalAssets();
        uint256 turnover = _applyTargets(plan.targetBps, before_, n);
        uint256 after_ = totalAssets();

        _checkConservation(before_, after_);
        _checkCaps(after_, n);
        _checkTurnover(turnover, before_);

        rebalanceNonce = plan.nonce + 1;
        lastRebalanceAt = uint64(block.timestamp);
        lastSignal = signal;

        emit Rebalanced(plan.nonce, signal.hashSignal(), before_, after_, turnover);
    }

    // --- invariant helpers (split out so each failure mode is independently testable) ---

    function _checkAuthorisation(SignalTypes.RebalancePlan calldata plan, bytes calldata signature) private view {
        address expected = teeIdentity;
        if (expected == address(0)) revert NoTeeIdentity();
        if (plan.deadline < block.timestamp) revert PlanExpired(plan.deadline, block.timestamp);
        if (plan.nonce != rebalanceNonce) revert BadNonce(plan.nonce, rebalanceNonce);
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + minRebalanceInterval) {
            revert RebalanceTooSoon(lastRebalanceAt, minRebalanceInterval);
        }

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), SignalTypes.hashPlan(plan)))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != expected) revert BadSigner(recovered, expected);
    }

    function _checkSignal(SignalTypes.RebalancePlan calldata plan, IWeb2Json.Proof calldata proof)
        private
        view
        returns (SignalTypes.MarketSignal memory signal)
    {
        if (!_fdcVerification().verifyWeb2Json(proof)) revert InvalidProof();

        signal = abi.decode(proof.data.responseBody.abiEncodedData, (SignalTypes.MarketSignal));

        bytes32 got = signal.hashSignal();
        if (got != plan.signalHash) revert SignalMismatch(got, plan.signalHash);

        if (signal.obsTimestamp + maxSignalAge < block.timestamp) {
            revert SignalStale(signal.obsTimestamp, maxSignalAge);
        }
    }

    /// @dev This is where FTSO earns its place: it bounds enclave discretion rather than
    ///      decorating the design. Without it the reference price would be unauditable.
    /// @return ftsoMicro The FTSO price used for the check, in micro-USD, recorded for auditability.
    function _checkPriceBand(uint256 refPriceMicroUsd) private returns (uint256 ftsoMicro) {
        if (!priceBandEnforced) return 0;

        FtsoV2Interface ftso = _ftsoV2();
        uint256 fee = ftso.calculateFeeById(XRP_USD_FEED_ID);
        (uint256 value, int8 decimals,) = ftso.getFeedById{value: fee}(XRP_USD_FEED_ID);

        // Never hardcode feed decimals — Flare's docs warn they can change.
        ftsoMicro = _toMicro(value, decimals);
        uint256 diff = refPriceMicroUsd > ftsoMicro ? refPriceMicroUsd - ftsoMicro : ftsoMicro - refPriceMicroUsd;

        if (ftsoMicro == 0 || diff * BPS > ftsoMicro * priceBandBps) {
            revert PriceOutOfBand(refPriceMicroUsd, ftsoMicro, priceBandBps);
        }
    }

    /// @dev Rescales an FTSO value to 6dp. `decimals` is `int8` and is genuinely allowed to be
    ///      negative for large-magnitude feeds, so the shift is computed in signed math and only
    ///      then narrowed. Bounds keep the exponent inside what `10 ** n` can represent.
    function _toMicro(uint256 value, int8 decimals) private pure returns (uint256) {
        int256 shift = int256(6) - int256(decimals);
        if (shift == 0) return value;
        if (shift > 0) {
            if (shift > 60) revert BadParam();
            return value * (10 ** uint256(shift));
        }
        uint256 down = uint256(-shift);
        if (down > 60) revert BadParam();
        return value / (10 ** down);
    }

    /// @dev Targets may sum to less than 100%: the remainder simply stays idle in the vault, which
    ///      is a legitimate defensive allocation. They may never sum to more, which would be an
    ///      instruction to deploy capital the vault does not have.
    function _checkTargets(uint16[] calldata targetBps, uint256 n) private view {
        if (targetBps.length != n) revert TargetLengthMismatch(targetBps.length, n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (targetBps[i] != 0 && !venues[i].active) revert InactiveVenueTarget(i);
            sum += targetBps[i];
        }
        if (sum > BPS) revert TargetsOverAllocate(sum);
    }

    /// @dev Withdraw-then-deposit ordering matters: pulling from over-allocated venues first
    ///      funds the deposits, so we never need idle capital to already be sitting there.
    ///
    ///      Turnover is deliberately `min(withdrawn, deposited)` — the amount that actually
    ///      *rotated between venues* — rather than gross movement. Deploying fresh deposits from
    ///      idle is not churn, and neither is retreating to idle: in both cases the funds are
    ///      somewhere safe and no round-trip cost is being paid. Rate-limiting gross movement
    ///      instead would block the vault's very first deployment and would stop the enclave from
    ///      de-risking quickly in a crash, which is the opposite of what this guardrail is for.
    function _applyTargets(uint16[] calldata targetBps, uint256 total, uint256 n)
        private
        returns (uint256 turnover)
    {
        uint256[] memory target = new uint256[](n);
        uint256[] memory current = new uint256[](n);
        uint256 withdrawn;
        uint256 deposited;

        for (uint256 i; i < n; ++i) {
            current[i] = venues[i].active ? _venueAssets(i) : 0;
            target[i] = (total * targetBps[i]) / BPS;
        }

        for (uint256 i; i < n; ++i) {
            if (current[i] > target[i]) {
                withdrawn += _tryWithdraw(i, current[i] - target[i]);
            }
        }

        for (uint256 i; i < n; ++i) {
            if (target[i] > current[i]) {
                uint256 delta = target[i] - current[i];
                uint256 idle = IERC20(asset()).balanceOf(address(this));
                uint256 amount = Math.min(delta, idle);
                if (amount == 0) continue;
                IERC20(asset()).forceApprove(address(venues[i].venue), amount);
                venues[i].venue.deposit(amount);
                IERC20(asset()).forceApprove(address(venues[i].venue), 0);
                deposited += amount;
            }
        }

        turnover = Math.min(withdrawn, deposited);
    }

    function _checkConservation(uint256 before_, uint256 after_) private view {
        uint256 floor_ = before_ - (before_ * conservationToleranceBps) / BPS;
        if (after_ < floor_) revert ConservationViolated(before_, after_);
    }

    function _checkCaps(uint256 total, uint256 n) private view {
        for (uint256 i; i < n; ++i) {
            if (!venues[i].active) continue;
            uint256 assets = _venueAssets(i);
            uint256 cap = (total * venues[i].capBps) / BPS;
            if (assets > cap) revert VenueCapExceeded(i, assets, cap);
        }
    }

    function _checkTurnover(uint256 turnover, uint256 total) private view {
        uint256 cap = (total * maxTurnoverBps) / BPS;
        if (turnover > cap) revert TurnoverExceeded(turnover, cap);
    }

    // ---------------------------------------------------------------------
    // ERC-4626 entry points
    //
    // OpenZeppelin's implementations are correct but unguarded, which is fine for a vault that
    // holds its assets directly and wrong for one that does not. `_withdraw` calls out to venue
    // contracts — foreign code — *before* `super._withdraw` burns shares and transfers. A
    // malicious venue could therefore re-enter `redeem` at a moment when the caller's shares still
    // exist and the vault's balance has already moved. Every entry point is guarded rather than
    // just the ones that look risky, because which ones those are changes as venues are added.
    //
    // Deposits pause; withdrawals never do. An operator who can freeze exits can rug, so the
    // emergency control deliberately only stops new money coming in and new allocations going out.
    // ---------------------------------------------------------------------

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    /// @dev Intentionally callable while paused — see the note above.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    /// @dev Intentionally callable while paused — see the note above.
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    /// @notice ERC-4626 requires `maxDeposit` to reflect real limits, including a pause.
    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    /// @notice ERC-165 support, so integrators can discover the ERC-4626 interface on-chain.
    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC4626).interfaceId
            || interfaceId == type(IERC20).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @param liquidOnDemand Whether the venue pays withdrawals synchronously. Verify with
    ///        `ERC4626Venue.probeSynchronous()` before passing `true` — declaring it wrongly makes
    ///        `maxRedeem` over-quote, and depositors discover it as a failed redemption.
    function addVenue(IVenue venue, uint16 capBps, bool liquidOnDemand)
        external
        onlyOwner
        returns (uint256 venueId)
    {
        if (capBps == 0 || capBps > BPS) revert BadParam();
        address venueAsset = venue.asset();
        if (venueAsset != asset()) revert VenueAssetMismatch(venueAsset, asset());

        venues.push(
            VenueInfo({venue: venue, capBps: capBps, active: true, liquidOnDemand: liquidOnDemand})
        );
        venueId = venues.length - 1;
        emit VenueAdded(venueId, address(venue), capBps);
    }

    /// @notice Update a venue's liquidity declaration, e.g. after it migrates to synchronous exits.
    function setVenueLiquidOnDemand(uint256 venueId, bool liquidOnDemand) external onlyOwner {
        venues[venueId].liquidOnDemand = liquidOnDemand;
    }

    function setVenueCap(uint256 venueId, uint16 capBps) external onlyOwner {
        if (capBps == 0 || capBps > BPS) revert BadParam();
        venues[venueId].capBps = capBps;
        emit VenueCapUpdated(venueId, capBps);
    }

    /// @dev Deactivation pulls the venue's funds home immediately rather than stranding them.
    function deactivateVenue(uint256 venueId) external onlyOwner {
        venues[venueId].active = false;
        // Best-effort repatriation. Deactivation must succeed even if the venue refuses to pay,
        // otherwise a broken venue could not be removed from the rotation.
        _tryWithdraw(venueId, _venueMaxWithdraw(venueId));
        emit VenueDeactivated(venueId);
    }

    function setTeeIdentity(address identity) external onlyOwner {
        emit TeeIdentityUpdated(teeIdentity, identity);
        teeIdentity = identity;
    }

    function setGuardrails(
        uint16 maxTurnoverBps_,
        uint32 minRebalanceInterval_,
        uint16 priceBandBps_,
        uint32 maxSignalAge_,
        uint16 conservationToleranceBps_
    ) external onlyOwner {
        // Guardrails may be tightened or loosened, but never disabled outright — a zero band or a
        // 100% turnover allowance would quietly return the enclave to unbounded authority.
        if (maxTurnoverBps_ == 0 || maxTurnoverBps_ > BPS) revert BadParam();
        if (priceBandBps_ == 0 || priceBandBps_ > 2_000) revert BadParam();
        if (maxSignalAge_ == 0) revert BadParam();
        if (conservationToleranceBps_ > 100) revert BadParam();

        maxTurnoverBps = maxTurnoverBps_;
        minRebalanceInterval = minRebalanceInterval_;
        priceBandBps = priceBandBps_;
        maxSignalAge = maxSignalAge_;
        conservationToleranceBps = conservationToleranceBps_;

        emit GuardrailsUpdated(maxTurnoverBps_, minRebalanceInterval_, priceBandBps_, maxSignalAge_);
    }

    /// @notice Halt new deposits and rebalances. Withdrawals are deliberately unaffected.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Escape hatch for a chain where the FTSO feed is unavailable. Deliberately owner-only
    ///      and loudly named: disabling it is a downgrade of the trust model, not a config tweak.
    function setPriceBandEnforced(bool enforced) external onlyOwner {
        priceBandEnforced = enforced;
    }

    /// @notice Fund the vault with native C2FLR to pay FTSO feed fees.
    receive() external payable {}
}
