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

const VAULT_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
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
  const label = $("hero-status-label");
  const dot = $("hero-dot");
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
  label.textContent = text;
  dot.className = `dot dot-${state}`;
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

  renderAvailable();
  renderReceive();
}

/// "Available" is a different number per action: what the wallet holds, or what the vault will
/// actually pay out right now. Both are already cached, so this costs no round trip.
function renderAvailable() {
  const depositing = mode === "deposit";
  $("available-label").textContent = depositing ? "In wallet" : "Withdrawable";

  const amount = depositing ? walletAssets : withdrawable;
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

    // Add-then-switch: `wallet_addEthereumChain` is a no-op if the chain is already known, so
    // this handles both the first-time and returning cases without branching on error codes.
    try {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [COSTON2] });
    } catch { /* already added, or user declined the add but may still be on the chain */ }
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: COSTON2.chainId }],
    });

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();

    $("connect").textContent = shortAddr(account);
    $("network-pill").textContent = "Coston2";
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
    // Writes only go through the wallet, and only when it is on the same chain the page reads
    // from — otherwise a deposit would broadcast to the wrong network.
    const [readNet, walletNet] = await Promise.all([
      readProvider.getNetwork(),
      provider.getNetwork(),
    ]);
    if (readNet.chainId !== walletNet.chainId) {
      setStatus(
        `Wallet is on chain ${walletNet.chainId} but this page reads chain ${readNet.chainId}. ` +
        `Switch networks to deposit.`,
        "error"
      );
      return true; // reads still work; writes stay disabled
    }

    vaultWrite = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
    assetWrite = new ethers.Contract(assetAddr, ERC20_ABI, signer);
    $("deposit").disabled = false;
    $("withdraw").disabled = false;
    $("request-rebalance").disabled = false;
  }
  return true;
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
    $("tee-identity").textContent = teeIdentity === ethers.ZeroAddress ? "not set" : teeIdentity;
    $("nonce").textContent = `#${nonce.toString()}`;
    $("last-rebalance").textContent = timeAgo(lastAt);
    $("hero-last-rebalance").textContent = timeAgo(lastAt);
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
    const [gas, fxrp] = await Promise.all([
      readProvider.getBalance(account),
      assetRead.balanceOf(account),
    ]);

    $("bal-gas").textContent = `${Number(ethers.formatUnits(gas, 18)).toFixed(3)} C2FLR`;
    $("bal-fxrp").textContent = `${fmtUnits(fxrp)} FXRP`;

    // The deposit tab quotes the same balance this panel already fetched, so it costs nothing.
    walletAssets = fxrp;
    renderAvailable();

    // Gas is judged against a floor rather than zero: a dust balance passes a `> 0` check and then
    // still fails to cover a deposit, which sends people looking for a contract bug.
    const needsGas = gas < ethers.parseUnits("0.05", 18);
    const needsFxrp = fxrp === 0n;

    if (needsGas && needsFxrp) {
      verdict.textContent = "needs C2FLR and FXRP";
      verdict.className = "pill pill-warn";
      note.textContent = `${faucetText} Request both, then come back.`;
      note.className = "funding-note warn";
    } else if (needsGas) {
      verdict.textContent = "needs C2FLR for gas";
      verdict.className = "pill pill-warn";
      note.textContent = `You hold FXRP but not enough C2FLR to pay for the transaction. ${faucetText}`;
      note.className = "funding-note warn";
    } else if (needsFxrp) {
      verdict.textContent = "needs FXRP to deposit";
      verdict.className = "pill pill-warn";
      note.textContent = `Gas is covered. FXRP has no public mint on Coston2, so the faucet is the only source. ${faucetText}`;
      note.className = "funding-note warn";
    } else {
      verdict.textContent = "funded";
      verdict.className = "pill pill-good";
      note.textContent = `${faucetText} You have enough of both to deposit.`;
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

async function deposit() {
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
  if (nextEligibleAt === null) { el.textContent = "—"; return; }
  const left = nextEligibleAt - Math.floor(Date.now() / 1000);
  if (left <= 0) { el.textContent = "now"; return; }
  const m = Math.floor(left / 60);
  el.textContent = `${m}:${String(left % 60).padStart(2, "0")}`;
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
  $("amount").addEventListener("input", renderReceive);

  // Paints the panel from `mode` once at load so its labels are authored in one place, rather than
  // starting on the markup's wording and flipping to this on the first refresh.
  setMode("deposit");

  // Resolve whatever the query string did not supply. Both keys live in the same file, so this runs
  // when either is missing: a `?vault=` override should not also cost the page its autopilot URL.
  if (!VAULT_ADDRESS || !AUTOPILOT_URL) {
    try {
      // `cache: "no-store"` matters: this file changes on every redeploy, and a cached copy
      // silently points the whole page at a dead address — which then surfaces as an empty vault
      // rather than as an error, because the old contract still exists and still answers.
      const res = await fetch("./deployments.json", { cache: "no-store" });
      if (res.ok) {
        const cfg = await res.json();
        VAULT_ADDRESS ||= cfg.vault || "";
        AUTOPILOT_URL ||= cfg.autopilot || "";
      }
    } catch { /* not deployed yet — the page still renders and explains itself */ }
  }

  if (!VAULT_ADDRESS) {
    setStatus("No vault configured. Deploy, then pass ?vault=0x… or write ui/deployments.json.");
    $("vault-address-line").textContent = "No vault address configured.";
    return;
  }

  // Render read-only immediately so the page is useful before a wallet is connected.
  if (!(await wire())) return;
  await refresh();
  setInterval(refresh, 15000);

  // The countdown ticks on its own second, independent of the 15s chain poll, so it reads as a
  // clock rather than as a number that lurches. `refresh()` only moves its target.
  setInterval(renderNextEligible, 1000);

  pollAutopilot();
  setInterval(pollAutopilot, 10000);

  window.ethereum?.on?.("accountsChanged", () => location.reload());
  window.ethereum?.on?.("chainChanged", () => location.reload());
}

boot();
