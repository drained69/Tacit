# Todo

Status **2026-08-10**. Deadline **2026-08-14 19:59 UTC**.

---

## Done

- **The full loop runs on-chain.** Coinpaprika observation attested by ~100 FDC providers → enclave
  allocation → `executeRebalance` through every guardrail. Nonce 1, 0.71 FXRP deployed.
  [tx `0xa3153a9b…7301`](https://coston2-explorer.flare.network/tx/0xa3153a9b722377a46b2e8155120c2cd392b5cba494a2adf8d3da22ea1b977301)
- Signal reshaped around a source the providers actually fetch; freshness now derived from the
  attestation's voting round rather than a payload timestamp.
- Standards conformance: ERC-4626/165, Ownable2Step, Pausable, reentrancy guards on every entry
  point (this closed a real bug — venues are called before shares are burned).
- Real third-party venue (Firelight stXRP) integrated, with its async-withdrawal hazard defended.
- Invariant campaign: ~16,000 hostile plans per run, all bounded.
- UI live against the deployment; README + Explanation.md written.

**61 Solidity + 10 Go tests passing.**

---

## Remaining

### 1. Claim the faucet, deposit more

The vault holds ~2.2 FXRP. Everything works at that size but the demo reads better with more.
Address: `0x8C6eE34413f0c7D472Ab157fbED84De1234EF54F` — 10 FXRP per address per 24h.

### 2. Verify contracts on the explorer

`forge script` auto-verify fails: the explorer's Etherscan-compatible API returns a shape `forge`
cannot deserialise. Verify manually so judges can read the source.

```bash
forge verify-contract 0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed src/TacitVault.sol:TacitVault \
  --chain 114 --verifier-url https://coston2-explorer.flare.network/api --etherscan-api-key any \
  --constructor-args $(cast abi-encode "constructor(address,string,string,address)" \
    0x0b6A3645c240605887a5532109323A3E12273dc7 "Tacit FXRP" "tFXRP" \
    0x8C6eE34413f0c7D472Ab157fbED84De1234EF54F)
```

### 3. Demo video

- [ ] Deposit in the UI; show the guardrail panel and the `delayed exit` flag
- [ ] Run the relayer live — the FDC round finalising is the moment worth filming
- [ ] Show `lastSignal()` on-chain matching what the relayer printed
- [ ] **Money shot:** `forge test --match-contract AttackTheEnclave -vv`
- [ ] **Second:** the invariant campaign — thousands of hostile plans, all bounded
- [ ] Close on the trust boundary: strategy quality vs fund safety

### 4. Submit by midday 2026-08-14

- [ ] Both bounties
- [ ] Lead with: the loop runs, it allocates into a real third-party vault, and the guardrails are
      proven against a fully authenticated malicious enclave
- [ ] State the simulated-attestation limitation in the submission itself

---

## Worth doing if time allows

- [ ] **Second signal source.** Gemini and Coinbase attest; each has a different field set, so this
      widens the DTO rather than swapping a URL. Removes a demo-time single point of failure.
- [ ] **Attack console in the UI** — put the adversarial tests in front of a judge who never opens
      a shell.
- [ ] **Rebalance history** — index `Rebalanced` events; allocation over time is the most
      persuasive evidence the strategy does anything.
- [ ] **`requestRebalance` → relayer watcher**, so the loop is genuinely autonomous rather than
      manually triggered.
- [ ] Async-aware adapter tracking Firelight claim tickets.

---

## Known gaps — say these out loud in the submission

**`LendingVenue` is a testnet stand-in.** Coston2 has no live FXRP money markets. Firelight proves
the adapter reaches real protocols; do not overstate the other two.

**Attestation is simulated.** Only the hardware quote check. Everything else is real.

**The relayer is trusted for liveness, not integrity.** It chooses when to run; it cannot alter an
allocation.

**Async venue capital is not instantly redeemable.** Bounded by the 30% cap, never counted in
`maxRedeem`.

**Small TVL.** ~2.2 FXRP, faucet-limited.

---

## Repo state

| Area | Status |
|---|---|
| Contracts | 61 Solidity tests passing |
| Enclave (Go) | 10 tests, vet + gofmt clean |
| Web2Json pipeline | **Attested live**; proof verified by the real `FdcVerification` |
| Relayer | **Run end to end successfully** |
| UI | Live against Coston2 |
| Deployment | Live, seeded, one rebalance executed; unverified in the explorer |
| Git | 8 commits |
