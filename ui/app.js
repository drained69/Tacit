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

const VAULT_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
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
const readProvider = new ethers.JsonRpcProvider(RPC_URL);

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

function setStatus(msg, kind = "") {
  const el = $("tx-status");
  el.textContent = msg;
  el.className = `status ${kind}`;
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
      venueCountA, turnoverBps, bandBps, signalAge, ftsoPrice, signal, venueCount,
    ] = await Promise.all([
      vaultRead.totalAssets(), vaultRead.teeIdentity(), vaultRead.rebalanceNonce(), vaultRead.lastRebalanceAt(),
      vaultRead.venueCount(), vaultRead.maxTurnoverBps(), vaultRead.priceBandBps(), vaultRead.maxSignalAge(),
      vaultRead.lastFtsoPriceMicroUsd(), vaultRead.lastSignal(), vaultRead.venueCount(),
    ]);

    $("tvl").textContent = `${fmtUnits(totalAssets)} FXRP`;
    $("tee-identity").textContent = teeIdentity === ethers.ZeroAddress ? "not set" : teeIdentity;
    $("nonce").textContent = nonce.toString();
    $("last-rebalance").textContent = timeAgo(lastAt);

    // Share price: assets per whole share, shown to 4dp so drift from yield is visible.
    const oneShare = 10n ** BigInt(assetDecimals + 3); // vault decimals = asset + 3 offset
    const priceOfOne = await vaultRead.convertToAssets(oneShare);
    $("share-price").textContent = Number(ethers.formatUnits(priceOfOne, assetDecimals)).toFixed(4);

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
      $("your-shares").textContent = fmtUnits(shares, assetDecimals + 3, 4);
      $("your-assets").textContent = `${fmtUnits(yourAssets)} FXRP`;
      $("withdraw").disabled = maxW === 0n;
    }

    $("vault-address-line").textContent =
      `Vault ${VAULT_ADDRESS} · Coston2 · view on ${COSTON2.blockExplorerUrls[0]}`;
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
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

  container.innerHTML = rows.map((r) => `
    <div class="alloc-row">
      <div class="alloc-name">
        ${r.name}${r.inactive ? " (inactive)" : ""}
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
    setStatus("Checking allowance…");

    const allowance = await assetRead.allowance(account, VAULT_ADDRESS);
    if (allowance < amount) {
      setStatus("Approving FXRP…");
      const approveTx = await assetWrite.approve(VAULT_ADDRESS, amount);
      await approveTx.wait();
    }

    setStatus("Depositing…");
    const tx = await vaultWrite.deposit(amount, account);
    await tx.wait();

    setStatus(`Deposited ${$("amount").value} FXRP`, "ok");
    $("amount").value = "";
    await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

async function withdraw() {
  try {
    const amount = parseAmount();
    setStatus("Withdrawing…");
    const tx = await vaultWrite.withdraw(amount, account, account);
    await tx.wait();
    setStatus(`Withdrew ${$("amount").value} FXRP`, "ok");
    $("amount").value = "";
    await refresh();
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

async function requestRebalance() {
  try {
    setStatus("Requesting rebalance…");
    const tx = await vaultWrite.requestRebalance();
    await tx.wait();
    setStatus("Requested. The relayer will attest a signal and ask the enclave for a plan.", "ok");
  } catch (err) {
    setStatus(cleanError(err), "error");
  }
}

async function fillMax() {
  if (!account) return;
  try {
    // "Max" means different things per action, so offer the larger of the two and let the
    // contract reject an over-withdrawal rather than silently guessing which one was meant.
    const [walletBal, maxW] = await Promise.all([
      assetRead.balanceOf(account), vaultReadRead.maxWithdraw(account),
    ]);
    const use = walletBal > maxW ? walletBal : maxW;
    $("amount").value = ethers.formatUnits(use, assetDecimals);
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

// ── boot ────────────────────────────────────────────────────

async function boot() {
  $("connect").addEventListener("click", connect);
  $("deposit").addEventListener("click", deposit);
  $("withdraw").addEventListener("click", withdraw);
  $("request-rebalance").addEventListener("click", requestRebalance);
  $("max").addEventListener("click", fillMax);

  if (!VAULT_ADDRESS) {
    try {
      // `cache: "no-store"` matters: this file changes on every redeploy, and a cached copy
      // silently points the whole page at a dead address — which then surfaces as an empty vault
      // rather than as an error, because the old contract still exists and still answers.
      const res = await fetch("./deployments.json", { cache: "no-store" });
      if (res.ok) VAULT_ADDRESS = (await res.json()).vault || "";
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

  window.ethereum?.on?.("accountsChanged", () => location.reload());
  window.ethereum?.on?.("chainChanged", () => location.reload());
}

boot();
