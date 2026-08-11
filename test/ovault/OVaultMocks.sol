// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    SendParam,
    MessagingFee,
    MessagingReceipt,
    OFTReceipt
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";

/// @dev Test doubles for the LayerZero surface `TacitOVaultComposer` touches.
///
/// These live under `test/` rather than in `src/mocks/Mocks.sol` — the house convention for the
/// vault's own mocks — on purpose. `src/` is what gets deployed and what `forge build --sizes`
/// reports on; LayerZero scaffolding belongs to neither.
///
/// The alternative was LayerZero's `test-devtools-evm-foundry` (`TestHelperOz5`), which simulates
/// endpoints, DVNs and executors end to end. It is not installed, and it would not help: LayerZero's
/// own ovault mocks wrap the real `OFT` / `OFTAdapter`, so they need a real endpoint to construct.
/// What the composer actually requires is much smaller, and is fully determined by
/// `VaultComposerSync`'s constructor and send paths:
///
///   - the endpoint: `eid()`, plus `setDelegate()` because `OAppCore`'s constructor calls it
///     unconditionally and the real share adapter cannot be built otherwise;
///   - an OFT: `token()`, `approvalRequired()`, `send()`, `quoteSend()`, and `endpoint()` on the
///     asset side only (`ENDPOINT` is read from `ASSET_OFT`).
///
/// `lzCompose` is called *on* the composer *by* the endpoint, so a test only needs to prank as the
/// endpoint. No message routing is simulated, and none is needed.

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

/// @notice The two endpoint methods anything in this port actually calls.
contract MockLzEndpoint {
    /// @dev A public immutable yields the `eid()` getter `ILayerZeroEndpointV2` declares.
    uint32 public immutable eid;

    mapping(address oapp => address delegate) public delegates;

    constructor(uint32 _eid) {
        eid = _eid;
    }

    /// @dev `OAppCore`'s constructor calls this and reverts on a zero delegate, so it has to exist
    ///      for `TacitShareOFTAdapter` to be constructible at all.
    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }
}

// ---------------------------------------------------------------------------
// OFT
// ---------------------------------------------------------------------------

/// @notice A minimal OFT stand-in that records what it was asked to send.
///
/// @dev Deliberately does *not* declare `is IOFT`: that would force all seven interface methods
///      including `quoteOFT` and `oftVersion`, which the composer never calls. The composer calls
///      through `IOFT(addr)`, so matching selectors is sufficient.
///
///      `token` and `approvalRequired` are constructor parameters rather than fixed, because
///      `VaultComposerSync`'s constructor gates on both — one instance can be pointed at the wrong
///      token, or made to claim it is mint-burn, to exercise each of the three revert paths.
contract MockOFT {
    using SafeERC20 for IERC20;

    error MockSendFailed();

    /// @dev `OFTAdapter.token()` returns the underlying; a public immutable gives the same getter.
    address public immutable token;
    address public immutable endpoint;
    bool public immutable approvalRequired;

    /// @notice When set, every `send` reverts — the only failure a refund path needs.
    /// @dev One flag covers `_refund`'s catch branch: a compose that reaches `_refund` has already
    ///      failed inside `handleCompose`, so exactly one send happens in that flow.
    bool public failSends;

    uint256 public quotedNativeFee = 0.001 ether;

    /// @dev Held in a private var with an explicit getter, not `public`: an auto-generated getter for
    ///      a struct with `bytes` members silently omits those members, and `composeMsg` /
    ///      `extraOptions` are exactly what some assertions need to see.
    SendParam private _lastSendParam;

    uint256 public lastMsgValue;
    address public lastRefundAddress;
    uint256 public sendCount;

    constructor(address _token, address _endpoint, bool _approvalRequired) {
        token = _token;
        endpoint = _endpoint;
        approvalRequired = _approvalRequired;
    }

    function setFailSends(bool _failSends) external {
        failSends = _failSends;
    }

    function setQuotedNativeFee(uint256 _fee) external {
        quotedNativeFee = _fee;
    }

    function lastSendParam() external view returns (SendParam memory) {
        return _lastSendParam;
    }

    /// @dev Pulls the tokens the way a real adapter does, which is what makes the composer's
    ///      `forceApprove` in `_initializeAssetToken` / `_initializeShareToken` load-bearing in
    ///      these tests rather than incidental.
    function send(SendParam calldata _sendParam, MessagingFee calldata _fee, address _refundAddress)
        external
        payable
        returns (MessagingReceipt memory, OFTReceipt memory)
    {
        if (failSends) revert MockSendFailed();

        IERC20(token).safeTransferFrom(msg.sender, address(this), _sendParam.amountLD);

        _lastSendParam = _sendParam;
        lastMsgValue = msg.value;
        lastRefundAddress = _refundAddress;
        sendCount += 1;

        return (
            MessagingReceipt({guid: keccak256(abi.encodePacked(sendCount)), nonce: uint64(sendCount), fee: _fee}),
            OFTReceipt({amountSentLD: _sendParam.amountLD, amountReceivedLD: _sendParam.amountLD})
        );
    }

    function quoteSend(SendParam calldata, bool) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: quotedNativeFee, lzTokenFee: 0});
    }
}

// ---------------------------------------------------------------------------
// Hostile counterparties
// ---------------------------------------------------------------------------

/// @notice Rejects native. No `receive`, no `fallback`, so any value-bearing call to it reverts.
/// @dev Stands in for the real case the composer's `rescueNative` exists for: a recovery address
///      that turns out to be a contract which cannot take native.
contract NativeRejecter {
    function ping() external pure returns (bool) {
        return true;
    }
}

/// @dev Just enough of the composer to call it from another contract.
interface IComposerEntrypoint {
    function depositAndSend(uint256 assetAmount, SendParam memory sendParam, address refundAddress) external payable;
}

/// @notice Calls `depositAndSend` and rejects the native refund.
///
/// @dev `_sendLocal` refunds to `_refundAddress` and falls back to `msg.sender`. Proving the fallback
///      is reachable is easy; proving it can *also* fail needs a caller that is itself a contract
///      without a `receive`. That is this: both legs of the refund reject native, so the deposit must
///      revert rather than silently strand the value.
///
///      Holds no native of its own — `vm.deal` writes the balance directly, which is the only way to
///      fund a contract that cannot be paid.
contract RejectingCaller {
    function deposit(address _composer, address _asset, uint256 _amount, SendParam memory _sendParam, uint256 _value)
        external
    {
        IERC20(_asset).approve(_composer, type(uint256).max);
        IComposerEntrypoint(_composer).depositAndSend{value: _value}(_amount, _sendParam, address(this));
    }
}

/// @notice Accepts native, and uses the callback to try to re-enter the composer.
///
/// @dev `TacitOVaultComposer._sendLocal` refunds unspent native to `_refundAddress` — a value the
///      caller chooses — and falls back to `msg.sender`. Either way it hands control to an arbitrary
///      address part-way through a deposit, which is a callback surface the base contract does not
///      have. So it gets tested rather than assumed safe: point a refund address at this contract
///      and it will try to call back in while the first call is still on the stack.
contract ReentrantOrigin {
    address public composer;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public reentryError;

    bytes private _payload;

    function arm(address _composer, bytes calldata _lzComposePayload) external {
        composer = _composer;
        _payload = _lzComposePayload;
    }

    receive() external payable {
        if (composer == address(0)) return;

        attempted = true;
        (bool ok, bytes memory err) = composer.call(_payload);
        reentrySucceeded = ok;
        reentryError = err;
    }
}

/// @notice A share token whose `transfer` can be made to fail for a chosen address.
///
/// @dev `TacitShareOFTAdapter._credit` exists because an inbound delivery can name a recipient the
///      unlock transfer cannot reach. The real `TacitVault` has no way to produce that: it is a plain
///      OpenZeppelin ERC-20, so the only recipient it rejects is `address(0)`. That covers one branch
///      of `_tryTransfer` and leaves two untested — a token that *reverts* on transfer, and one that
///      returns `false` without reverting. Both are ordinary in production ERC-20s (blocklists,
///      freeze lists, sanctions hooks, and the older no-revert tokens), and both are exactly what the
///      fallback is for. This token produces them on demand.
///
///      `decimals` is a constructor parameter so the same contract can also stand in for a share
///      token too coarse for LayerZero's 6 shared decimals, which `OFTCore` must reject.
contract HostileShareToken is ERC20 {
    error Blocked(address to);

    uint8 private immutable _decimals;

    /// @notice `transfer` to these addresses reverts.
    mapping(address holder => bool isBlocked) public blocked;

    /// @notice `transfer` to these addresses returns `false` and moves nothing.
    mapping(address holder => bool doesFailSilently) public failsSilently;

    constructor(uint8 decimals_) ERC20("Hostile tFXRP", "htFXRP") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }

    function setBlocked(address _holder, bool _isBlocked) external {
        blocked[_holder] = _isBlocked;
    }

    function setFailsSilently(address _holder, bool _doesFailSilently) external {
        failsSilently[_holder] = _doesFailSilently;
    }

    function transfer(address _to, uint256 _amount) public override returns (bool) {
        if (blocked[_to]) revert Blocked(_to);
        if (failsSilently[_to]) return false;
        return super.transfer(_to, _amount);
    }
}
