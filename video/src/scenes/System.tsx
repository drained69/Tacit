import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { c, code } from "../theme";
import { Heading, Panel, Pill, Reveal, Stage } from "../components/ui";

/* ── 5. Architecture ──────────────────────────────────────────────────── */

/** Vertical connector with a travelling pulse, so the data flow is legible
 *  as motion rather than needing a caption to explain direction. */
const Wire: React.FC<{ label: string; delay: number; h?: number }> = ({ label, delay, h = 46 }) => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame - delay, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const p = interpolate(frame - delay, [8, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, height: h, paddingLeft: 46 }}>
      <div style={{ position: "relative", width: 2, height: h, background: c.line }}>
        <div style={{ position: "absolute", inset: 0, height: `${grow * 100}%`, background: c.accentDim }} />
        <div
          style={{
            position: "absolute",
            left: -3,
            top: `${p * (h - 8)}px`,
            width: 8,
            height: 8,
            borderRadius: 4,
            background: c.accent,
            opacity: p > 0 && p < 1 ? 1 : 0,
          }}
        />
      </div>
      <div style={{ fontFamily: code, fontSize: 19, color: c.muted, opacity: grow }}>{label}</div>
    </div>
  );
};

const Band: React.FC<{
  zone: string;
  zoneColor: string;
  title: string;
  body: React.ReactNode;
  delay: number;
}> = ({ zone, zoneColor, title, body, delay }) => (
  <Reveal delay={delay}>
    <Panel accent={zoneColor} style={{ padding: "20px 28px", display: "flex", gap: 30, alignItems: "center" }}>
      <div style={{ width: 250, flexShrink: 0 }}>
        <div style={{ fontFamily: code, fontSize: 16, letterSpacing: "0.14em", color: zoneColor }}>
          {zone}
        </div>
        <div style={{ fontSize: 27, fontWeight: 600, marginTop: 6 }}>{title}</div>
      </div>
      <div style={{ fontSize: 22, color: c.muted, lineHeight: 1.5 }}>{body}</div>
    </Panel>
  </Reveal>
);

export const SceneArchitecture: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Architecture"
      title="Four zones, and only one of them is trusted"
      sub="Data is attested before the agent sees it. The agent's output is checked before the vault acts on it."
    />

    <div style={{ marginTop: 4 }}>
      <Band
        delay={40}
        zone="OFF-CHAIN DATA"
        zoneColor={c.s1}
        title="FDC Web2Json"
        body={
          <>
            A public market-data endpoint is fetched by roughly a hundred independent Flare
            attestation providers. They apply the same JQ transform and vote on the result, which
            lands in a Merkle tree the vault can check.
          </>
        }
      />
      <Wire label="attested signal + Merkle proof" delay={70} />
      <Band
        delay={82}
        zone="CONFIDENTIAL"
        zoneColor={c.s3}
        title="The enclave"
        body={
          <>
            Runs in Flare Confidential Compute. Reads the attested numbers, computes target weights
            per venue, and signs the plan with a key that only exists inside the TEE. The strategy
            itself never leaves.
          </>
        }
      />
      <Wire label="signed plan" delay={112} />
      <Band
        delay={124}
        zone="UNTRUSTED"
        zoneColor={c.dim}
        title="The relayer"
        body={
          <>
            Requests the attestation, collects the proof, and submits both to the vault. It holds no
            keys and no privileges — anyone can run it, and a hostile one can only stall, never
            steal.
          </>
        }
      />
      <Wire label="submitRebalance(plan, proof, signature)" delay={154} />
      <Band
        delay={166}
        zone="ON-CHAIN"
        zoneColor={c.accent}
        title="TacitVault"
        body={
          <>
            Verifies the proof against the FDC verification contract, checks the signature against
            the registered TEE identity, reads the FTSO price reference, then enforces five
            invariants before a single token moves.
          </>
        }
      />
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={210}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 22, color: c.dim, marginRight: 8 }}>Capital lands here:</span>
        <Pill color={c.s1}>VENUE A · 8% APR · SYNC</Pill>
        <Pill color={c.s2}>VENUE B · 15% APR · SYNC</Pill>
        <Pill color={c.s3}>FIRELIGHT stXRP · ASYNC EXIT</Pill>
        <Pill color={c.idle}>IDLE · held in vault</Pill>
      </div>
    </Reveal>
  </Stage>
);

/* ── 6. Rebalance lifecycle ───────────────────────────────────────────── */

const STEPS = [
  {
    n: "1",
    name: "Observe",
    who: "Relayer",
    color: c.s1,
    body: "The relayer asks FDC to attest a market-data snapshot. ~100 providers fetch the same URL, apply the same JQ transform, and vote. The signal is now a fact the chain can check — nobody has to be trusted to report it honestly.",
  },
  {
    n: "2",
    name: "Decide",
    who: "Enclave",
    color: c.s3,
    body: "Inside the TEE, the strategy reads the attested numbers and produces target weights per venue. It signs the plan with its enclave key. The weights are visible on submission; the reasoning that produced them is not.",
  },
  {
    n: "3",
    name: "Enforce",
    who: "Vault",
    color: c.accent,
    body: "The vault re-derives the signal hash from the proof, confirms the signature came from the registered TEE identity, pulls a fresh FTSO price, and runs every invariant. Any failure reverts the whole transaction.",
  },
  {
    n: "4",
    name: "Settle",
    who: "Vault",
    color: c.good,
    body: "Only now does capital move. Venue adapters withdraw and deposit to reach the targets; total assets are re-measured from the adapters afterwards, never assumed from the plan.",
  },
];

export const SceneLifecycle: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage>
      <Heading
        eyebrow="One rebalance, end to end"
        title="Observe → Decide → Enforce → Settle"
        sub="The vault enforces a 300-second floor between rebalances. Beyond that, the enclave decides when acting is worth the gas."
      />

      <div style={{ display: "flex", gap: 18, flex: 1 }}>
        {STEPS.map((s, i) => {
          const delay = 44 + i * 62;
          const on = frame >= delay;
          const active = frame >= delay && frame < delay + 78;
          return (
            <Reveal key={s.n} delay={delay} style={{ flex: 1 }}>
              <div
                style={{
                  height: "100%",
                  background: c.panel,
                  border: `1px solid ${active ? s.color : c.line}`,
                  borderRadius: 10,
                  padding: "26px 26px 30px",
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: active ? `0 0 0 1px ${s.color}44, 0 14px 40px ${s.color}18` : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 21,
                      background: on ? s.color : c.line,
                      color: c.bg,
                      fontFamily: code,
                      fontSize: 22,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {s.n}
                  </div>
                  <div>
                    <div style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1 }}>{s.name}</div>
                    <div style={{ fontFamily: code, fontSize: 17, color: s.color, letterSpacing: "0.1em" }}>
                      {s.who.toUpperCase()}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.55 }}>{s.body}</div>
              </div>
            </Reveal>
          );
        })}
      </div>

      <Reveal delay={300}>
        <div
          style={{
            marginTop: 28,
            borderTop: `1px solid ${c.line}`,
            paddingTop: 24,
            fontSize: 26,
            color: c.muted,
          }}
        >
          Steps 1 and 2 decide <span style={{ color: c.text }}>where the money should go</span>. Step
          3 decides <span style={{ color: c.text }}>whether that is allowed</span>. They are separate
          on purpose — and step 3 is the one the depositor relies on.
        </div>
      </Reveal>
    </Stage>
  );
};

/* ── 7. The five invariants ───────────────────────────────────────────── */

const INVARIANTS = [
  {
    name: "Conservation",
    check: "totalAssets() cannot fall by more than the slippage tolerance across a rebalance",
    stops: "A plan that quietly loses value — including one that routes through a bad swap",
    err: "ConservationViolated",
  },
  {
    name: "Venue caps",
    check: "No single venue may hold more than its configured share of the vault",
    stops: "Concentrating the whole treasury into one protocol",
    err: "VenueCapExceeded",
  },
  {
    name: "Turnover budget",
    check: "Only a bounded fraction of the vault may move per rebalance",
    stops: "Draining by a thousand legal-looking small steps",
    err: "TurnoverExceeded",
  },
  {
    name: "Price band",
    check: "Execution price must sit inside a band around the FTSO reference",
    stops: "Trading against a manipulated pool",
    err: "PriceOutOfBand",
  },
  {
    name: "Signal freshness",
    check: "The plan must reference a signal the FDC attested, recently, and match its hash",
    stops: "Replaying an old favourable signal, or inventing one",
    err: "SignalStale / SignalMismatch",
  },
];

export const SceneInvariants: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What the chain enforces"
      title="Five invariants stand between the agent and your deposit"
      sub="These are not warnings or monitored thresholds. Each one is a require in the rebalance path — fail any, and the transaction reverts with a named error."
    />

    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px 1fr 1fr 300px",
          gap: 18,
          fontFamily: code,
          fontSize: 17,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: c.dim,
          padding: "0 24px 12px",
          borderBottom: `1px solid ${c.line}`,
        }}
      >
        <div>Invariant</div>
        <div>What it requires</div>
        <div>What it stops</div>
        <div>Revert</div>
      </div>

      {INVARIANTS.map((v, i) => (
        <Reveal key={v.name} delay={46 + i * 26}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "260px 1fr 1fr 300px",
              gap: 18,
              alignItems: "center",
              padding: "20px 24px",
              borderBottom: `1px solid ${c.line}`,
              background: i % 2 ? "transparent" : c.panel,
            }}
          >
            <div style={{ fontSize: 25, fontWeight: 600 }}>{v.name}</div>
            <div style={{ fontSize: 20, color: c.text, lineHeight: 1.4 }}>{v.check}</div>
            <div style={{ fontSize: 20, color: c.muted, lineHeight: 1.4 }}>{v.stops}</div>
            <div style={{ fontFamily: code, fontSize: 18, color: c.accent }}>{v.err}</div>
          </div>
        </Reveal>
      ))}
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={230}>
      <div style={{ fontSize: 26, color: c.muted, lineHeight: 1.5 }}>
        Withdrawals are checked separately: the vault refuses to promise liquidity it would have to
        pull out of an async venue to honour —{" "}
        <span style={{ fontFamily: code, color: c.accent, fontSize: 22 }}>InsufficientLiquidity</span>
        .
      </div>
    </Reveal>
  </Stage>
);
