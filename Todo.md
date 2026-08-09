# Todo

Status **2026-08-09**. Deadline **2026-08-14 19:59 UTC** — five days.

---

## Done

- Faucet claimed; deployer funded.
- **Deployed to Coston2** — `0xB3834fBa12EB884A240c69c0aB06225930f267e3`, three venues, seeded.
- **Real third-party venue integrated** — `ERC4626Venue` wrapping live Firelight stXRP (~100k FXRP).
- **Async-vault hazard found and defended** — Firelight burns shares without paying; adapter now
  reverts rather than booking phantom losses, and `liquidOnDemand` keeps redemption quotes honest.
- **Venue isolation** — no single venue can freeze the vault or block redemption.
- **Invariant fuzz campaign** — 6 invariants, ~16,000 hostile plans per run, all holding.
- **UI live against Coston2**, flags illiquid venues.
- README rewritten as the primary explainer.

**51 Solidity tests + 8 Go tests passing.**

---

## Critical path

### 1. First real end-to-end rebalance — THE remaining milestone

Still the only thing never run against live infrastructure. Every piece is verified in isolation;
the full loop has not executed once.

```bash
(cd tee && TACIT_TEE_KEY=$TACIT_TEE_KEY SIMULATED_TEE=true go run .) &
./.venv/bin/python offchain/relayer.py --vault 0xB3834fBa12EB884A240c69c0aB06225930f267e3 --dry-run
./.venv/bin/python offchain/relayer.py --vault 0xB3834fBa12EB884A240c69c0aB06225930f267e3
```

Budget a full day:
- [ ] `build_proof_tuple()` decodes the DA response — **untested against a real payload**. Most
      likely thing to be wrong.
- [ ] FDC round takes 90–180s; the DA layer returns 200 with an empty proof until finalisation.
- [ ] Bitstamp's `timestamp` must still be inside `maxSignalAge` (1h) when the round finalises.
- [ ] The vault holds only 4 FXRP — claim the faucet again first so allocations are visible.

### 2. Claim the faucet again

10 FXRP per address per 24h. More capital makes the demo legible.
Address: `0x8C6eE34413f0c7D472Ab157fbED84De1234EF54F`

### 3. Verify contracts on the explorer

`forge script` auto-verify fails — the explorer's Etherscan-compatible API returns a shape `forge`
cannot deserialise. Verify manually so judges can read the source.

### 4. Demo video

- [ ] Deposit in the UI; show the guardrail panel and the `delayed exit` flag
- [ ] Trigger a rebalance; show the FDC round finalising and allocation bars moving
- [ ] **Money shot:** `forge test --match-contract AttackTheEnclave -vv`
- [ ] **Second money shot:** the invariant campaign — thousands of hostile plans, all bounded
- [ ] Close on the trust boundary: strategy quality vs fund safety

### 5. Submit by midday 2026-08-14

- [ ] Both bounties
- [ ] Lead with the Firelight integration and the async finding — that is what separates this from
      a vault that allocates between mocks
- [ ] State the simulated-attestation limitation in the submission itself

---

## Should do if time allows

- [ ] **Second FDC source** (Coinbase/Gemini/Coinpaprika all verified reachable) — removes the
      single point of failure at demo time.
- [ ] **Attack console in the UI** — put the adversarial tests in front of a judge who never opens
      a shell.
- [ ] **Rebalance history** — index `Rebalanced` events; allocation over time is the most
      persuasive evidence the strategy does anything.
- [ ] **`requestRebalance` → relayer watcher**, so the loop is genuinely autonomous.
- [ ] Async-aware adapter tracking Firelight claim tickets.

---

## Known gaps — say these out loud in the submission

**`LendingVenue` is a testnet stand-in.** Coston2 has no live FXRP money markets. Firelight proves
the adapter reaches real protocols; do not overstate the others.

**Attestation is simulated.** Only the hardware quote check. Everything else is real.

**The relayer is trusted for liveness, not integrity.**

**Async venue capital is not instantly redeemable.** Bounded by the 30% cap; never counted in
`maxRedeem`.

**Git is still not initialised. No commits yet.**

---

## Repo state

| Area | Status |
|---|---|
| Contracts | 51 Solidity tests passing |
| Enclave (Go) | 8 tests, vet + gofmt clean |
| Web2Json pipeline | Request verified `VALID` against the live verifier |
| Relayer | Written, **never run end-to-end** |
| UI | Live against Coston2 |
| Deployment | **Live**, seeded, unverified in the explorer |
| Git | **Not initialised** |
