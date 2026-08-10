# Using Tacit

A guide to what Tacit is from the outside, and how each kind of user is expected to interact with
it. The [README](README.md) explains *how it is built*; this explains *how it is used*.

**Live on Coston2** — vault [`0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed`](https://coston2-explorer.flare.network/address/0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed)

---

## Contents

- [In one paragraph](#in-one-paragraph)
- [Who interacts with Tacit](#who-interacts-with-tacit)
- [1. Depositors](#1-depositors)
- [2. Integrators and other protocols](#2-integrators-and-other-protocols)
- [3. Relayers](#3-relayers)
- [4. Operators](#4-operators)
- [What you are trusting, exactly](#what-you-are-trusting-exactly)
- [Reading the vault yourself](#reading-the-vault-yourself)
- [Error messages you may see](#error-messages-you-may-see)
- [FAQ](#faq)

---

## In one paragraph

You deposit FXRP and receive **tFXRP**, a standard ERC-4626 share token. A strategy running inside a
confidential enclave decides how that FXRP is spread across yield venues, and reallocates as market
conditions change. You never interact with the enclave. You deposit, you hold a share whose value
rises as the underlying earns, and you withdraw. Everything the enclave is *allowed* to do is
enforced by the vault contract, so you are not trusting the strategy with your money — only with
how well it performs.

---

## Who interacts with Tacit

| You are | You do | You need |
|---|---|---|
| **A depositor** | Deposit FXRP, hold tFXRP, withdraw | A wallet on Coston2 and some FXRP |
| **An integrator** | Treat tFXRP as an ERC-4626 asset | The vault address; nothing else |
| **A relayer** | Trigger rebalances; earn nothing, control nothing | An RPC and gas |
| **An operator** | Register venues, set guardrails, pause | Ownership of the vault |

Only the first two matter to most people. Relayers and operators are described so the trust model
is complete.

---

## 1. Depositors

### What you get

Depositing FXRP mints **tFXRP** shares. tFXRP is a normal ERC-20: transferable, approvable, and
usable anywhere ERC-4626 is understood.

Your share count does not change as yield accrues — the **share price** does. Deposit 100 FXRP at a
share price of 1.00 and you hold shares worth 100 FXRP; when the price reaches 1.04 the same shares
are worth 104 FXRP. This is the standard ERC-4626 model, and it means you never need to claim or
compound anything.

### Depositing

Via the interface:

```bash
python3 -m http.server 8123 --directory ui
# open http://localhost:8123
```

Connect a wallet, enter an amount, press **Deposit**. The first deposit needs one approval
transaction; after that it is a single transaction each time.

Directly, if you prefer:

```bash
# 1. Approve the vault to move your FXRP (amounts are 6dp — 5 FXRP is 5000000)
cast send 0x0b6A3645c240605887a5532109323A3E12273dc7 \
  "approve(address,uint256)" 0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed 5000000 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --private-key $PRIVATE_KEY

# 2. Deposit
cast send 0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed \
  "deposit(uint256,address)" 5000000 $YOUR_ADDRESS \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --private-key $PRIVATE_KEY
```

> **FXRP has 6 decimals, not 18.** 1 FXRP is `1000000`. This trips up nearly everyone once.

To know what you will receive before sending anything:

```bash
cast call $VAULT "previewDeposit(uint256)(uint256)" 5000000 --rpc-url $RPC
```

`previewDeposit` is exact — it returns precisely what `deposit` will mint under current conditions.

### Withdrawing

Press **Withdraw** in the interface, or:

```bash
# By asset amount
cast send $VAULT "withdraw(uint256,address,address)" 5000000 $YOU $YOU ...

# Or burn all your shares
SHARES=$(cast call $VAULT "maxRedeem(address)(uint256)" $YOU --rpc-url $RPC)
cast send $VAULT "redeem(uint256,address,address)" $SHARES $YOU $YOU ...
```

**Always check `maxRedeem` or `maxWithdraw` first.** They tell you what the vault can actually pay
*right now*, which may be less than your full position — see below.

### When you cannot withdraw everything immediately

Some venues do not return funds on demand. Firelight stXRP, which this vault allocates to, settles
withdrawals through a queue: it accepts the request and pays later.

Tacit handles this by being honest rather than optimistic:

- Venues that settle late are marked **`delayed exit`** in the interface.
- Their balance is **never counted** toward `maxRedeem` or `maxWithdraw`. Your quote reflects what
  the vault can genuinely pay today.
- Such venues are **capped** (30% in the live deployment), so at most that fraction of the vault can
  be waiting at any moment.

So `maxRedeem` may be less than your full balance. The remainder is not lost — it stays yours, and
becomes redeemable as the vault's liquid position recovers. Nothing about this is discretionary:
it is arithmetic you can check yourself with `allocations()`.

### Fees

None. There is no deposit fee, no withdrawal fee and no management fee in this deployment. A
performance fee on yield is on the roadmap; it is not implemented, and no code path can take one.

---

## 2. Integrators and other protocols

tFXRP is a **standard ERC-4626 vault share**. If your protocol already handles ERC-4626, it handles
tFXRP with no special cases.

```solidity
IERC4626 tacit = IERC4626(0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed);

tacit.asset();                       // FXRP
tacit.totalAssets();                 // FXRP under management
tacit.convertToShares(assets);       // conversion, ignoring limits
tacit.previewDeposit(assets);        // exact shares a deposit returns
tacit.maxWithdraw(owner);            // what can genuinely be paid now
```

Discoverable on-chain via ERC-165:

```solidity
tacit.supportsInterface(type(IERC4626).interfaceId); // true
```

### Two things worth knowing

**`maxWithdraw` is a real constraint, not a formality.** Many vaults return the full balance
unconditionally. Tacit subtracts venues that cannot pay on demand. If you build on top of it,
respect `maxWithdraw` rather than assuming `convertToAssets(balanceOf(user))` is claimable.

**Share decimals are asset decimals + 3.** FXRP is 6dp, so tFXRP is 9dp. The offset is a standard
defence against first-depositor share-price manipulation. Use `decimals()` rather than assuming.

### Events to index

```solidity
event Deposit(address caller, address owner, uint256 assets, uint256 shares);   // ERC-4626
event Withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares);
event Rebalanced(uint256 nonce, bytes32 signalHash, uint256 before, uint256 after_, uint256 turnover);
event RebalanceRequested(uint256 nonce, uint256 totalAssets, uint64 timestamp);
```

`Rebalanced` is the interesting one: it gives you the allocation history and the hash of the market
observation each decision was based on. Pair it with `lastSignal()` to see the actual inputs.

---

## 3. Relayers

Rebalancing is **permissionless**. Anyone may run the relayer, and running it grants no privilege.

```bash
# 1. Signal that a rebalance is wanted (anyone, anytime)
cast send $VAULT "requestRebalance()" --rpc-url $RPC --private-key $PRIVATE_KEY

# 2. Run the pipeline: attest a market observation, ask the enclave, submit the result
./.venv/bin/python offchain/relayer.py --vault $VAULT
```

A relayer decides *when* a rebalance is attempted and can refuse to run. It cannot influence *what*
the allocation is: every value it carries is either attested by the Flare Data Connector, signed by
the enclave, or re-derived by the vault from its own ledger. A hostile relayer is a liveness
problem, never a safety one.

> **Current status:** the shipped signal source validates at the FDC verifier but is not attested by
> the data providers, so a live rebalance cannot complete yet. This is the one open gap in the
> project and it is described in [README §14](README.md#14-limitations).

---

## 4. Operators

The owner can register venues, adjust guardrails within bounds, pause, and rotate the enclave
identity. The owner **cannot** move user funds, mint shares, or bypass any invariant.

```solidity
addVenue(venue, capBps, liquidOnDemand);   // liquidOnDemand: does it pay on demand?
setVenueCap(venueId, capBps);
deactivateVenue(venueId);                  // repatriates funds, best-effort
setTeeIdentity(identity);
setGuardrails(turnover, interval, band, signalAge, conservationTolerance);
pause() / unpause();
```

### Two deliberate asymmetries

**Pausing stops deposits, never withdrawals.** An operator who can freeze exits can rug. So the
emergency control only stops new money entering and new allocations going out; redemption keeps
working while paused. This is asserted by a test, not just documented.

**Guardrails can be tightened but not disabled.** `setGuardrails` rejects a zero turnover cap, a
zero or greater-than-20% price band, and a conservation tolerance above 1%. There is no
configuration in which the enclave becomes unbounded.

Ownership transfer is two-step (`transferOwnership` then `acceptOwnership`), so a mistyped address
cannot orphan the vault.

---

## What you are trusting, exactly

Worth being precise, because "an AI manages your money" deserves scrutiny.

**You are trusting:** that the strategy makes reasonable allocation choices. A bad strategy earns
less than a good one, or sits in cash when it should be deployed.

**You are not trusting it with custody.** The enclave cannot move funds out of the vault,
concentrate past a venue cap, churn the book, act on a price the market never printed, or act on
data the FDC never attested. These are contract-level checks, and every one of them is exercised by
tests that run a *correctly signed* malicious plan and watch it fail.

The worst a fully compromised enclave can do is pick a legal-but-poor allocation, or refuse to act.
That is opportunity cost. Your deposit stays redeemable.

**One caveat stated plainly:** on Coston2 the hardware attestation quote is simulated, because
Flare's testnet has no Confidential Space hardware to attest against. Everything else — the
contracts, FXRP, FTSO, the FDC, the enclave binary and its signing — is real. The five on-chain
guardrails are precisely why the design does not depend on that quote being genuine.

---

## Reading the vault yourself

You do not have to take any of this on trust.

```bash
RPC=https://coston2-api.flare.network/ext/C/rpc
VAULT=0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed

# Size and share price
cast call $VAULT "totalAssets()(uint256)"        --rpc-url $RPC
cast call $VAULT "convertToAssets(uint256)(uint256)" 1000000000 --rpc-url $RPC  # one whole share

# Where the money is: per-venue balances, then idle
cast call $VAULT "allocations()(uint256[],uint256)" --rpc-url $RPC

# The limits the enclave operates under
cast call $VAULT "maxTurnoverBps()(uint16)"      --rpc-url $RPC
cast call $VAULT "priceBandBps()(uint16)"        --rpc-url $RPC
cast call $VAULT "maxSignalAge()(uint32)"        --rpc-url $RPC

# The exact market observation behind the last decision:
#   price (micro-USD), 24h volume (USD), then returns over 1h / 6h / 24h in basis points
cast call $VAULT "lastSignal()(uint256,uint256,int256,int256,int256)" --rpc-url $RPC
cast call $VAULT "lastFtsoPriceMicroUsd()(uint256)" --rpc-url $RPC
```

That last pair is the point. The strategy is private; its **inputs are public**. You can see exactly
what the agent saw, compare it against the FTSO price recorded at the same moment, and judge the
allocation it produced — without anyone having to explain themselves.

---

## Error messages you may see

| Message | Meaning | What to do |
|---|---|---|
| `ERC20: insufficient allowance` | The vault is not approved to move your FXRP | Approve first |
| `InsufficientLiquidity` | You asked for more than the vault can pay now | Use `maxWithdraw` |
| `ERC4626ExceededMaxRedeem` | Same, expressed in shares | Use `maxRedeem` |
| `EnforcedPause` | Deposits are paused | Withdrawals still work |
| `RebalanceTooSoon` | A rebalance came too soon after the last | Wait out the interval |
| `PriceOutOfBand` | The plan's price disagreed with FTSO | Working as intended — a guardrail fired |
| `SignalStale` / `SignalMismatch` | The plan was not bound to a fresh attested observation | Working as intended |
| `ConservationViolated` / `VenueCapExceeded` / `TurnoverExceeded` | A rebalance would have broken an invariant | Working as intended |

The last five are not bugs. They are the vault refusing an allocation, which is the behaviour the
whole design exists to provide.

---

## FAQ

**Can the team take my money?**
No. The owner can register venues and adjust guardrails within bounds, but there is no function
that transfers user funds to an arbitrary address, and no configuration that creates one.

**Can the AI lose my money?**
It can allocate poorly, which costs you yield. It cannot move funds out of the vault. Venue risk is
separate and real: if a venue itself fails, capital allocated there is affected — which is what the
per-venue caps bound.

**What happens if the enclave goes offline?**
Nothing breaks. The vault stops rebalancing and holds its current allocation. Deposits and
withdrawals are unaffected; they never touch the enclave.

**How do I know the strategy acted on real data and not something invented?**
`lastSignal()` returns the exact observation behind the last allocation, and that observation only
reached the chain by being attested by ~100 independent FDC data providers. The plan is bound to it
by hash, so the enclave cannot compute on one thing and submit another — `SignalMismatch` rejects
it. You can also compare `lastFtsoPriceMicroUsd()` against the FTSO feed for that block: the vault
already refused anything more than 5% away from it.

**Why can't I withdraw my full balance sometimes?**
Because part of it is in a venue that settles withdrawals late. The vault tells you the truth up
front through `maxRedeem` rather than letting you discover it in a failed transaction.

**Is this audited?**
No. It is a hackathon project with 60 tests, including a fuzz campaign that runs thousands of
hostile enclave plans and fork tests against live third-party contracts. That is not an audit. Do
not put money you care about into it.

**Which network?**
Coston2, Flare's testnet. The FXRP here is testnet FXRP with no monetary value.
