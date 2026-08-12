# Explanation

## TL;DR

Tacit is a confidential autonomous treasury for FXRP. Depositors hold a plain
ERC-4626 share; a strategy running inside a Flare Confidential Compute enclave
reads FDC-attested market data and reallocates across FXRP yield venues. The
enclave decides *what* to do; the vault enforces, in Solidity, what it is
*allowed* to do — five invariants that make it impossible for a compromised
strategy to move funds out, over-concentrate, churn the book, or act on a
price the market never printed. **The enclave controls strategy quality,
never fund safety.**

---

## Screen-recording voice-over (before you take over)

Pacing target: ~140 wpm. The whole thing runs about 75 seconds. Cues in
brackets tell you what should be on screen for each line — do not read the
brackets aloud.

---

**[Vault page. Hero visible: TVL, Your position, Share price.]**

This is Tacit — a confidential autonomous treasury for FXRP on Flare.
Depositors hold an ordinary ERC-4626 share. The strategy that decides where
the capital goes runs inside a Flare Confidential Compute enclave.

**[Scroll so the Deposit / Withdraw card and the Coston2 / Base Sepolia
source picker are both in frame.]**

The deposit path is chain-agnostic by design — any chain LayerZero reaches
can be wired up as a source. For this deployment we've enabled two:
Coston2 directly, and Base Sepolia in a single LayerZero transaction. Both
routes credit the same vault, and shares terminate as tFXRP on Coston2
either way.

**[Scroll down to Current allocation. Pie chart and venue bars visible.]**

Underneath, the vault splits its capital across three yield venues — one of
which is Firelight stXRP, a real third-party FXRP vault. The allocation
you're looking at was decided by the enclave and executed by the vault.

**[Click into Strategy. Guardrail cards visible, ideally with Conservation
expanded.]**

The enclave is authenticated but not trusted. Five on-chain guardrails —
conservation, venue cap, turnover, an FTSO price band, and signal freshness
— bound every plan it can submit. A plan that would violate any of them
reverts.

**[Scroll to Last attested signal.]**

The inputs the strategy reads are public and attested by roughly a hundred
independent Flare Data Connector providers. The *mapping* from those inputs
to an allocation is what stays inside the enclave.

**[Click into Activity. Event list visible.]**

Every rebalance, deposit and withdrawal is here — read directly from
Coston2, not from an indexer.

**[Return to Vault page, or hold on Activity — your call.]**

From here I'll walk you through…
