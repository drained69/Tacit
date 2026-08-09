# Tacit

> **A confidential autonomous treasury for FXRP.**
> An agent decides where the capital goes. The chain decides what the agent is allowed to do.

Depositors hold an ERC-4626 share. A strategy running inside a Flare Confidential Compute enclave
reads FDC-attested market data and reallocates across FXRP yield venues. The vault enforces, in
Solidity, that the agent can never move funds out, over-concentrate, churn the book, or act on a
price the market never printed.

Built for **Flare Summer Signal**, targeting both bounties — *Interoperable Asset Products* and
*Confidential Compute Apps*.

**Live on Coston2.** [`0xB3834fBa…67e3`](https://coston2-explorer.flare.network/address/0xB3834fBa12EB884A240c69c0aB06225930f267e3) ·
51 tests · allocates into **Firelight stXRP**, a real third-party vault holding ~100k FXRP.

---

## Contents

1. [The problem](#1-the-problem)
2. [What Tacit is](#2-what-tacit-is)
3. [Why this needs a TEE](#3-why-this-needs-a-tee)
4. [Architecture](#4-architecture)
5. [The trust model](#5-the-trust-model)
6. [Prove it yourself](#6-prove-it-yourself)
7. [Real venues, and what integrating one taught us](#7-real-venues-and-what-integrating-one-taught-us)
8. [Flare integration, primitive by primitive](#8-flare-integration-primitive-by-primitive)
9. [What is real and what is simulated](#9-what-is-real-and-what-is-simulated)
10. [Deployed addresses](#10-deployed-addresses)
11. [Running it](#11-running-it)
12. [Engineering notes: three bugs worth reading about](#12-engineering-notes-three-bugs-worth-reading-about)
13. [Repository layout](#13-repository-layout)
14. [Limitations](#14-limitations)
15. [Roadmap](#15-roadmap)
16. [Evidence of new work](#16-evidence-of-new-work)

---

## 1. The problem

FXRP is seven months old, ~155M minted, and yields across Kinetic, SparkDEX, Enosys and Firelight
have run as high as 50% APR. Three things stop an ordinary holder from capturing that.

**Fragmentation.** Opportunities are spread across four-plus protocols with rates that move
independently. Capturing them means watching all of them continuously and moving between them —
which nobody does by hand, and which costs more in gas and attention than most positions earn.

**Any public strategy stops working.** This is the part that is usually hand-waved, so it is worth
being precise. A rebalancing rule expressed as on-chain transactions is not merely *copyable*; it
is *exploitable*:

- If you know the rule, you know what the vault will buy before it buys, and can front-run it.
- If you know the thresholds, you can push an observable metric just past one and *force* the vault
  to rebalance — then harvest the turnover you induced.
- Every rebalance becomes a scheduled, publicly-known liquidity event on a thin book.

Every FXRP yield vault live today — earnXRP, MXRPY, the Spectra vault — is human-managed with a
public mandate. That is not an oversight. It is what you are left with when the strategy cannot be
private: you can have a *discretionary* manager or a *predictable* rule, but not a reactive
automated one.

**Off-chain signals never make it on-chain.** Exchange volume, realised volatility and 24h drawdown
all say something about where FXRP yield is heading and how safe it is to be deployed. No on-chain
FXRP product uses any of them.

Solving all three at once requires confidential compute, verified off-chain data, and trustless
settlement in the same system. Flare is the only chain where all three are enshrined infrastructure
rather than a bridge to somewhere else.

---

## 2. What Tacit is

An ERC-4626 vault over FXRP with three parts:

| Part | What it does | Where it runs |
|---|---|---|
| **The vault** | Custody, share accounting, and five hard limits on the agent | Coston2, Solidity |
| **The enclave** | Reads the attested signal, decides the allocation, signs it | Flare Confidential Compute |
| **The relayer** | Requests attestation, carries the plan on-chain | Anywhere; fully untrusted |

A depositor sees an ordinary vault: `deposit`, `withdraw`, a share price that rises with yield.
Underneath, allocation is decided by an agent whose *reasoning* is private and whose *authority* is
tightly bounded.

The whole design is one sentence: **the enclave controls strategy quality, never fund safety.**

---

## 3. Why this needs a TEE

The obvious objection is "why not just publish the strategy and skip the enclave?" Three answers,
in increasing order of importance.

**Confidentiality is the product, not a feature.** A published rule is a rule that gets front-run
and copied. The strategy *is* the alpha.

**Only some things need to be private — and Tacit privatises exactly those.** The inputs are
public and attested by ~100 independent data providers. The resulting allocation is public and
on-chain. What stays inside the enclave is the *mapping* between them: the weights, thresholds and
risk budget. An observer sees what the agent saw and what it did, and still cannot reproduce the
rule. That is a much narrower and more defensible privacy claim than "our vault is a black box".

**And a TEE alone would not be enough.** This is the part most TEE projects skip. A confidential
agent that also has unbounded authority over funds is just a trusted operator with extra steps —
you have swapped "trust the manager" for "trust the manager's hardware". Tacit's contribution is
the *boundary*: the enclave is given exactly enough authority to be useful and provably no more,
so its confidentiality costs the depositor nothing in safety.

---

## 4. Architecture

```
   Bitstamp XRP/USD                    ┌──────────────────────────────┐
          │                            │  Flare Confidential Compute  │
          │ Web2Json request           │                              │
          ▼                            │   risk budget from vol,      │
   ┌─────────────┐                     │   drawdown, volume           │
   │     FDC     │  ~100 providers     │   yield-tilted venue split   │
   │  fetch, jq, │  fetch and vote     │                              │
   │    vote     │                     │   ── weights never leave ──  │
   └──────┬──────┘                     └───────────┬──────────────────┘
          │ Merkle proof                           │ signed plan
          │ on Coston2                             │ (targets + ref price)
          ▼                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                        TacitVault (ERC-4626)                     │
   │                                                                  │
   │   executeRebalance(plan, signature, proof)                       │
   │     1. FDC proof valid?              4. targets within caps?     │
   │     2. plan bound to THIS signal?    5. turnover within limit?   │
   │     3. ref price within FTSO band?   6. conservation holds?      │
   │                                                                  │
   │   re-derives every transfer from its own ledger                  │
   └───────────┬──────────────────────┬───────────────────┬───────────┘
               ▼                      ▼                   ▼
        Venue A (8%)           Venue B (15%)      Firelight stXRP
        synchronous            synchronous        async exit · real vault
```

### The rebalance lifecycle

1. **Observe.** The relayer builds a Web2Json attestation request for Bitstamp's XRP/USD ticker and
   submits it to `FdcHub`. Roughly 100 data providers independently fetch the URL, apply the same
   jq transform, and vote. The round finalises in 90–180s and a Merkle proof is published.

2. **Decide.** The enclave receives the attested observation plus per-venue metadata (cap, declared
   liquidity, realised rate). It computes a *risk budget* — how much of the vault should be deployed
   at all — from realised volatility, 24h drawdown and volume. It splits that budget across venues,
   tilted toward yield. It signs `(nonce, deadline, signalHash, refPrice, targets)` with its
   registered identity, binding the signature to this chain and this vault.

3. **Enforce.** `executeRebalance` verifies the proof, checks the plan is bound by hash to *that*
   observation, checks the reference price against FTSO, and then **re-derives every transfer from
   its own ledger** rather than trusting any number in the plan. The five invariants are asserted
   against the result.

4. **Settle.** Funds move. `lastSignal` and `lastFtsoPriceMicroUsd` are stored on-chain so the
   inputs behind the allocation stay publicly auditable after the fact.

---

## 5. The trust model

The enclave is authenticated but **not trusted**. Five checks bound what a correctly-signed plan
can do:

| # | Invariant | What it guarantees | Failure mode it prevents |
|---|---|---|---|
| 1 | **Conservation** | Total assets may not fall across a rebalance | Routing funds through a venue that pays the attacker |
| 2 | **Venue cap** | No venue exceeds its configured share | Concentrating everything into one compromised venue |
| 3 | **Turnover + interval** | Rotation between venues is capped; rebalances are spaced | Churning the book to bleed the vault through costs |
| 4 | **FTSO price band** | The claimed reference price sits within 5% of the XRP/USD feed | Acting on an invented price to justify a bad trade |
| 5 | **Signal binding** | The plan is bound by hash to one fresh, attested observation | Computing on fabricated data, or replaying a stale one |

Plus: a monotonic nonce (no replay), a deadline (no stale plans), and chain-and-vault binding in
the signature (no cross-deployment replay).

### What a malicious enclave *can* still do

Pick a legal-but-poor allocation inside the bands, or refuse to act at all. That is **opportunity
cost, not loss**: deposits stay fully redeemable and the share price cannot fall from it. This is
stated plainly rather than buried, because a trust model that only lists its strengths is not a
trust model.

### What it *cannot* do

Move funds out of the vault. Concentrate past a cap. Churn. Act on an invented price. Act on an
observation the data providers never attested. Replay anything.

---

## 6. Prove it yourself

### The adversarial demo

```bash
forge test --match-contract AttackTheEnclave -vv
```

Runs a **malicious enclave against the live contract logic**. Every plan carries a genuine
signature from the registered TEE identity — the enclave is fully authenticated — and each attack
is still rejected:

| Attack | Result |
|---|---|
| Route 50% of the vault through a venue that pays 20% to an attacker | `ConservationViolated` |
| Push 99% into a single 60%-capped venue | `VenueCapExceeded` |
| Claim a $5.00 reference price while FTSO reads ~$1.04 | `PriceOutOfBand` |
| Rebalance again 10 seconds later | `RebalanceTooSoon` |
| Rotate 100% of deployed capital in one step | `TurnoverExceeded` |
| Compute on an invented volume spike, submit the real proof | `SignalMismatch` |
| Replay a genuine but hours-old observation | `SignalStale` |

The final test, `test_whatTheEnclaveCanStillDo`, demonstrates the residual risk instead of hiding
it: a deliberately poor allocation is *accepted*, and every depositor still redeems in full.

### The invariant campaign

```bash
forge test --match-contract MaliciousEnclaveInvariant
```

Hand-written attacks only prove the guardrails stop the attacks *someone thought of*. This is the
stronger claim: a stateful fuzz handler holds the registered TEE key and submits **thousands of
randomly-shaped plans** — arbitrary targets (including over 100%), arbitrary prices, arbitrary
signals, arbitrary timing — interleaved with ordinary deposits and redemptions.

~2,700 hostile plans per invariant, 16,000+ per full run. Properties asserted throughout:

- the enclave can never breach a venue cap *at the moment it acts*
- share price never falls, so value cannot leak
- every share stays backed
- allocation never exceeds assets
- the nonce never regresses

### Cross-language conformance

```bash
forge test --match-contract EnclaveConformance -vv
```

The enclave hashes the plan in Go; the vault re-hashes it in Solidity and recovers the signer. A
one-byte disagreement makes every rebalance fail as `BadSigner`, with both sides looking correct in
isolation. This pins a **real signature vector captured from a live enclave run** and asserts
on-chain recovery. It caught a genuine bug — see [§12](#12-engineering-notes-three-bugs-worth-reading-about).

### Against real, live third-party code

```bash
forge test --match-contract FirelightFork -vv
```

Forks Coston2 and runs against **Firelight stXRP's actual deployed bytecode** — a vault nobody on
this project wrote or controls, holding ~100k FXRP.

---

## 7. Real venues, and what integrating one taught us

Most hackathon vaults allocate between mocks. Tacit ships `ERC4626Venue`, a generic adapter that
exposes **any** ERC-4626 vault as an allocatable venue, and the live deployment uses it to reach
**Firelight stXRP** — a real third-party FXRP vault on Coston2. Every serious FXRP venue is or
wraps an ERC-4626 vault, so one adapter reaches the whole existing stack without `TacitVault`
knowing anything about any of them.

Integrating a real one immediately produced something a mock never would.

### Firelight is asynchronous behind a synchronous interface

`Firelight.withdraw()` does not revert and does not pay. It **burns the shares**, emits
`WithdrawRequest(id)`, returns the full amount, and settles out of band. It is a withdrawal
*queue* wearing an ERC-4626 face.

An adapter that trusted the interface would report the position as **gone** — `totalAssets()` is
derived from a share balance that is now zero — and `TacitVault` would book real, merely-pending
capital as a total loss.

Three defences came out of this, all of them things a mock-only test suite would never have
prompted:

1. **An async tripwire in the adapter.** Shares leaving without assets arriving reverts with
   `AsyncWithdrawalUnsupported`, which unwinds the burn. The position survives. Failing the
   rebalance is strictly better than succeeding with phantom accounting.

2. **`probeSynchronous()`** — a mechanical pre-registration check, so the operator finds out at
   integration time rather than at redemption time.

3. **`liquidOnDemand` as an explicit declaration.** A venue's `maxWithdraw()` is a *claim*, and
   Firelight proves the claim can be false. Liquidity is therefore declared by the operator when
   the venue is registered, and a venue declared illiquid is **never counted toward what depositors
   can redeem** — so quotes are honest from the first call.

   Discovering it at runtime instead is impossible in a way that is worth stating: finding out by
   trying means the attempt reverts, and *a revert rolls back the very flag that would have
   recorded the lesson*.

4. **Venue isolation throughout the vault.** Every call into a venue — `totalAssets`,
   `maxWithdraw`, `withdraw` — is wrapped. A venue that reverts, lies, or hangs contributes nothing
   and everyone else is still served. **No single venue can freeze the vault or block redemption.**

Firelight is registered live with a 30% cap and `liquidOnDemand: false`. Capital can be allocated
there; its balance never inflates redemption quotes.

---

## 8. Flare integration, primitive by primitive

Four primitives, each load-bearing rather than decorative.

### FCC — Flare Confidential Compute

Runs the allocation model. The risk budget, the volatility bounds, the drawdown sensitivity and the
yield tilt never leave the enclave. Built as a custom extension with op type `TACIT/REBALANCE` —
deliberately not `F_`-prefixed and not a reserved command name, because a custom type reusing a
reserved command passes local validation and is then silently never delivered.

*Why it is not decorative:* the confidentiality **is** the product. Remove it and the strategy is
public, and a public strategy is an exploitable one (§3).

### FDC — Flare Data Connector, Web2Json

Attests Bitstamp's XRP/USD ticker on-chain: price, VWAP, high/low, volume and signed 24h change,
verified by ~100 independent data providers. Each plan is bound by hash to exactly one attested
observation, which must be fresh.

*Why it is not decorative:* this is the **input the strategy reacts to**. Without it the enclave
could compute on anything it liked and nobody could check. Web2Json is Flare's newest attestation
type; see [§12](#12-engineering-notes-three-bugs-worth-reading-about) for two undocumented
constraints we mapped empirically.

### FTSO

The XRP/USD feed bounds the reference price the enclave claims to have used, to within 5%.
Decimals are read from the feed rather than hardcoded, because Flare's docs warn they can change.

*Why it is not decorative:* it is not a price display — it is the invariant that makes the
enclave's output **auditable rather than trusted**. Without it, `refPriceMicroUsd` would be an
unfalsifiable claim.

### FAssets / FXRP

The managed asset, settled as a real ERC-20 on Coston2, resolved from `AssetManagerFXRP.fAsset()`
rather than hardcoded. **Six decimals, not 18** — assuming otherwise silently breaks every share
price and threshold in the system.

---

## 9. What is real and what is simulated

"TEE" claims are easy to make and hard to check, so here is the component-by-component truth.

| Component | Status on Coston2 |
|---|---|
| Contracts, vault accounting, all five guardrails | **Real** — deployed, executing, verifiable in the explorer |
| FXRP | **Real** — Flare's own FAsset contract, 6 decimals, not a mock |
| FTSO XRP/USD price feed | **Real** — ~100 independent data providers |
| FDC Web2Json attestation | **Real** — ~100 providers fetch, transform and vote |
| Firelight stXRP venue | **Real** — live third-party vault, ~100k FXRP TVL |
| Enclave code path, identity derivation, signing | **Real** — the same binary that runs under FCC |
| **Hardware attestation quote verification** | **Simulated** — Coston2 runs `SIMULATED_TEE=true` |

Only the last row is simulated, and that is Flare's testnet configuration rather than a shortcut on
our side: Coston2 has no Confidential Space hardware to attest against, and production attestation
rejects simulated quotes by design.

**The design's response is the whole point.** Because the vault never treats the enclave's output
as authoritative, real attestation would upgrade this system from *bounded* to *bounded and
attested*. It would not close a hole, because there is no hole that depends on it. Turning it on is
a deployment change — `MODE=0` on a Confidential Space VM plus an allowlisted image hash — not a
redesign.

This is stated by the enclave's own `/info` endpoint, printed by the relayer on every run, and
shown above the fold in the UI.

---

## 10. Deployed addresses

**Coston2, chain 114.**

| Contract | Address |
|---|---|
| **TacitVault** | [`0xB3834fBa12EB884A240c69c0aB06225930f267e3`](https://coston2-explorer.flare.network/address/0xB3834fBa12EB884A240c69c0aB06225930f267e3) |
| Venue A — 8% APR, synchronous | [`0x49FBEB57dcA5EED7191C5E2193CB2a79f3DdC0B2`](https://coston2-explorer.flare.network/address/0x49FBEB57dcA5EED7191C5E2193CB2a79f3DdC0B2) |
| Venue B — 15% APR, synchronous | [`0xdc08B081c411A9A7bB93AF266f6814F2199995f2`](https://coston2-explorer.flare.network/address/0xdc08B081c411A9A7bB93AF266f6814F2199995f2) |
| **Firelight stXRP adapter** — async exit, 30% cap | [`0x83b5d93127c2d66f4ca44ac0e38abff057621DE5`](https://coston2-explorer.flare.network/address/0x83b5d93127c2d66f4ca44ac0e38abff057621DE5) |
| ↳ wrapping live Firelight stXRP | [`0xC90D6847747b85d1fa2E07859869fb9fB72c0361`](https://coston2-explorer.flare.network/address/0xC90D6847747b85d1fa2E07859869fb9fB72c0361) |
| FXRP (Flare's FAsset) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |
| Enclave identity | `0x89E6C7AD562cf6e664aDBE425E9e323F9A8a3bC5` |

Guardrails as deployed: 60% cap on synchronous venues, 30% on Firelight, 30% max turnover per
rebalance, 300s minimum interval, ±5% FTSO band, 1h maximum signal age.

---

## 11. Running it

### Everything at once

```bash
./demo.sh
```

### Tests

```bash
forge test -vv                # 51 Solidity tests, incl. fork tests against live Firelight
(cd tee && go test ./...)     # 8 Go tests: strategy properties + encoding vectors
```

### UI

```bash
python3 -m http.server 8123 --directory ui
# open http://localhost:8123
```

Zero build step — one ES module and ethers from a CDN, because a demo UI that needs a toolchain is
a UI that breaks during the demo. It renders read-only without a wallet, shows the attestation
status above the fold, flags illiquid venues as `delayed exit`, and draws each venue's on-chain cap
as a marker on its allocation bar so the constraint is visible rather than asserted.

### The enclave

```bash
cd tee
export TACIT_TEE_KEY=<32-byte hex>   # inside FCC this is derived from the TEE
export SIMULATED_TEE=true            # matches Coston2; the demo says so out loud
go run .
```

### A full rebalance

```bash
python3 -m venv .venv && ./.venv/bin/pip install web3
export PRIVATE_KEY=0x...
./.venv/bin/python offchain/relayer.py --vault 0xB3834fBa12EB884A240c69c0aB06225930f267e3
```

Add `--dry-run` to stop before submitting. The FDC round takes 90–180s; the relayer polls and
reports each stage.

### Deploy your own

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url coston2 --broadcast \
  --sig "run(address)" $TEE_IDENTITY
```

Fund the deployer from the [Coston2 faucet](https://faucet.flare.network/coston2) first.

---

## 12. Engineering notes: three bugs worth reading about

Recorded because each cost real time and each would bite anyone building the same thing.

### `abi.encodePacked` pads array elements

`abi.encodePacked` does **not** pad standalone value types but **does** pad array elements to 32
bytes. `abi.encodePacked(uint16[]{1978, 4770})` is 64 bytes, not 4.

The Go enclave packed two bytes per `uint16` — the intuitive reading of "packed" — and produced a
*cryptographically valid signature over the wrong bytes*. On-chain this surfaced only as
`BadSigner`, with both sides looking correct in isolation. `EnclaveConformance.t.sol` exists
because of this, and pins a real vector to stop it recurring.

### The FDC verifier runs a restricted jq subset

`floor`, `round`, `sub` and `ltrimstr` are all rejected with `INVALID: INVALID JQ FILTER`. Every
decimal-to-integer conversion in `offchain/signal_source.py` is therefore done with string
surgery — split on `.`, pad the fraction, slice it — rather than arithmetic. Signed values need
`startswith("-")` branching, because `("-0"|tonumber)` silently loses the sign.

**And most crypto APIs are unreachable from the verifier.** CoinGecko, Binance, Kraken, OKX and
CryptoCompare all return `INVALID: FETCH ERROR`; CoinCap returns `INVALID SOURCE URL`. Bitstamp,
Coinbase, Gemini and Coinpaprika work. Probe any new host with a trivial `{v: 1}` filter first to
tell a fetch failure apart from a filter failure.

The public testnet verifier key is `00000000-0000-0000-0000-000000000000`, so **Web2Json needs no
credential request** — unlike FCC extensions, which need non-self-serve indexer credentials.

### OpenZeppelin 5.x defines `maxWithdraw` in terms of `maxRedeem`

Overriding both in terms of `super` sends them into unbounded mutual recursion — a `StackOverflow`,
not a clean revert. Both now derive from a shared non-recursive helper.

*Also found by the fuzzer, and worth its own line:* withdrawals originally unwound venues in index
order, which drained venue 0 first and left the remainder concentrated in venue 1 — pushing a venue
past a share the enclave itself could never have requested. Unwinding is now pro rata.

---

## 13. Repository layout

```
src/
  TacitVault.sol             ERC-4626 vault, five invariants, venue isolation
  lib/SignalTypes.sol        Signal/plan types and hashes (byte-identical to the enclave)
  interfaces/IVenue.sol      The adapter surface a venue implements
  venues/
    ERC4626Venue.sol         Generic adapter — wraps any ERC-4626 vault (used for Firelight)
    LendingVenue.sol         Yield-bearing testnet venue (see Limitations)
  mocks/Mocks.sol            FXRP, FDC, FTSO doubles + a deliberately thieving venue

tee/
  main.go                    FCC extension: /action, /info, TEE-identity signing
  internal/strategy/         THE CONFIDENTIAL PART — risk budget and venue weighting
  internal/ethabi/           Minimal keccak/secp256k1/ABI, so the image stays small and reproducible
  Dockerfile                 Reproducible build; the hash is what gets allowlisted on-chain

offchain/
  signal_source.py           Web2Json request construction (the jq subset lives here)
  fdc.py                     FdcHub submission + DA-layer proof polling
  relayer.py                 End-to-end: attest → enclave → executeRebalance

ui/                          Depositor view + live guardrail panel (zero-build)
script/                      Coston2 and local deployment

test/
  TacitVault.t.sol             29 tests — accounting, invariants, fuzz
  AttackTheEnclave.t.sol        6 tests — the adversarial demo
  MaliciousEnclaveInvariant.t.sol  6 invariants — thousands of hostile plans
  EnclaveConformance.t.sol      5 tests — Go/Solidity byte compatibility
  FirelightForkIntegration.t.sol 5 tests — against live third-party bytecode
```

---

## 14. Limitations

Stated plainly. A limitation you name is a limitation a judge does not have to find.

**`LendingVenue` is a testnet stand-in.** Coston2 does not host the live FXRP money markets
(Kinetic, SparkDEX, Enosys), so the demo needs venues that actually pay yield for allocation to
mean anything. `IVenue` is the real adapter surface — and `ERC4626Venue` + Firelight proves it
reaches real protocols unchanged.

**Attestation is simulated on Coston2.** See [§9](#9-what-is-real-and-what-is-simulated).

**The relayer is trusted for liveness, not integrity.** It chooses *when* to run and can refuse to
run. It cannot alter an allocation — every value it carries is attested, signed, or re-derived
on-chain.

**Capital in an async venue is not instantly redeemable.** Firelight settles out of band. The 30%
cap bounds how much can be waiting at any moment, and `maxRedeem` never counts it.

**One signal source.** Everything currently rests on Bitstamp. Coinbase, Gemini and Coinpaprika are
verified reachable from the verifier; adding a second is mostly configuration.

**The strategy is deliberately simple.** A volatility-derived risk budget with a yield tilt. The
contribution here is the trust boundary, not the alpha — and the boundary is what makes a
*better* strategy safe to deploy later.

---

## 15. Roadmap

- **Mainnet venue adapters** for Kinetic, SparkDEX and Enosys behind the existing `IVenue`.
- **Async-aware venue adapter** that tracks Firelight's claim tickets, so queued capital is
  accounted rather than merely capped.
- **Real attestation** — `MODE=0` on a Confidential Space VM with a reproducible image hash
  allowlisted on-chain. The invariants do not change; they stop being the only line of defence.
- **Secure Random** (`RandomNumberV2Interface`) to jitter rebalance timing, removing the last
  predictable surface for anyone watching the vault.
- **Fee on yield**, not on TVL, so the operator is paid for allocation quality.

---

## 16. Evidence of new work

The vault, the invariant system, the venue adapter layer, the enclave strategy, the Web2Json signal
pipeline, the relayer and the UI were all written during the program.

Flare-provided infrastructure: the FCC extension scaffold, the periphery contracts, the FDC
verifier and DA layer, FTSO, FXRP.

The contribution is the **trust boundary between a confidential agent and a public vault** — and,
alongside it, an empirical map of what Web2Json can actually do and what happens when you point a
vault at a real third-party venue instead of a mock. Both are documented above rather than left as
folklore.
