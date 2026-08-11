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
            Roughly a hundred independent Flare providers fetch the same public market-data URL,
            reduce it to the same few numbers, and vote. What they agree on is published on-chain,
            so the vault can check those numbers itself instead of trusting whoever delivered them.
          </>
        }
      />
      <Wire label="attested numbers + proof" delay={70} />
      <Band
        delay={82}
        zone="CONFIDENTIAL"
        zoneColor={c.s3}
        title="The enclave"
        body={
          <>
            Runs in Flare Confidential Compute — a sealed machine nobody can read into, not even
            the operator running it. It reads the agreed numbers, decides how much belongs in each
            venue, and signs that plan with a key that only exists inside the seal. The strategy
            never leaves.
          </>
        }
      />
      <Wire label="signed plan" delay={112} />
      <Band
        delay={124}
        zone="UNTRUSTED"
        zoneColor={c.dim}
        title="The relayer and autopilot"
        body={
          <>
            The autopilot watches the chain and decides when a cycle is worth running; the relayer
            requests the attestation, collects the proof, and submits both to the vault. Neither holds
            a key or a privilege — anyone can run them, and a hostile one can only stall, never steal.
          </>
        }
      />
      <Wire label="executeRebalance(plan, signature, proof)" delay={154} />
      <Band
        delay={166}
        zone="ON-CHAIN"
        zoneColor={c.accent}
        title="TacitVault"
        body={
          <>
            Checks the proof against Flare's own attestation contract, checks the signature against
            the one enclave it has been told to accept, reads the live FTSO price, then enforces
            five guardrails before a single token moves.
          </>
        }
      />
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={210}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 22, color: c.dim, marginRight: 8 }}>Capital lands here:</span>
        <Pill color={c.s1}>VENUE A · 8% APR · INSTANT EXIT</Pill>
        <Pill color={c.s2}>VENUE B · 15% APR · INSTANT EXIT</Pill>
        <Pill color={c.s3}>FIRELIGHT stXRP · QUEUED EXIT</Pill>
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
    who: "Autopilot → Relayer",
    color: c.s1,
    body: "The autopilot decides a cycle is due — the vault asked for one, or its heartbeat came round — and the relayer asks Flare's Data Connector to certify a market-data snapshot. ~100 providers fetch the same URL, reduce it the same way, and vote. The chain can now check those numbers itself.",
  },
  {
    n: "2",
    name: "Decide",
    who: "Enclave",
    color: c.s3,
    body: "Inside the sealed enclave, the strategy reads the certified numbers and decides how much belongs in each venue. It signs that plan with its own key. The final split is public the moment it is submitted; the reasoning behind it is not.",
  },
  {
    n: "3",
    name: "Enforce",
    who: "Vault",
    color: c.accent,
    body: "The vault rebuilds the signal from the proof and checks the plan points at that exact one, confirms the signature came from the enclave it trusts, pulls a fresh FTSO price, and runs every guardrail. Any single failure undoes the whole transaction.",
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
        sub="Nobody starts this by hand: the autopilot watches the chain and runs the loop when the vault asks for it. The vault still enforces a 300-second floor between rebalances."
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

/* ── 7. The five guardrails ───────────────────────────────────────────── */

/** Every figure here is the deployed value, not a design intention:
 *  conservationToleranceBps=10, capBps 6_000/6_000/3_000, maxTurnoverBps=3_000,
 *  priceBandBps=500, maxSignalAge=3_600. Re-read TacitVault.sol + Deploy.s.sol
 *  before changing any number on this slide.
 *
 *  Called "guardrails", not "invariants", because that is the word the live UI
 *  uses — and the screen recording is spliced on directly after this video. Two
 *  words for one idea makes the viewer do translation work. The word "invariant"
 *  is reserved for scene 10, where it names actual `invariant_*` test functions. */
const GUARDRAILS = [
  {
    name: "Conservation",
    check: "Total assets may not fall by more than 0.1% across a rebalance",
    stops: "A plan that quietly loses value — including one routed through a bad swap",
    err: "ConservationViolated",
  },
  {
    name: "Venue caps",
    check: "No venue may hold more than its cap — 60% each for the instant-exit venues, 30% for Firelight",
    stops: "Putting the whole treasury into one protocol",
    err: "VenueCapExceeded",
  },
  {
    name: "Turnover budget",
    check: "At most 30% of the vault may move in any single rebalance",
    stops: "Draining the vault in a thousand small, legal-looking steps",
    err: "TurnoverExceeded",
  },
  {
    name: "Price band",
    check: "The price used must sit within ±5% of Flare's live XRP/USD feed",
    stops: "Trading against a pool the enclave has just pushed off-market",
    err: "PriceOutOfBand",
  },
  {
    name: "Signal freshness",
    check: "The plan must name a signal Flare certified within the last hour, and match it exactly",
    stops: "Replaying an old, more favourable signal — or inventing one",
    err: "SignalStale / SignalMismatch",
  },
];

export const SceneInvariants: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What the chain enforces"
      title="Five guardrails stand between the agent and your deposit"
      sub="These are not alerts or monitored thresholds. Each one is a check inside the rebalance itself — fail a single one and the whole transaction is undone, with the chain recording which check said no."
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
        <div>Guardrail</div>
        <div>What it requires</div>
        <div>What it stops</div>
        <div>Reverts with</div>
      </div>

      {GUARDRAILS.map((v, i) => (
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
        Withdrawals are guarded separately: the vault will not promise money it would have to pull
        out of a queued-exit venue to deliver —{" "}
        <span style={{ fontFamily: code, color: c.accent, fontSize: 22 }}>InsufficientLiquidity</span>
        .
      </div>
    </Reveal>
  </Stage>
);
