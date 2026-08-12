// Tacit UI — reads everything from the chain, writes only deposit/withdraw/requestRebalance.
//
// Deliberately zero-build: one ES module, ethers from a CDN, `python3 -m http.server` to serve.
// A hackathon UI that needs a toolchain is a UI that breaks in the demo.
//
// Two rules the display follows, because the whole pitch depends on them being honest:
//   1. Never present the enclave's word as fact — show the *attested* inputs and the *on-chain*
//      guardrails, both of which anyone can independently verify.
//   2. Never hide the simulated-attestation caveat.

import { ethers } from "https://esm.sh/ethers@6.13.4";

// ── config ──────────────────────────────────────────────────

const COSTON2 = {
  chainId: "0x72", // 114
  chainName: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: ["https://coston2-api.flare.network/ext/C/rpc"],
  blockExplorerUrls: ["https://coston2-explorer.flare.network"],
};

// Resolved in this order: ?vault= query param, then deployments.json, then empty.
// `?rpc=` overrides the read endpoint, which is what makes the page testable against a local
// anvil fork without touching the code.
const params = new URLSearchParams(location.search);
let VAULT_ADDRESS = params.get("vault") || "";
const RPC_URL = params.get("rpc") || "https://coston2-api.flare.network/ext/C/rpc";

// The autopilot's status endpoint, resolved the same way. Optional by design: it is the daemon's
// own view of itself, never a source of truth, and every number on this page stays correct when it
// is missing or unreachable.
let AUTOPILOT_URL = params.get("autopilot") || "";

// ── the second chain ────────────────────────────────────────
//
// The vault lives on Coston2 and only ever lives there. What the spoke adds is a second *entrance*:
// a LayerZero OFT on Base Sepolia whose `send()` carries a compose message, so one signature on
// Base Sepolia burns the FXRP mirror there, releases real FXRP from escrow on Coston2, and has the
// composer run `vault.deposit()` — with the depositor holding no Coston2 gas at any point.
//
// Everything about that route is read from deployments.json rather than hardcoded, so a redeploy of
// either side is a config change. Null until `boot()` loads it; every spoke-dependent branch checks.
let SPOKE = null;
let COMPOSER_ADDRESS = "";
let HUB_EID = 40294;
let LZ_SCAN = "https://testnet.layerzeroscan.com";
let HUB_EXPLORER = COSTON2.blockExplorerUrls[0];

// Which entrance the deposit tab is currently pointed at: "hub" | "spoke".
//
// Persisted in sessionStorage because `chainChanged` reloads the page (see `boot()`), and switching
// the wallet to Base Sepolia is *exactly* the moment this must not reset — a picker that snaps back
// to Coston2 the instant you follow its own instruction is worse than no picker.
let source = sessionStorage.getItem("tacit.source") === "spoke" ? "spoke" : "hub";
if (params.get("source") === "spoke") source = "spoke";
if (params.get("source") === "hub") source = "hub";

/// The chain the selected source signs on, in `wallet_addEthereumChain` shape.
function sourceChain() {
  if (source === "spoke" && SPOKE) {
    return {
      chainId: `0x${SPOKE.chainId.toString(16)}`,
      chainName: SPOKE.name,
      nativeCurrency: { name: SPOKE.nativeName, symbol: SPOKE.nativeSymbol, decimals: 18 },
      rpcUrls: [SPOKE.rpc],
      blockExplorerUrls: [SPOKE.explorer],
    };
  }
  return COSTON2;
}

/// The native-token symbol the wallet needs to sign the selected source's transactions.
/// Named because two labels on the page ("… gas", available line) both key off this and drift
/// apart the moment either is inlined.
function sourceGasSymbol() {
  return source === "spoke" && SPOKE ? SPOKE.nativeSymbol : COSTON2.nativeCurrency.symbol;
}

/// True when the cross-chain entrance is both selected and actually configured. Every write path
/// asks this rather than reading `source` directly, so a missing spoke block degrades to the hub
/// route instead of throwing on `SPOKE.assetOFT`.
const viaSpoke = () => source === "spoke" && SPOKE !== null && mode === "deposit";

const VAULT_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  // Used to floor the cross-chain deposit: the composer's inner hop carries a `minAmountLD` in
  // shares, and quoting it from the vault is the only way to make that floor mean anything.
  "function previewDeposit(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function venueCount() view returns (uint256)",
  "function venues(uint256) view returns (address venue, uint16 capBps, bool active, bool liquidOnDemand)",
  "function allocations() view returns (uint256[] assetsPerVenue, uint256 idle)",
  "function teeIdentity() view returns (address)",
  "function rebalanceNonce() view returns (uint256)",
  "function lastRebalanceAt() view returns (uint64)",
  "function maxTurnoverBps() view returns (uint16)",
  "function minRebalanceInterval() view returns (uint32)",
  "function priceBandBps() view returns (uint16)",
  "function maxSignalAge() view returns (uint32)",
  "function conservationToleranceBps() view returns (uint16)",
  "function lastFtsoPriceMicroUsd() view returns (uint256)",
  "function lastSignal() view returns (uint256 priceMicroUsd, uint256 volume24hUsd, int256 change1hBps, int256 change6hBps, int256 change24hBps)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function requestRebalance()",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const VENUE_ABI = [
  "function ratePerYearBps() view returns (uint256)",
  "function liquidityBps() view returns (uint16)",
];

// The spoke's FXRP mirror, as much of LayerZero's OFT surface as one deposit needs.
//
// `SendParam` is a struct, and its `amountLD`/`minAmountLD` are in *local* decimals while the wire
// format carries `sharedDecimals` (6) — which matters here because the share leg is 9dp, so the
// inner hop's floor gets truncated to a 1000-unit granularity. Deposits themselves are 6dp FXRP on
// both sides, so the outer send never truncates.
const OFT_ABI = [
  "function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))",
  "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee), (uint256 amountSentLD, uint256 amountReceivedLD))",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// The tuple the composer decodes out of `composeMsg`. Must match `VaultComposerSync`'s expectation
// exactly — an encoding mismatch does not revert on the spoke, it strands the message on the hub.
const SEND_PARAM_TUPLE =
  "(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)";

// Tolerance applied to `previewDeposit` when flooring the inner hop, in basis points.
//
// Not slippage in the AMM sense — an ERC-4626 deposit has no price impact. It absorbs the exchange
// rate moving between quote and execution: yield accrues, and a rebalance can land in between. 50bps
// is generous for a minute-scale window, and the floor still catches the case that matters, which is
// the share price having moved by orders of magnitude rather than fractions of a percent.
const DEPOSIT_TOLERANCE_BPS = 50n;

// ── state ───────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// Reads and writes are deliberately kept on separate providers.
//
// Binding reads to the wallet's provider looks harmless and is the obvious thing to do, but it
// means the page silently starts querying whatever chain the wallet happens to be on. Point it at
// an address that exists on one chain and connect a wallet on another and every call decodes empty
// calldata — surfacing as "could not decode result data", which names neither the address nor the
// chain and sends you looking in the wrong place entirely.
let provider, signer, account;
let vaultRead, vaultWrite, assetRead, assetWrite;
let assetDecimals = 6;
// Kept for `wallet_watchAsset`, which needs the token's real on-chain symbol and decimals rather
// than the "FXRP" the page prints.
let assetAddress = "";
let assetSymbol = "FXRP";
const readProvider = new ethers.JsonRpcProvider(RPC_URL);

// Presentation state. Every value here is a cache of something already fetched for another
// purpose — the tabs and the receive preview add no round trips of their own.
let mode = "deposit"; // which tab is showing: "deposit" | "withdraw"
let walletAssets = null; // FXRP in the wallet, cached from refreshFunding()
let withdrawable = null; // maxWithdraw(account), cached from refresh()
let sharePriceText = "—"; // assets per whole share, cached from refresh()
let shareSymbol = "shares"; // the vault's own ERC-20 symbol, read once in wire()

// Spoke-side handles. The read provider is its own JSON-RPC connection to Base Sepolia, for the
// same reason the hub's is: the funding panel has to be able to show a spoke balance while the
// wallet is still sitting on Coston2, which is precisely the state a first-time depositor is in.
let spokeReadProvider = null;
let spokeAssetRead = null; // OFT bound to spokeReadProvider — balances and fee quotes
let spokeAssetWrite = null; // OFT bound to the signer — the one send() the deposit needs
let spokeAssets = null; // FXRP mirror held on the spoke, cached from refreshFunding()
let spokeNative = null; // ETH on the spoke, cached from refreshFunding()
let bridgeFeeText = "—"; // last quoted LayerZero fee, cached for renderReceive()
let quoteSeq = 0; // guards against a slow fee quote overwriting a newer one
let bridgeFeeWei = null; // last quoted native fee, kept so deposit() does not re-quote
let quoteTimer = null; // debounce handle for renderReceive → refreshBridgeFee

// ── formatting ──────────────────────────────────────────────

const fmtUnits = (v, d = assetDecimals, places = 2) =>
  Number(ethers.formatUnits(v, d)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });

const fmtMicro = (v, places = 6) =>
  `$${(Number(v) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`;

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function timeAgo(ts) {
  if (!ts) return "never";
  const secs = Math.floor(Date.now() / 1000) - Number(ts);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// The hero line is derived, not decorative. "Active" is a claim the app can only make when an
// enclave identity is on record; with none registered the honest state is "not configured", and
// once one exists but no rebalance has ever run, the honest state is "armed, waiting for the
// first rebalance". Both are ordinary testnet states — the enclave is registered out-of-band by
// the operator, and the vault starts at `lastRebalanceAt == 0` — so neither is treated as an
// error; the dot matches the label rather than dressing every state in the same green.
function renderHeroStatus(teeIdentity, lastAt) {
  let text;
  let state;
  if (teeIdentity === ethers.ZeroAddress) {
    text = "Strategy not configured";
    state = "warn";
  } else if (Number(lastAt) === 0) {
    text = "Strategy armed";
    state = "idle";
  } else {
    text = "Strategy active";
    state = "good";
  }
  // The Vault and Strategy pages both carry a hero-status widget; each has its own IDs because
  // duplicate IDs would break getElementById. Both are written here so whichever page is currently
  // visible shows the same verdict without cross-page copying.
  for (const [labelId, dotId] of [["hero-status-label", "hero-dot"], ["strategy-status-label", "strategy-dot"]]) {
    const l = $(labelId), d = $(dotId);
    if (l) l.textContent = text;
    if (d) d.className = `dot dot-${state}`;
  }
}

function setStatus(msg, kind = "") {
  const el = $("tx-status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

// A button with a transaction in flight is not a disabled button — the wallet is open and
// something is happening. The label lives in `data-busy` because the CSS renders it through
// `content: attr(data-busy)`, which keeps the button's width from jumping mid-transaction.
//
// The prior `disabled` state is captured and restored rather than assumed false: `refresh()`
// owns whether Withdraw is clickable, and a finished transaction must not override it.
function setBusy(id, label) {
  const el = $(id);
  if (!el) return;
  if (label) {
    if (el.dataset.wasDisabled === undefined) el.dataset.wasDisabled = el.disabled ? "1" : "0";
    el.dataset.busy = label;
    el.classList.add("is-busy");
    el.disabled = true;
    return;
  }
  el.classList.remove("is-busy");
  delete el.dataset.busy;
  if (el.dataset.wasDisabled !== undefined) {
    el.disabled = el.dataset.wasDisabled === "1";
    delete el.dataset.wasDisabled;
  }
}

// The page repaints every 15s whether or not anything moved. Writing unconditionally makes a
// live number indistinguishable from a frozen one, so only changes are written — and a change
// gets a one-shot tick so the eye is drawn to it.
function setValue(id, text) {
  const el = $(id);
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("is-fresh");
  void el.offsetWidth; // forces the animation to restart rather than being ignored as a no-op
  el.classList.add("is-fresh");
}

// ── deposit / withdraw panel ────────────────────────────────

/// Switches the panel between depositing and withdrawing.
///
/// This is presentation only. Both actions were always available — they were two buttons stacked
/// in one panel, each with its own meaning for "Max" and its own idea of what you get back, and
/// nothing on the page said which was which. The tab makes the current action explicit and lets
/// the fields around it describe that one action honestly instead of describing both vaguely.
function setMode(next) {
  if (next !== "deposit" && next !== "withdraw") return;
  mode = next;

  for (const id of ["tab-deposit", "tab-withdraw"]) {
    const tab = $(id);
    const on = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  }
  // The panel is one tabpanel serving both tabs, so its label has to follow the selected tab or a
  // screen reader announces the wrong action for it.
  $("action-panel").setAttribute("aria-labelledby", `tab-${mode}`);

  $("deposit").classList.toggle("is-hidden", mode !== "deposit");
  $("withdraw").classList.toggle("is-hidden", mode !== "withdraw");
  $("withdraw-note").hidden = mode !== "withdraw";
  // Withdrawals are hub-only, so the source picker is hidden rather than shown greyed out —
  // an option that can never apply is not an option.
  const picker = $("source-picker");
  if (picker) picker.classList.toggle("is-hidden", mode !== "deposit");

  renderAvailable();
  renderReceive();
  refreshFunding().catch(() => {});
}

/// Switches the deposit route between the hub (Coston2) and the spoke (Base Sepolia).
///
/// Everything downstream reads from `source`, `viaSpoke()` and the spoke config — no branch
/// duplicates the state — so this just flips the switch and lets the panel repaint itself.
/// Persisted in sessionStorage because switching the wallet to Base Sepolia reloads the page,
/// and a picker that snapped back to Coston2 the instant the wallet followed its instruction
/// would be worse than no picker.
function setSource(next) {
  if (next !== "hub" && next !== "spoke") return;
  if (next === "spoke" && !SPOKE) {
    setStatus("No spoke configured. Deposit from Coston2, or add a spoke to deployments.json.", "error");
    return;
  }
  source = next;
  sessionStorage.setItem("tacit.source", source);

  for (const id of ["source-hub", "source-spoke"]) {
    const btn = $(id);
    if (!btn) continue;
    const on = btn.dataset.source === source;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // The unit next to the amount input stays "FXRP" — both routes deposit FXRP — but the funding
  // panel and the button labels change with the source.
  updateSourceLabels();
  renderAvailable();
  renderReceive();
  depositReady();
  refreshFunding().catch(() => {});

  // If a wallet is already connected but on the wrong chain for the newly-picked source, offer
  // the switch here rather than at deposit-click time. Doing it here means the button below is
  // enabled *before* the user reaches for it, instead of being greyed out with no explanation.
  ensureWalletOnSource().catch(() => {});
}

/// Prompts the wallet to switch to the currently-selected source's chain, if it is not already.
///
/// A `chainChanged` event fires after the switch and reloads the page (see `boot()`); the silent
/// reconnect on the next load restores account + write handles without a second popup, so this
/// costs the user exactly one signature — not two — to move between routes.
async function ensureWalletOnSource() {
  if (!signer || !window.ethereum) return;
  const target = sourceChain();
  const targetId = parseInt(target.chainId, 16);
  const current = await provider.getNetwork();
  if (Number(current.chainId) === targetId) return;
  try {
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [target] });
  } catch { /* already known, or user declined the add — the switch below can still succeed */ }
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: target.chainId }],
  });
}

/// Updates every label that depends on which chain the deposit signs on. Kept in one place so
/// the network indicator, funding pill and deposit note cannot drift apart when the source flips.
function updateSourceLabels() {
  const spoke = viaSpoke();
  const netName = $("network-name");
  const netEnv = $("network-env");
  const balGasSymbol = $("bal-gas-symbol");
  const balFxrpWhere = $("bal-fxrp-where");
  const depositNote = $("deposit-note");
  const depositBtn = $("deposit");
  const faucetLink = $("faucet-link");

  if (spoke && SPOKE) {
    if (netName) netName.textContent = SPOKE.name;
    if (netEnv) netEnv.textContent = "Deposit chain";
    if (balGasSymbol) balGasSymbol.textContent = SPOKE.nativeSymbol;
    if (balFxrpWhere) balFxrpWhere.textContent = "on spoke";
    if (depositBtn) depositBtn.textContent = "Deposit from Base Sepolia";
    if (depositNote) depositNote.hidden = false;
    if (faucetLink) { faucetLink.href = SPOKE.faucet; faucetLink.textContent = "Base Sepolia faucet ↗"; }
  } else {
    if (netName) netName.textContent = "Coston2";
    if (netEnv) netEnv.textContent = "Vault chain";
    if (balGasSymbol) balGasSymbol.textContent = "C2FLR";
    if (balFxrpWhere) balFxrpWhere.textContent = "deposits";
    if (depositBtn) depositBtn.textContent = "Deposit";
    if (depositNote) depositNote.hidden = true;
    if (faucetLink) { faucetLink.href = "https://faucet.flare.network/coston2"; faucetLink.textContent = "Open faucet ↗"; }
  }
}

/// "Available" is a different number per action: what the wallet holds, or what the vault will
/// actually pay out right now. Both are already cached, so this costs no round trip.
///
/// When the deposit source is the spoke, "In wallet" quotes the FXRP mirror on Base Sepolia,
/// not the Coston2 balance — the latter is not what will be debited, and showing it would
/// promise a route that is not the one selected.
function renderAvailable() {
  const depositing = mode === "deposit";
  $("available-label").textContent = depositing ? "In wallet" : "Withdrawable";

  const amount = depositing
    ? (viaSpoke() ? spokeAssets : walletAssets)
    : withdrawable;
  $("available-amount").textContent =
    amount === null ? "—" : `${fmtUnits(amount)} FXRP`;
}

/// The live preview under the amount field.
///
/// Deliberately computed from the cached share price rather than by calling `convertToShares` on
/// every keystroke: a preview that fires an RPC per character is a preview that lags behind the
/// cursor, and the two agree to the precision shown here. The contract remains the authority — this
/// only says what to expect, and the transaction still quotes itself.
function renderReceive() {
  const label = $("receive-label");
  const value = $("receive-value");
  const price = $("receive-price");

  price.textContent = sharePriceText === "—" ? "—" : `${sharePriceText} FXRP`;
  label.textContent = mode === "deposit" ? "You receive" : "You redeem";

  const raw = $("amount").value.trim();
  const rate = Number(sharePriceText);

  // An unparseable or empty box is not an error state — it is the resting state of the field.
  if (!raw || !Number.isFinite(Number(raw)) || Number(raw) <= 0 || !Number.isFinite(rate) || rate <= 0) {
    value.textContent = "—";
    return;
  }

  const amount = Number(raw);
  if (mode === "deposit") {
    value.textContent = `${(amount / rate).toLocaleString(undefined, {
      minimumFractionDigits: 4, maximumFractionDigits: 4,
    })} ${shareSymbol}`;
  } else {
    value.textContent = `${amount.toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })} FXRP · ${(amount / rate).toLocaleString(undefined, {
      minimumFractionDigits: 4, maximumFractionDigits: 4,
    })} ${shareSymbol} burned`;
  }

  // The bridge-fee row is only meaningful for the spoke route. Debounce the quote — a fee that
  // fires an RPC per keystroke lags behind the cursor, and the number changes little between
  // characters of the same amount.
  const routeRow = $("receive-route-row");
  if (mode === "deposit" && viaSpoke()) {
    routeRow.classList.remove("is-hidden");
    $("receive-route").textContent = bridgeFeeText;
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => { refreshBridgeFee().catch(() => {}); }, 350);
  } else {
    routeRow.classList.add("is-hidden");
  }
}

// ── connection ──────────────────────────────────────────────

async function connect() {
  if (!window.ethereum) {
    setStatus("No injected wallet found. Install MetaMask to deposit.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    // The chain the wallet must be on depends on which route the user picked. Add-then-switch:
    // `wallet_addEthereumChain` is a no-op if the chain is already known, so this handles both
    // the first-time and returning cases without branching on error codes.
    const target = sourceChain();
    try {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [target] });
    } catch { /* already added, or user declined the add but may still be on the chain */ }
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target.chainId }],
    });

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();

    $("connect").textContent = shortAddr(account);
    $("network-pill").textContent = target.chainName;
    $("network-pill").className = "pill pill-good";
    $("copy-address").disabled = false;

    if (await wire()) await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

/// Returns true once read contracts are live. Fails loudly and specifically if they are not.
async function wire() {
  if (!VAULT_ADDRESS) return false;

  // Confirm a contract actually exists before calling into it, so the failure names the address
  // and the network instead of surfacing as an opaque decode error.
  const code = await readProvider.getCode(VAULT_ADDRESS);
  if (code === "0x") {
    const net = await readProvider.getNetwork().catch(() => null);
    setStatus(
      `No contract at ${shortAddr(VAULT_ADDRESS)} on ${net ? `chain ${net.chainId}` : RPC_URL}. ` +
      `Check the ?vault= and ?rpc= parameters — a local anvil address will not exist on Coston2.`,
      "error"
    );
    return false;
  }

  vaultRead = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, readProvider);
  const assetAddr = await vaultRead.asset();
  assetRead = new ethers.Contract(assetAddr, ERC20_ABI, readProvider);
  assetDecimals = Number(await assetRead.decimals());
  assetAddress = assetAddr;
  assetSymbol = await assetRead.symbol(); // `FTestXRP` on Coston2 — the wallet needs the real one

  // The share token's own symbol, so the receive preview names what the depositor actually gets
  // instead of a hardcoded guess. A vault need not expose one; fall back to the generic word.
  shareSymbol = await vaultRead.symbol().catch(() => "shares");

  // The page calls the token FXRP throughout, but the wallet will label it whatever the contract
  // says. Naming it here means the button and the wallet prompt agree.
  $("watch-fxrp").textContent = `Add ${assetSymbol} to wallet`;

  if (signer) {
    // Two chains are legitimate for writes now: Coston2 for the hub route, and the spoke for the
    // LayerZero deposit. So the check is not "same as the read chain" — it is "one of the two
    // this page knows about" — and it drives which contract handles are bound rather than gating
    // writes entirely. Withdraw and requestRebalance still require the hub; the deposit button
    // decides for itself which chain it needs based on the selected source.
    const walletNet = await provider.getNetwork();
    const walletId = Number(walletNet.chainId);

    vaultWrite = null;
    assetWrite = null;
    spokeAssetWrite = null;

    if (walletId === 114) {
      vaultWrite = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
      assetWrite = new ethers.Contract(assetAddr, ERC20_ABI, signer);
    } else if (SPOKE && walletId === SPOKE.chainId) {
      spokeAssetWrite = new ethers.Contract(SPOKE.assetOFT, OFT_ABI, signer);
    } else {
      setStatus(
        `Wallet is on chain ${walletId}, but the vault is on Coston2 (114)` +
        (SPOKE ? ` and the spoke is on ${SPOKE.name} (${SPOKE.chainId})` : "") + ". " +
        `Switch networks to deposit.`,
        "error"
      );
      return true; // reads still work; the buttons below decide their own gating
    }

    // Withdraw and requestRebalance are hub-only.
    $("withdraw").disabled = walletId !== 114;
    $("request-rebalance").disabled = walletId !== 114;
    // Deposit is enabled whenever a route matches the wallet. `depositReady()` recomputes this
    // on every source change so a mismatch is announced through the button, not by silent revert.
    depositReady();
  }
  return true;
}

/// Enables the deposit button only when the selected source matches the wallet's chain.
///
/// Split out because two things drive it (source picker click and wallet chain change) and both
/// need to stay in agreement — a "Deposit" button enabled while the wallet is on the wrong chain
/// fails at signature time with a message that names neither chain.
function depositReady() {
  const btn = $("deposit");
  if (!btn) return;
  if (!signer) { btn.disabled = true; return; }
  const spoke = viaSpoke();
  const ok = spoke ? !!spokeAssetWrite : !!vaultWrite;
  btn.disabled = !ok;
}

// ── reads ───────────────────────────────────────────────────

async function refresh() {
  if (!vaultRead) return;

  // A public RPC can take several seconds for the handful of round trips below. Without this the
  // panel keeps showing its initial placeholder while every other number on the page is already
  // live, which reads as a broken page rather than a slow one.
  const alloc = $("allocation");
  if (alloc.querySelector(".alloc-row") === null) {
    alloc.innerHTML = '<p class="empty">Loading allocation from Coston2…</p>';
  }

  try {
    const [
      totalAssets, teeIdentity, nonce, lastAt,
      venueCountA, turnoverBps, bandBps, signalAge, ftsoPrice, signal, venueCount, minInterval,
    ] = await Promise.all([
      vaultRead.totalAssets(), vaultRead.teeIdentity(), vaultRead.rebalanceNonce(), vaultRead.lastRebalanceAt(),
      vaultRead.venueCount(), vaultRead.maxTurnoverBps(), vaultRead.priceBandBps(), vaultRead.maxSignalAge(),
      vaultRead.lastFtsoPriceMicroUsd(), vaultRead.lastSignal(), vaultRead.venueCount(),
      vaultRead.minRebalanceInterval(),
    ]);

    setValue("tvl", `${fmtUnits(totalAssets)} FXRP`);
    if ($("tee-identity")) $("tee-identity").textContent = teeIdentity === ethers.ZeroAddress ? "not set" : teeIdentity;
    if ($("nonce")) $("nonce").textContent = `#${nonce.toString()}`;
    if ($("strategy-nonce")) $("strategy-nonce").textContent = `#${nonce.toString()}`;
    if ($("last-rebalance")) $("last-rebalance").textContent = timeAgo(lastAt);
    if ($("hero-last-rebalance")) $("hero-last-rebalance").textContent = timeAgo(lastAt);
    renderHeroStatus(teeIdentity, lastAt);

    // A vault that has never rebalanced is eligible immediately — the contract skips the interval
    // guard entirely while `lastRebalanceAt` is 0, so counting down from the epoch would be a lie.
    nextEligibleAt = Number(lastAt) === 0 ? 0 : Number(lastAt) + Number(minInterval);
    renderNextEligible();

    // Share price: assets per whole share, shown to 4dp so drift from yield is visible.
    const oneShare = 10n ** BigInt(assetDecimals + 3); // vault decimals = asset + 3 offset
    const priceOfOne = await vaultRead.convertToAssets(oneShare);
    sharePriceText = Number(ethers.formatUnits(priceOfOne, assetDecimals)).toFixed(4);
    setValue("share-price", sharePriceText);

    await loadVenues(Number(venueCount));

    $("g-conservation").textContent = "enforced";
    $("g-cap").textContent = `${maxVenueCapBps() / 100}%`;
    $("g-turnover").textContent = `${Number(turnoverBps) / 100}%`;
    $("g-band").textContent = `±${Number(bandBps) / 100}%`;
    $("g-age").textContent = `< ${Number(signalAge) / 60}m`;

    renderSignal(signal, ftsoPrice, bandBps, timeAgo(lastAt));
    await renderAllocation(Number(venueCount), totalAssets);

    if (account) {
      const [shares, maxW] = await Promise.all([
        vaultRead.balanceOf(account), vaultRead.maxWithdraw(account),
      ]);
      const yourAssets = shares > 0n ? await vaultRead.convertToAssets(shares) : 0n;
      setValue("your-shares", fmtUnits(shares, assetDecimals + 3, 4));
      setValue("your-assets", `${fmtUnits(yourAssets)} FXRP`);
      $("withdraw").disabled = maxW === 0n;

      // What the vault will actually pay out right now, which is not the same as the position's
      // value when a venue settles through a queue. The withdraw tab quotes this, not the position.
      withdrawable = maxW;
    }

    // Both panels describe numbers this refresh just moved, so they follow it rather than waiting
    // for the next keystroke or tab click.
    renderAvailable();
    renderReceive();

    $("vault-address-line").textContent =
      `Vault ${VAULT_ADDRESS} · Coston2 · view on ${COSTON2.blockExplorerUrls[0]}`;
  } catch (err) {
    setStatus(cleanError(err), "error");
  }

  // Deliberately outside the try. The funding panel is most useful precisely when the vault reads
  // are failing — an empty wallet and a broken RPC look identical from the page, and this is what
  // tells them apart — so an earlier throw must not skip it.
  await refreshFunding();
}

/// Reads every venue once and caches it for this refresh.
///
/// These used to be fetched sequentially, twice — once for the cap and again while drawing the
/// allocation. With three venues that is eight round trips before the chart appears, and on a
/// public RPC the panel sat on "Connect to load allocation" for six seconds while the rest of the
/// page showed live numbers. It looks broken, which during a demo is the same as being broken.
let venueCache = null;

async function loadVenues(venueCount) {
  const infos = await Promise.all(
    Array.from({ length: venueCount }, (_, i) => vaultRead.venues(i))
  );

  const rates = await Promise.all(
    infos.map(async (info) => {
      try {
        const c = new ethers.Contract(info.venue, VENUE_ABI, readProvider);
        return Number(await c.ratePerYearBps()) / 100;
      } catch {
        return null; // a venue need not expose an APR; the vault does not require one
      }
    })
  );

  venueCache = infos.map((info, i) => ({
    address: info.venue,
    capBps: Number(info.capBps),
    active: info.active,
    liquidOnDemand: info.liquidOnDemand,
    apr: rates[i],
  }));
  return venueCache;
}

/// Highest cap across active venues — a true upper bound rather than an example.
function maxVenueCapBps() {
  return (venueCache ?? []).reduce((m, v) => (v.active && v.capBps > m ? v.capBps : m), 0);
}

function renderSignal(sig, ftsoPrice, bandBps, lastAtLabel) {
  const hasSignal = sig.priceMicroUsd > 0n;
  if (!hasSignal) {
    $("sig-price").textContent = "no rebalance yet";
    ["sig-vwap", "sig-range", "sig-volume", "sig-change", "sig-time"].forEach(
      (id) => ($(id).textContent = "—")
    );
    $("ftso-price").textContent = "—";
    $("band-verdict").textContent = "awaiting first rebalance";
    $("band-verdict").className = "pill pill-muted";
    return;
  }

  $("sig-price").textContent = fmtMicro(sig.priceMicroUsd);
  $("sig-vwap").textContent = `${(Number(sig.change1hBps) / 100).toFixed(2)}%`;
  $("sig-range").textContent = `${(Number(sig.change6hBps) / 100).toFixed(2)}%`;
  $("sig-volume").textContent = `$${Number(sig.volume24hUsd).toLocaleString()}`;
  $("sig-time").textContent = lastAtLabel;

  const changePct = Number(sig.change24hBps) / 100;
  const changeEl = $("sig-change");
  changeEl.textContent = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
  changeEl.className = `value ${changePct >= 0 ? "up" : "down"}`;

  // Recompute the band check client-side. The contract already enforced it — showing the working
  // is what turns "trust us" into something a reader can check.
  if (ftsoPrice > 0n) {
    $("ftso-price").textContent = fmtMicro(ftsoPrice);
    const ref = Number(sig.priceMicroUsd);
    const ftso = Number(ftsoPrice);
    const deviationBps = Math.abs(ref - ftso) / ftso * 10000;
    const inBand = deviationBps <= Number(bandBps);
    const verdict = $("band-verdict");
    verdict.textContent = inBand
      ? `within band · ${deviationBps.toFixed(2)} bps deviation`
      : `outside band · ${deviationBps.toFixed(2)} bps`;
    verdict.className = `pill ${inBand ? "pill-good" : "pill-warn"}`;
  } else {
    $("ftso-price").textContent = "band not enforced";
    $("band-verdict").textContent = "—";
    $("band-verdict").className = "pill pill-muted";
  }
}

async function renderAllocation(venueCount, totalAssets) {
  const container = $("allocation");
  if (totalAssets === 0n) {
    container.innerHTML = `<p class="empty">Vault is empty — deposit to see allocation.</p>`;
    $("alloc-chart").innerHTML = "";
    $("alloc-total").textContent = "vault empty";
    return;
  }

  const [assetsPerVenue, idle] = await vaultRead.allocations();
  const venues = venueCache ?? (await loadVenues(venueCount));

  const rows = venues.map((v, i) => ({
    name: `Venue ${String.fromCharCode(65 + i)}`,
    // An illiquid venue is flagged rather than hidden: it changes what a depositor can redeem
    // right now, which is the most consequential thing on this page.
    sub: [v.apr ? `${v.apr}% APR` : "", v.liquidOnDemand ? "" : "delayed exit"]
      .filter(Boolean).join(" · "),
    pct: (Number(assetsPerVenue[i]) / Number(totalAssets)) * 100,
    amount: assetsPerVenue[i],
    capPct: v.capBps / 100,
    idle: false,
    inactive: !v.active,
  }));

  rows.push({
    name: "Idle",
    sub: "held in vault",
    pct: (Number(idle) / Number(totalAssets)) * 100,
    amount: idle,
    capPct: null,
    idle: true,
  });

  // The palette is validated for three categorical hues plus a neutral for idle. A fourth venue
  // would need a fourth hue that survives colour-vision and contrast checks, and none does at this
  // background — so anything past the third falls back to the neutral rather than inventing one.
  const seriesOf = (r, i) => (r.idle || i >= 3 ? "idle" : String(i + 1));

  container.innerHTML = rows.map((r, i) => `
    <div class="alloc-row${r.inactive ? " is-inactive" : ""}" data-series="${seriesOf(r, i)}">
      <div class="alloc-name">
        <span class="swatch" aria-hidden="true"></span>
        <span class="alloc-label">${r.name}${r.inactive ? " (inactive)" : ""}</span>
        ${r.sub ? `<span class="apr">${r.sub}</span>` : ""}
      </div>
      <div class="bar">
        <div class="bar-fill ${r.idle ? "is-idle" : ""}" style="width:${Math.min(r.pct, 100)}%"></div>
        ${r.capPct !== null ? `<div class="cap-marker" style="left:${r.capPct}%" title="cap ${r.capPct}%"></div>` : ""}
      </div>
      <div class="alloc-figures">
        <span class="pct">${r.pct.toFixed(1)}%</span>
        <span class="amt">${fmtUnits(r.amount)} FXRP</span>
      </div>
    </div>
  `).join("");

  const deployedPct = 100 - (Number(idle) / Number(totalAssets)) * 100;
  $("alloc-total").textContent = `${deployedPct.toFixed(1)}% deployed`;
  renderDonut(rows, seriesOf, deployedPct);
}

/// Draws the ring from the same rows the list below it uses — one read, two views of it.
///
/// The chart is `aria-hidden` in the markup on purpose: it carries no number the rows do not, and
/// the rows are direct-labelled, which is also what keeps the chart readable for a reader who
/// cannot separate two of these hues. The ring is the shape of the split; the rows are the truth.
function renderDonut(rows, seriesOf, deployedPct) {
  const R = 40;                       // viewBox units; the SVG is 100×100 and scales to its box
  const C = 2 * Math.PI * R;
  const GAP = 1.05;                   // ≈2px of surface colour at the rendered 190px size

  let cursor = 0;
  const segs = rows.map((r, i) => {
    const share = Math.max(0, Math.min(r.pct, 100)) / 100;
    const arc = C * share;
    const start = cursor;
    cursor += arc;
    if (arc <= 0) return "";
    // A slice smaller than the gap would otherwise vanish entirely; a hairline is more honest than
    // nothing, since the row beside it still carries the exact figure.
    const visible = Math.max(arc - GAP, 0.6);
    return `<circle class="donut-seg" data-series="${seriesOf(r, i)}"
      cx="50" cy="50" r="${R}" fill="none" stroke-width="14"
      stroke-dasharray="${visible.toFixed(3)} ${(C - visible).toFixed(3)}"
      stroke-dashoffset="${(-start).toFixed(3)}"></circle>`;
  }).join("");

  $("alloc-chart").innerHTML = `
    <svg class="donut" viewBox="0 0 100 100" role="presentation" focusable="false">
      <g transform="rotate(-90 50 50)">
        <circle class="donut-track" cx="50" cy="50" r="${R}" fill="none" stroke-width="14"></circle>
        ${segs}
      </g>
      <text class="donut-center-value" x="50" y="49" text-anchor="middle">${deployedPct.toFixed(0)}%</text>
      <text class="donut-center-label" x="50" y="60" text-anchor="middle">deployed</text>
    </svg>`;
}

// ── funding ─────────────────────────────────────────────────
//
// A visitor with an empty wallet cannot try the product, and the error they hit on trying
// ("insufficient funds") names neither which token is missing nor where to get it. Worse, the two
// failures look identical from the outside but have different causes: no C2FLR fails at gas
// estimation, no FXRP fails inside `deposit`. So the balances are shown separately and the verdict
// says which one to go and fetch.
//
// This links out rather than minting. FXRP on Coston2 has no public mint — `mint(address,uint256)`
// reverts for non-minters — so the faucet genuinely is the only route, and a button that appeared
// to mint would be a lie.

async function refreshFunding() {
  const verdict = $("funding-verdict");
  const note = $("funding-note");
  const faucetText = `The faucet gives 100 C2FLR and 10 FXRP per address per 24h.`;

  // `assetRead` is checked alongside the account because `wire()` can leave it unset if the asset
  // lookup failed, and reaching through it would report a JS TypeError as a balance problem.
  if (!account || !assetRead) {
    $("bal-gas").textContent = "—";
    $("bal-fxrp").textContent = "—";
    verdict.textContent = "connect to check";
    verdict.className = "pill pill-muted";
    note.textContent = `${faucetText} Connect a wallet to see what you are missing.`;
    note.className = "funding-note";
    walletAssets = null;
    renderAvailable();
    return;
  }

  try {
    const wantSpoke = viaSpoke() && spokeAssetRead;
    // Both routes are read in parallel — the funding panel shows whichever the source picker is
    // pointed at, but each route quotes its own tokens on its own chain and the two share nothing.
    const [gas, fxrp, sGas, sFxrp] = await Promise.all([
      readProvider.getBalance(account),
      assetRead.balanceOf(account),
      wantSpoke ? spokeReadProvider.getBalance(account) : Promise.resolve(null),
      wantSpoke ? spokeAssetRead.balanceOf(account) : Promise.resolve(null),
    ]);

    walletAssets = fxrp;
    if (wantSpoke) { spokeNative = sGas; spokeAssets = sFxrp; }

    // What the panel shows is the source-selected pair. The hub balances stay cached for the
    // hub deposit path; the spoke's are cached for its send.
    const gasShown = wantSpoke ? sGas : gas;
    const fxrpShown = wantSpoke ? sFxrp : fxrp;
    const gasSym = sourceGasSymbol();
    $("bal-gas").textContent = `${Number(ethers.formatUnits(gasShown, 18)).toFixed(4)} ${gasSym}`;
    $("bal-fxrp").textContent = `${fmtUnits(fxrpShown)} FXRP`;

    renderAvailable();

    // Gas is judged against a floor rather than zero: a dust balance passes a `> 0` check and then
    // still fails to cover a deposit, which sends people looking for a contract bug. Spoke sends
    // pay a real LayerZero fee too, so the floor is higher there.
    const gasFloor = wantSpoke ? ethers.parseUnits("0.002", 18) : ethers.parseUnits("0.05", 18);
    const needsGas = gasShown < gasFloor;
    const needsFxrp = fxrpShown === 0n;
    const chain = wantSpoke && SPOKE ? SPOKE.name : "Coston2";
    const faucetLine = wantSpoke && SPOKE
      ? `Get ${gasSym} from the ${chain} faucet; FXRP arrives on the spoke via BridgeAssetToSpoke.`
      : faucetText;

    if (needsGas && needsFxrp) {
      verdict.textContent = `needs ${gasSym} and FXRP`;
      verdict.className = "pill pill-warn";
      note.textContent = `${faucetLine}`;
      note.className = "funding-note warn";
    } else if (needsGas) {
      verdict.textContent = `needs ${gasSym} for gas`;
      verdict.className = "pill pill-warn";
      note.textContent = `You hold FXRP but not enough ${gasSym} on ${chain} to pay for the transaction. ${faucetLine}`;
      note.className = "funding-note warn";
    } else if (needsFxrp) {
      verdict.textContent = "needs FXRP to deposit";
      verdict.className = "pill pill-warn";
      note.textContent = wantSpoke
        ? `Bridge FXRP from Coston2 to the spoke first, then deposit in one signature.`
        : `Gas is covered. FXRP has no public mint on Coston2, so the faucet is the only source. ${faucetLine}`;
      note.className = "funding-note warn";
    } else {
      verdict.textContent = "funded";
      verdict.className = "pill pill-good";
      note.textContent = `${faucetLine} You have enough of both to deposit.`;
      note.className = "funding-note";
    }
  } catch (err) {
    verdict.textContent = "balance check failed";
    verdict.className = "pill pill-muted";
    note.textContent = `${faucetText} ${cleanError(err)}`;
    note.className = "funding-note";
  }
}

async function copyAddress() {
  if (!account) return;
  const btn = $("copy-address");
  try {
    await navigator.clipboard.writeText(account);
    btn.textContent = "Copied ✓";
  } catch {
    // Clipboard access needs a secure context; `file://` and plain http on a LAN IP are not one,
    // and both are plausible ways this page gets demoed.
    btn.textContent = "Copy failed — select manually";
    setStatus(`Your address: ${account}`);
  }
  setTimeout(() => (btn.textContent = "Copy address"), 2000);
}

/// Registers FXRP in the wallet so a faucet claim is actually visible after it lands.
async function watchAsset() {
  if (!window.ethereum) {
    setStatus("No injected wallet found.", "error");
    return;
  }
  if (!assetAddress) {
    setStatus("Vault asset not loaded yet.", "error");
    return;
  }
  try {
    await window.ethereum.request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: { address: assetAddress, symbol: assetSymbol, decimals: assetDecimals },
      },
    });
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

// ── writes ──────────────────────────────────────────────────

function parseAmount() {
  const raw = $("amount").value.trim();
  if (!raw) throw new Error("Enter an amount");
  const value = ethers.parseUnits(raw, assetDecimals);
  if (value <= 0n) throw new Error("Amount must be greater than zero");
  return value;
}

/// Builds the SendParam pair the composer expects. Kept out of the deposit path so the fee
/// quote and the actual send use one construction — an encoding drift between the two would
/// have the user pay a fee for a message the hub then strands.
function buildSpokeSend(amount, minShares) {
  const hop = {
    dstEid: HUB_EID,
    to: ethers.zeroPadValue(account, 32),
    amountLD: 0n, // ignored — _depositAndSend overwrites with the shares actually minted
    minAmountLD: minShares,
    extraOptions: "0x",
    composeMsg: "0x",
    oftCmd: "0x",
  };
  const composeMsg = ethers.AbiCoder.defaultAbiCoder().encode(
    [SEND_PARAM_TUPLE, "uint256"],
    [hop, 0n], // minMsgValue = 0 for the local case; only non-zero when SHARES_TO_SPOKE
  );
  const outer = {
    dstEid: HUB_EID,
    to: ethers.zeroPadValue(COMPOSER_ADDRESS, 32),
    amountLD: amount,
    minAmountLD: amount,
    // Empty: WireSpoke set enforced options for msgType 2 (send-with-compose). Passing options
    // here would append to the enforced set, which is not what we want.
    extraOptions: "0x",
    composeMsg,
    oftCmd: "0x",
  };
  return { hop, outer };
}

/// Quotes the LayerZero fee for the current amount and paints it into the receive panel.
///
/// Never throws to the caller — a failed quote leaves the field on its last-known value, and the
/// send itself will surface the real error at signature time. Uses a monotonic counter to guard
/// against a slow quote overwriting a newer one.
async function refreshBridgeFee() {
  if (!viaSpoke() || !spokeAssetRead || !account) return;
  const raw = $("amount").value.trim();
  if (!raw) { bridgeFeeText = "—"; $("receive-route").textContent = "—"; return; }

  const seq = ++quoteSeq;
  try {
    const amount = ethers.parseUnits(raw, assetDecimals);
    if (amount <= 0n) return;
    // Floor the inner hop to `previewDeposit * (1 - tolerance)` so the composer's minAmountLD
    // catches a genuine share-price collapse but ignores minute-scale drift from yield or a
    // rebalance landing between quote and execution.
    const shares = await vaultRead.previewDeposit(amount);
    const minShares = (shares * (10_000n - DEPOSIT_TOLERANCE_BPS)) / 10_000n;
    const { outer } = buildSpokeSend(amount, minShares);
    const fee = await spokeAssetRead.quoteSend(outer, false);
    if (seq !== quoteSeq) return; // a newer quote is already in flight
    bridgeFeeWei = fee.nativeFee;
    bridgeFeeText = `${Number(ethers.formatUnits(fee.nativeFee, 18)).toFixed(6)} ${SPOKE.nativeSymbol}`;
    $("receive-route").textContent = bridgeFeeText;
  } catch {
    if (seq === quoteSeq) { bridgeFeeText = "quote failed"; $("receive-route").textContent = bridgeFeeText; }
  }
}

async function deposit() {
  if (viaSpoke()) return depositViaSpoke();

  try {
    const amount = parseAmount();

    // Checked here rather than left to the revert, because the revert for this is
    // `ERC20InsufficientBalance` raised inside `transferFrom` — it names the vault as the failing
    // party, not the wallet, and reads like the vault is broken. It also fires *after* the approval
    // has already been signed and paid for, which is a bad way to learn you had no FXRP.
    const held = await assetRead.balanceOf(account);
    if (held < amount) {
      setStatus(
        `You hold ${fmtUnits(held)} FXRP but tried to deposit ${$("amount").value}. ` +
        `Get more from the Coston2 faucet — FXRP has no public mint.`,
        "error"
      );
      return;
    }

    setStatus("Checking allowance…");
    setBusy("deposit", "Checking allowance…");

    const allowance = await assetRead.allowance(account, VAULT_ADDRESS);
    if (allowance < amount) {
      setStatus("Approving FXRP…");
      setBusy("deposit", "Approving FXRP…");
      const approveTx = await assetWrite.approve(VAULT_ADDRESS, amount);
      await approveTx.wait();
    }

    setStatus("Depositing…");
    setBusy("deposit", "Depositing…");
    const tx = await vaultWrite.deposit(amount, account);
    await tx.wait();

    setStatus(`Deposited ${$("amount").value} FXRP`, "ok");
    $("amount").value = "";
    await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  } finally {
    // In `finally` because the wallet-cancel path is an ordinary outcome here, and a button left
    // spinning after someone declines a signature reads as a hung page.
    setBusy("deposit", null);
    renderReceive();
  }
}

/// Deposit via the LayerZero spoke: one send() on Base Sepolia carries a compose message that
/// runs `vault.deposit()` on Coston2. The depositor signs once, pays in ETH, and holds no
/// Coston2 gas. Shares arrive as tFXRP on Coston2 within a minute; both legs are on LayerZero
/// Scan under the same GUID.
async function depositViaSpoke() {
  const track = $("tx-track");
  track.classList.add("is-hidden");
  track.innerHTML = "";
  try {
    if (!spokeAssetWrite) {
      setStatus(`Switch the wallet to ${SPOKE.name} to deposit via LayerZero.`, "error");
      return;
    }
    const amount = parseAmount();

    // Balance and gas checks fired here name the failing chain — the revert further down would
    // name a LayerZero endpoint the depositor has never seen.
    const held = await spokeAssetRead.balanceOf(account);
    if (held < amount) {
      setStatus(
        `You hold ${fmtUnits(held)} FXRP on ${SPOKE.name} but tried to deposit ${$("amount").value}. ` +
        `Bridge FXRP from Coston2 to the spoke first.`,
        "error"
      );
      return;
    }

    setStatus("Quoting bridge fee…");
    setBusy("deposit", "Quoting fee…");
    const shares = await vaultRead.previewDeposit(amount);
    const minShares = (shares * (10_000n - DEPOSIT_TOLERANCE_BPS)) / 10_000n;
    const { outer } = buildSpokeSend(amount, minShares);
    const fee = await spokeAssetWrite.quoteSend(outer, false);

    const nativeBal = await spokeReadProvider.getBalance(account);
    if (nativeBal < fee.nativeFee) {
      setStatus(
        `Need ${Number(ethers.formatUnits(fee.nativeFee, 18)).toFixed(6)} ${SPOKE.nativeSymbol} ` +
        `for the LayerZero fee. Your wallet has ${Number(ethers.formatUnits(nativeBal, 18)).toFixed(6)}.`,
        "error"
      );
      return;
    }

    setStatus(`Sending via LayerZero (fee ${Number(ethers.formatUnits(fee.nativeFee, 18)).toFixed(6)} ${SPOKE.nativeSymbol})…`);
    setBusy("deposit", "Sending…");
    // `fee` is the frozen ethers Result returned by `quoteSend`; passing it straight to `send`
    // trips ethers v6's tuple normaliser with "Cannot assign to read only property '0'". Copy
    // to a plain object literal so encoding writes into fresh storage.
    const feeArg = { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee };
    const tx = await spokeAssetWrite.send(outer, feeArg, account, { value: fee.nativeFee });
    const receipt = await tx.wait();

    setStatus(
      `Sent from ${SPOKE.name}. Shares land as tFXRP on Coston2 in ~1 minute — both legs traceable on LayerZero Scan.`,
      "ok",
    );
    // The tx hash the wallet just gave us is only the outer send; the compose leg lands on Coston2
    // under the same GUID, so send both to LayerZero Scan rather than the spoke's own explorer.
    track.classList.remove("is-hidden");
    track.innerHTML =
      `Track on <a href="${LZ_SCAN}/tx/${receipt.hash}" target="_blank" rel="noopener noreferrer">LayerZero Scan ↗</a> ` +
      `· <a href="${SPOKE.explorer}/tx/${receipt.hash}" target="_blank" rel="noopener noreferrer">spoke tx ↗</a>`;
    $("amount").value = "";
    await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  } finally {
    setBusy("deposit", null);
    renderReceive();
  }
}

async function withdraw() {
  try {
    const amount = parseAmount();
    setStatus("Withdrawing…");
    setBusy("withdraw", "Withdrawing…");
    const tx = await vaultWrite.withdraw(amount, account, account);
    await tx.wait();
    setStatus(`Withdrew ${$("amount").value} FXRP`, "ok");
    $("amount").value = "";
    await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  } finally {
    setBusy("withdraw", null);
    renderReceive();
  }
}

async function requestRebalance() {
  try {
    setStatus("Requesting rebalance…");
    setBusy("request-rebalance", "Requesting…");
    const tx = await vaultWrite.requestRebalance();
    await tx.wait();
    // Honest about what just happened and what still has to. The button only emits an event; an
    // autopilot is what acts on it, and the FDC round it waits for is minutes long. Whether a
    // daemon is actually listening is a fact the pill reports, so point there rather than promise.
    setStatus(
      "Request recorded on-chain. An autopilot picks it up within ~15s, then the FDC round and "
        + "the enclave take 3–8 minutes. The Autopilot pill shows whether one is listening.",
      "ok",
    );
  } catch (err) {
    setStatus(cleanError(err), "error");
  } finally {
    setBusy("request-rebalance", null);
  }
}

async function fillMax() {
  if (!account) return;
  try {
    // "Max" means different things per action, and the visible tab now says which one is meant, so
    // it picks rather than guessing. Both are still read: the one not filled in is what the
    // Available line quotes, and reading them together is one round trip instead of two.
    const [walletBal, maxW] = await Promise.all([
      assetRead.balanceOf(account), vaultRead.maxWithdraw(account),
    ]);
    walletAssets = walletBal;
    withdrawable = maxW;

    // On withdraw this is `maxWithdraw`, not the position's value: a venue that settles through a
    // queue can hold back part of it, and quoting the position would promise money the vault
    // cannot pay today.
    $("amount").value = ethers.formatUnits(mode === "withdraw" ? maxW : walletBal, assetDecimals);
    renderAvailable();
    renderReceive();
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

/// Surfaces the vault's custom errors, which are the interesting part of any failure here.
function cleanError(err) {
  const raw = err?.shortMessage || err?.reason || err?.message || String(err);
  const named = raw.match(
    /(ConservationViolated|VenueCapExceeded|TurnoverExceeded|PriceOutOfBand|SignalMismatch|SignalStale|BadSigner|BadNonce|RebalanceTooSoon|PlanExpired|InvalidProof|TargetsOverAllocate|NoTeeIdentity)/
  );
  if (named) return `Rejected by guardrail: ${named[1]}`;
  if (/user rejected/i.test(raw)) return "Cancelled in wallet";
  if (/insufficient funds/i.test(raw)) return "Insufficient C2FLR for gas — use the Coston2 faucet";
  return raw.length > 160 ? raw.slice(0, 160) + "…" : raw;
}

// ── autopilot ───────────────────────────────────────────────
//
// Two independent displays, deliberately not merged. The countdown is derived from the chain and
// is true whether or not any daemon exists; the pill is the daemon's self-report and is treated as
// a hint. If the daemon lies or dies, the countdown is still right.

let nextEligibleAt = null; // unix seconds, or 0 when the vault has never rebalanced

function renderNextEligible() {
  const el = $("next-eligible");
  const strat = $("strategy-next");
  const text = nextEligibleAt === null
    ? "—"
    : (() => {
        const left = nextEligibleAt - Math.floor(Date.now() / 1000);
        if (left <= 0) return "now";
        const m = Math.floor(left / 60);
        return `${m}:${String(left % 60).padStart(2, "0")}`;
      })();
  if (el) el.textContent = text;
  if (strat) strat.textContent = text;
}

function setPill(text, kind = "muted") {
  const el = $("autopilot-pill");
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

/// Renders the daemon's status. Anything unexpected degrades to "unreachable" rather than throwing:
/// a status endpoint that has gone away must not take the rest of the page with it.
function renderAutopilot(s) {
  if (!s) { setPill(AUTOPILOT_URL ? "unreachable" : "manual", "muted"); return; }
  switch (s.phase) {
    case "working":
      setPill(s.step ? `working ${s.step}/5` : "working", "good");
      break;
    case "blocked":
      setPill(`holding: ${(s.blockedBy || [])[0] || "unknown"}`, "warn");
      break;
    case "error":
      setPill("backing off", "warn");
      break;
    default:
      setPill(s.cyclesOk ? `idle · ${s.cyclesOk} cycles` : "idle", "good");
  }
}

async function pollAutopilot() {
  if (!AUTOPILOT_URL) { renderAutopilot(null); return; }
  try {
    const res = await fetch(AUTOPILOT_URL.replace(/\/$/, "") + "/status", { cache: "no-store" });
    renderAutopilot(res.ok ? await res.json() : null);
  } catch {
    renderAutopilot(null); // offline is a normal state for this row, not an error for the page
  }
}

// ── boot ────────────────────────────────────────────────────

async function boot() {
  $("connect").addEventListener("click", connect);
  $("deposit").addEventListener("click", deposit);
  $("withdraw").addEventListener("click", withdraw);
  $("request-rebalance").addEventListener("click", requestRebalance);
  $("max").addEventListener("click", fillMax);
  $("copy-address").addEventListener("click", copyAddress);
  $("watch-fxrp").addEventListener("click", watchAsset);

  // The tabs and the amount field only change what the panel says about itself — the two write
  // buttons above still call the same functions with the same arguments they always did.
  for (const id of ["tab-deposit", "tab-withdraw"]) {
    $(id).addEventListener("click", (e) => setMode(e.currentTarget.dataset.mode));
  }
  // The source picker chooses which chain the deposit tab signs on. Both buttons carry
  // data-source so the handler stays symmetric even if a third route is ever added.
  for (const id of ["source-hub", "source-spoke"]) {
    const el = $(id);
    if (el) el.addEventListener("click", (e) => setSource(e.currentTarget.dataset.source));
  }
  $("amount").addEventListener("input", renderReceive);

  // Paints the panel from `mode` once at load so its labels are authored in one place, rather than
  // starting on the markup's wording and flipping to this on the first refresh.
  setMode("deposit");

  // Resolve whatever the query string did not supply. Everything spoke-related lives in the same
  // file — a `?vault=` override should not also cost the page its autopilot URL, its composer,
  // or its spoke config.
  let cfg = null;
  try {
    // `cache: "no-store"` matters: this file changes on every redeploy, and a cached copy
    // silently points the whole page at a dead address — which then surfaces as an empty vault
    // rather than as an error, because the old contract still exists and still answers.
    const res = await fetch("./deployments.json", { cache: "no-store" });
    if (res.ok) cfg = await res.json();
  } catch { /* not deployed yet — the page still renders and explains itself */ }

  if (cfg) {
    VAULT_ADDRESS ||= cfg.vault || "";
    AUTOPILOT_URL ||= cfg.autopilot || "";
    COMPOSER_ADDRESS = cfg.composer || "";
    HUB_EID = cfg.hubEid || HUB_EID;
    LZ_SCAN = cfg.lzScan || LZ_SCAN;
    HUB_EXPLORER = cfg.explorer || HUB_EXPLORER;
    // The spoke block is optional. If present, wire a read-only provider now so the funding
    // panel can quote Base Sepolia balances even before the wallet ever leaves Coston2, and the
    // fee row can render without waiting on a connection.
    if (cfg.spoke && cfg.spoke.assetOFT && cfg.spoke.rpc) {
      SPOKE = cfg.spoke;
      try {
        spokeReadProvider = new ethers.JsonRpcProvider(SPOKE.rpc);
        spokeAssetRead = new ethers.Contract(SPOKE.assetOFT, OFT_ABI, spokeReadProvider);
      } catch {
        // Bad RPC — degrade to hub-only cleanly rather than throwing during boot.
        spokeReadProvider = null;
        spokeAssetRead = null;
      }
    }
  }

  // If sessionStorage picked "spoke" from a prior visit but this deployment has no spoke, fall
  // back to the hub. Then apply the source once, so every label is authored in setSource() rather
  // than by the initial markup.
  if (source === "spoke" && !SPOKE) source = "hub";
  setSource(source);

  if (!VAULT_ADDRESS) {
    setStatus("No vault configured. Deploy, then pass ?vault=0x… or write ui/deployments.json.");
    $("vault-address-line").textContent = "No vault address configured.";
    return;
  }

  // Render read-only immediately so the page is useful before a wallet is connected.
  if (!(await wire())) return;
  await refresh();
  setInterval(refresh, 15000);

  // Silent reconnect. `chainChanged` reloads the page (to reset per-chain caches cleanly),
  // which drops account/signer/provider — so an accepted chain switch would otherwise leave
  // the user staring at a "Connect wallet" button they had already used. `eth_accounts` is
  // the popup-free variant of `eth_requestAccounts`, returning the authorised address if the
  // site is still allowed and an empty array otherwise. Nothing prompts.
  try {
    if (window.ethereum) {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts.length > 0) {
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        account = await signer.getAddress();
        $("connect").textContent = shortAddr(account);
        const net = await provider.getNetwork();
        const nid = Number(net.chainId);
        const label = nid === 114 ? "Coston2" : (SPOKE && nid === SPOKE.chainId ? SPOKE.name : `chain ${nid}`);
        $("network-pill").textContent = label;
        $("network-pill").className = "pill pill-good";
        $("copy-address").disabled = false;
        if (await wire()) await refresh();
      }
    }
  } catch { /* silent — the manual Connect button remains as a fallback */ }

  // The countdown ticks on its own second, independent of the 15s chain poll, so it reads as a
  // clock rather than as a number that lurches. `refresh()` only moves its target.
  setInterval(renderNextEligible, 1000);

  pollAutopilot();
  setInterval(pollAutopilot, 10000);

  window.ethereum?.on?.("accountsChanged", () => location.reload());
  window.ethereum?.on?.("chainChanged", () => location.reload());
}

// ── router ──────────────────────────────────────────────────
//
// Four real routes — /vault, /strategy, /activity, /documentation — served by an SPA fallback
// (serve.json rewrites all four to index.html). The router intercepts anchor clicks with
// data-route to avoid a full page load, but the anchors' hrefs are still the real routes, so
// middle-click / cmd-click / copied links all land correctly.
//
// The page views live in the same DOM (single shell) and toggle via `hidden`, so app.js's read
// pipeline works unchanged — refresh() writes to whichever IDs exist and no-ops on the rest.

const ROUTES = new Set(["vault", "strategy", "activity", "documentation"]);

function currentRoute() {
  const seg = location.pathname.replace(/^\/+/, "").split("/")[0];
  return ROUTES.has(seg) ? seg : "vault";
}

function showRoute(name) {
  document.body.dataset.page = name;
  for (const view of document.querySelectorAll("[data-page-view]")) {
    view.hidden = view.dataset.pageView !== name;
  }
  for (const a of document.querySelectorAll("a[data-route]")) {
    a.classList.toggle("is-active", a.dataset.route === name);
  }
  // Close the mobile menu on route change — leaving it open after a jump makes the next page's
  // content invisible on small screens.
  const mob = $("mobile-nav");
  if (mob) mob.hidden = true;
  const tog = $("nav-toggle");
  if (tog) tog.setAttribute("aria-expanded", "false");
  window.scrollTo({ top: 0, behavior: "auto" });
  if (name === "activity") loadActivity().catch(() => {});
}

function navigate(name, push = true) {
  if (!ROUTES.has(name)) name = "vault";
  const path = "/" + name;
  if (push && location.pathname !== path) history.pushState({}, "", path);
  showRoute(name);
}

function initRouter() {
  for (const a of document.querySelectorAll("a[data-route]")) {
    a.addEventListener("click", (e) => {
      // Modifier keys / non-left-click should behave like a normal link: open in a new tab, copy,
      // save, etc. Only plain clicks are intercepted.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(a.dataset.route);
    });
  }
  window.addEventListener("popstate", () => showRoute(currentRoute()));

  const toggle = $("nav-toggle");
  const mob = $("mobile-nav");
  if (toggle && mob) {
    toggle.addEventListener("click", () => {
      const open = mob.hidden;
      mob.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  showRoute(currentRoute());
}

// ── activity ────────────────────────────────────────────────
//
// Reads Rebalanced / RebalanceRequested from the vault, and Deposit / Withdraw from the ERC-4626
// surface. All values come from event logs — no off-chain indexer. A block window is used because
// a full `fromBlock: 0` query on a public RPC times out on Coston2.

const ACTIVITY_ABI = [
  "event Rebalanced(uint256 indexed nonce, bytes32 indexed signalHash, uint256 totalBefore, uint256 totalAfter, uint256 turnoverBps)",
  "event RebalanceRequested(uint256 indexed nonce, uint256 totalAssets, uint64 timestamp)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
];

// The Coston2 public RPC caps eth_getLogs at 30 blocks — unusable for a timeline that spans
// the vault's lifetime. Blockscout's `?module=logs&action=getLogs` returns the whole history
// in one call, still keyed off the same on-chain data, so nothing about the "read the chain
// directly" story changes — we just query a Coston2 explorer that has already scanned it.
const BLOCKSCOUT_API = "https://coston2-explorer.flare.network/api";
let activityFilter = "all";
let activityRows = [];
let activityLoading = false;

function activityIcon(kind) {
  switch (kind) {
    case "deposit": return "↓";
    case "withdraw": return "↑";
    case "rebalance": return "↻";
    case "request": return "•";
    default: return "·";
  }
}

function renderActivity() {
  const list = $("activity-list");
  const count = $("activity-count");
  if (!list) return;
  const shown = activityRows.filter(r => activityFilter === "all" || r.kind === activityFilter);

  if (count) {
    if (activityLoading && shown.length === 0) count.textContent = "loading";
    else count.textContent = `${shown.length} event${shown.length === 1 ? "" : "s"}`;
  }

  if (activityLoading && shown.length === 0) {
    list.innerHTML = `<p class="empty">Loading events from Coston2…</p>`;
    return;
  }
  if (shown.length === 0) {
    list.innerHTML = `<p class="empty">No matching events in the last ${ACTIVITY_BLOCK_WINDOW.toLocaleString()} blocks.</p>`;
    return;
  }

  // Group by day so a long list scans as a timeline rather than a wall of rows.
  const groups = new Map();
  for (const r of shown) {
    const day = r.ts ? new Date(r.ts * 1000).toDateString() : "unknown date";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(r);
  }

  list.innerHTML = [...groups.entries()].map(([day, rows]) => `
    <div class="activity-day">
      <div class="activity-day-head">
        <span class="activity-day-label">${day}</span>
        <span class="activity-day-count">${rows.length} event${rows.length === 1 ? "" : "s"}</span>
      </div>
      <div class="activity-day-rows">
        ${rows.map(r => `
          <article class="activity-card" data-kind="${r.kind}">
            <header class="activity-card-head">
              <span class="activity-icon" aria-hidden="true">${activityIcon(r.kind)}</span>
              <span class="activity-type">${r.label}</span>
              <span class="activity-status pill ${r.statusKind}">${r.status}</span>
            </header>

            <div class="activity-card-body">
              ${r.parts.map(p => `
                <div class="activity-part">
                  <span class="activity-part-label">${p.label}</span>
                  <span class="activity-part-value mono">${p.value}</span>
                </div>
              `).join("")}
            </div>

            <footer class="activity-card-foot">
              <span class="activity-when" title="${r.iso || ""}">${r.time}</span>
              <span class="activity-sep" aria-hidden="true">·</span>
              <span class="mono activity-block">block ${r.block.toLocaleString()}</span>
              <span class="activity-sep" aria-hidden="true">·</span>
              <a href="${HUB_EXPLORER}/tx/${r.tx}" target="_blank" rel="noopener noreferrer"
                 class="mono activity-tx" title="${r.tx}">
                ${r.tx.slice(0, 10)}…${r.tx.slice(-6)}
                <span class="ext" aria-hidden="true">↗</span>
              </a>
            </footer>
          </article>
        `).join("")}
      </div>
    </div>
  `).join("");
}

async function loadActivity() {
  if (activityLoading) return;
  // The activity route can be visited before wire() has resolved vaultRead. Wait briefly
  // rather than silently bailing — otherwise the "Loading events…" placeholder never clears.
  if (!vaultRead) {
    for (let i = 0; i < 30 && !vaultRead; i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!vaultRead) {
      const list = $("activity-list");
      if (list) list.innerHTML = `<p class="empty">Vault not yet configured. Check back in a moment.</p>`;
      return;
    }
  }
  activityLoading = true;
  renderActivity();

  const list = $("activity-list");
  try {
    const iface = new ethers.Interface(ACTIVITY_ABI);
    const topics = {
      Deposit:            iface.getEvent("Deposit").topicHash,
      Withdraw:           iface.getEvent("Withdraw").topicHash,
      Rebalanced:         iface.getEvent("Rebalanced").topicHash,
      RebalanceRequested: iface.getEvent("RebalanceRequested").topicHash,
    };

    // One HTTP call per event type. Blockscout returns { status, message, result[] } where each
    // result carries topics, data, timeStamp, blockNumber, transactionHash — everything the row
    // needs, no per-block RPC follow-up.
    async function bscoutLogs(topic0) {
      const url = `${BLOCKSCOUT_API}?module=logs&action=getLogs`
        + `&fromBlock=0&toBlock=latest`
        + `&address=${VAULT_ADDRESS}`
        + `&topic0=${topic0}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`blockscout ${res.status}`);
      const body = await res.json();
      // Blockscout returns "No logs found" as status:"0"; treat that as [] rather than an error.
      if (body.status !== "1") return [];
      return body.result || [];
    }

    const [rawDeposits, rawWithdraws, rawRebalances, rawRequests] = await Promise.all([
      bscoutLogs(topics.Deposit),
      bscoutLogs(topics.Withdraw),
      bscoutLogs(topics.Rebalanced),
      bscoutLogs(topics.RebalanceRequested),
    ]);

    function decode(raw, name) {
      return raw.map(log => {
        try {
          // Blockscout always returns a 4-element `topics` array, padding unused slots with
          // null. Ethers rejects nulls as `invalid BytesLike value`, so trim before decoding.
          const topics = log.topics.filter(t => t !== null && t !== undefined);
          const parsed = iface.parseLog({ topics, data: log.data });
          return { log, parsed, name };
        } catch { return null; }
      }).filter(Boolean);
    }

    const events = [
      ...decode(rawDeposits, "Deposit"),
      ...decode(rawWithdraws, "Withdraw"),
      ...decode(rawRebalances, "Rebalanced"),
      ...decode(rawRequests, "RebalanceRequested"),
    ];

    activityRows = events.map(({ log, parsed, name }) => {
      // Blockscout carries hex-prefixed strings for numeric fields.
      const ts = Number(BigInt(log.timeStamp));
      const block = Number(BigInt(log.blockNumber));
      const iso = ts ? new Date(ts * 1000).toISOString() : "";
      const time = timeAgo(ts);
      const base = {
        tx: log.transactionHash, block,
        ts, iso, time,
        statusKind: "pill-good", status: "confirmed",
      };
      switch (name) {
        case "Deposit":
          return { ...base, kind: "deposit", label: "Deposit", parts: [
            { label: "Assets in",     value: `${fmtUnits(parsed.args.assets)} FXRP` },
            { label: "Shares minted", value: `+${fmtUnits(parsed.args.shares, assetDecimals + 3, 4)} tFXRP` },
          ]};
        case "Withdraw":
          return { ...base, kind: "withdraw", label: "Withdrawal", parts: [
            { label: "Assets out",    value: `${fmtUnits(parsed.args.assets)} FXRP` },
            { label: "Shares burned", value: `−${fmtUnits(parsed.args.shares, assetDecimals + 3, 4)} tFXRP` },
          ]};
        case "Rebalanced": {
          const before = parsed.args.totalBefore;
          const after = parsed.args.totalAfter;
          const delta = after - before;
          const deltaStr = (delta >= 0n ? "+" : "−") + fmtUnits(delta < 0n ? -delta : delta);
          return { ...base, kind: "rebalance", label: `Rebalance #${parsed.args.nonce}`, parts: [
            { label: "Total before", value: `${fmtUnits(before)} FXRP` },
            { label: "Total after",  value: `${fmtUnits(after)} FXRP` },
            { label: "Delta",        value: `${deltaStr} FXRP` },
            { label: "Turnover",     value: `${(Number(parsed.args.turnoverBps) / 100).toFixed(2)}%` },
          ]};
        }
        case "RebalanceRequested":
          return { ...base, kind: "request", label: `Rebalance requested #${parsed.args.nonce}`,
            statusKind: "pill-muted", status: "requested", parts: [
              { label: "Total at request", value: `${fmtUnits(parsed.args.totalAssets)} FXRP` },
            ]};
        default:
          return null;
      }
    }).filter(Boolean).sort((a, b) => b.block - a.block);
  } catch (err) {
    console.warn("activity load failed", err);
    activityRows = [];
    if (list) list.innerHTML = `<p class="empty">Failed to load events: ${cleanError(err)}</p>`;
    activityLoading = false;
    return;
  }
  activityLoading = false;
  renderActivity();
}

function initActivityControls() {
  for (const btn of document.querySelectorAll(".filter-btn")) {
    btn.addEventListener("click", () => {
      activityFilter = btn.dataset.filter;
      for (const b of document.querySelectorAll(".filter-btn")) {
        b.classList.toggle("is-active", b === btn);
      }
      renderActivity();
    });
  }
  const refresh = $("activity-refresh");
  if (refresh) refresh.addEventListener("click", () => loadActivity().catch(() => {}));
}

initRouter();
initActivityControls();
boot();
