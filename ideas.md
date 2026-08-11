# Ideas

Candidates for making Tacit stand out, ranked by what each one buys per hour spent.

Deadline **2026-08-14 19:59 UTC** — four days, and a demo video plus two bounty
submissions still have to come out of that. Treat anything below Tier 2 as unlikely to
happen, and that is fine: the list exists to make the cut deliberate rather than accidental.

The thesis worth reinforcing is the one in the footer of the UI: **the enclave controls
strategy quality, never fund safety.** Every idea below is scored on whether it makes that
claim harder to doubt. Ideas that add surface area without adding credibility are ranked
low on purpose.

---

## Tier 1 — most credibility per hour

### 1. A live attack button: let a judge try to steal the funds

Today the adversarial proof lives in `forge test --match-contract AttackTheEnclave`. A judge
who never opens a shell never sees it, and a judge who does still has to trust our harness.

Instead: buttons in the UI that build a **genuinely malicious plan**, sign it with the
**real enclave key**, submit it to the **live vault on Coston2**, and show the revert.

Why this is the strongest idea here:

- It produces a real failed transaction with a real explorer link. There is nothing left to
  take on trust.
- It converts the project's central claim from an assertion into an artifact.
- The signature is *valid*. The plan is rejected anyway. That is exactly the point being
  made, and no amount of prose makes it as well.

Shape: five presets, one per guardrail — exceed venue cap, exceed turnover, violate
conservation, use a stale signal, use an off-band price. Each shows the guardrail that
rejected it and links the failed tx. `cleanError()` in `ui/app.js` already decodes every one
of those custom errors by name, so the display work is nearly free.

**Key handling matters here.** Do not put the enclave key in the page. Add an `/attack`
endpoint to the existing `tee/` service that signs a caller-chosen hostile plan; the browser
asks for a signature and relays it on-chain from the visitor's own wallet. The key stays
where it already is, and the visitor pays the gas for their own failed attack.

Cost: about half a day. The signing path exists in `tee/main.go`; the guardrails exist; the
error decoding exists.

### 2. `verify.sh` — independent verification in one command

A script a judge runs that, without trusting anything we wrote:

1. fetches the same Coinpaprika observation the relayer attested,
2. reads `lastSignal()` from the live vault,
3. resolves the FDC voting round the proof came from,
4. prints whether the three agree.

This is the difference between "our README claims the loop is real" and "here, check it
yourself". Everything it needs is already public and on-chain.

Cost: 2–3 hours.

### 3. Liveness-failure demo: kill the enclave, withdraw anyway

The first question anyone asks about a TEE strategy is what happens when the box dies.
Answer it on camera: stop the relayer and the `tee/` service completely, then withdraw.
It works, because withdrawal never consults the enclave — but saying so is weaker than
showing it.

Cost: about an hour, nearly all of it recording. No new code.

### 4. Deposit more, and rebalance more than once

Todo item 1, restated because it gates two other ideas. At nonce 1 and ~2.2 FXRP, any
history view is a single dot and any "the strategy responds to the signal" claim rests on
one data point. Several rebalances at a larger size make the rest of the demo legible.

Cost: an hour of faucet claims and relayer runs. The UI now tells you when you are short.

---

## Tier 2 — strong, if the days allow

### 5. Rebalance history from `Rebalanced` events

Allocation over time is the most persuasive evidence the strategy does anything at all. A
static pie chart shows a decision; a timeline shows a *policy*. Index the events, draw a
stacked area chart under the allocation card, and let each point link to its transaction.

Depends on idea 4 — with one rebalance there is nothing to plot.

Cost: half a day. Already on Todo's "if time allows".

### 6. `requestRebalance` → relayer watcher

The button exists and emits; nothing listens. Wiring a watcher makes the loop genuinely
autonomous rather than manually triggered, and it lets a judge push the button and watch the
FDC round finalise without us touching a terminal.

The honest caveat to keep saying: this makes the relayer *responsive*, not *trusted*. It
still cannot alter an allocation.

Cost: 3–4 hours.

### 7. Second signal source

Gemini and Coinbase both attest. Each has a different field set, so this widens the DTO
rather than swapping a URL. Two independent sources removes a demo-time single point of
failure and, more interestingly, lets the enclave cross-check them — a disagreement between
venues is itself a signal worth acting on.

Cost: half a day, mostly in the DTO and the JQ. Note the Web2Json JQ subset is restricted
(no `floor`, `round`, `sub`), which is what shaped the current DTO — budget for that.

### 8. Guardrail headroom, live

Each guardrail currently shows its configured limit. Show the *distance to it*: turnover at
12% of a 30% ceiling, largest venue at 22% of a 30% cap. It reframes the panel from a list
of rules into a live risk instrument, and it makes the attack console's rejections legible
before the attack is even run.

Cost: 2 hours. Pure UI; every number is already fetched.

---

## Tier 3 — good ideas, probably not this week

### 9. Async-aware adapter tracking Firelight claim tickets

The correct fix for async withdrawals rather than the current bound-and-exclude approach.
Real engineering value, low demo value, and the existing defence is already honest about
what it does.

### 10. Enclave attestation document display

Show the quote's fields and say plainly which of them Coston2 simulates. Turns the caveat
into a feature — but the banner already states it, and this risks drawing attention to the
weakest link rather than the strongest.

### 11. Multi-strategy comparison

Run two enclave strategies against the same attested signal and show both. Genuinely
interesting; a week of work.

---

## Deliberately not doing

**Mainnet deployment.** Real funds, no time to earn that confidence, and the guardrail story
is identical on testnet.

**Removing the simulated-attestation caveat.** It is stated in the banner, the README, and
will be in the submission. Burying it would trade the one thing this project has most of —
credibility — for a marginal gain in polish.

**A prettier landing page.** The current UI reads as an instrument. Judges for a security
bounty are not scoring gradients.

---

## If only one thing gets built

**Idea 1, the attack console.** Everything else here explains the project. That one *proves*
it, in public, on-chain, against a fully authenticated malicious enclave — which is the
single claim the whole submission rests on.

