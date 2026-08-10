import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { c, code, sans } from "../theme";
import { Heading, Panel, Pill, Reveal, Stage, useReveal } from "../components/ui";

/* ── 1. Title ─────────────────────────────────────────────────────────── */

export const SceneTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const mark = useReveal(0, 24);
  const rule = interpolate(frame, [22, 52], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26, ...mark }}>
          <div style={{ fontSize: 78, color: c.accent, lineHeight: 1 }}>◆</div>
          <div style={{ fontSize: 116, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1 }}>
            Tacit
          </div>
        </div>

        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, ${c.accent}, ${c.accent}00)`,
            width: `${rule * 62}%`,
            margin: "34px 0 30px",
          }}
        />

        <Reveal delay={30}>
          <div style={{ fontSize: 46, fontWeight: 500, letterSpacing: "-0.015em" }}>
            A confidential autonomous treasury for FXRP.
          </div>
        </Reveal>

        <Reveal delay={44}>
          <div style={{ fontSize: 30, color: c.muted, marginTop: 22, lineHeight: 1.5, maxWidth: 1420 }}>
            An agent decides where the capital goes.
            <br />
            The chain decides what the agent is{" "}
            <span style={{ color: c.text }}>allowed</span> to do.
          </div>
        </Reveal>
      </div>

      <Reveal delay={68}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <Pill color={c.good}>● LIVE ON COSTON2</Pill>
          <Pill color={c.dim}>ERC-4626</Pill>
          <Pill color={c.dim}>60 SOLIDITY + 8 GO TESTS</Pill>
          <Pill color={c.dim}>FLARE SUMMER SIGNAL</Pill>
        </div>
      </Reveal>
    </Stage>
  );
};

/* ── 2. The problem ───────────────────────────────────────────────────── */

const ProblemCard: React.FC<{
  n: string;
  title: string;
  body: React.ReactNode;
  delay: number;
}> = ({ n, title, body, delay }) => (
  <Reveal delay={delay} style={{ flex: 1 }}>
    <Panel accent={c.accent} style={{ height: "100%", padding: "28px 30px" }}>
      <div style={{ fontFamily: code, fontSize: 19, color: c.accent, marginBottom: 14 }}>{n}</div>
      <div style={{ fontSize: 31, fontWeight: 600, marginBottom: 16, lineHeight: 1.2 }}>{title}</div>
      <div style={{ fontSize: 23, color: c.muted, lineHeight: 1.55 }}>{body}</div>
    </Panel>
  </Reveal>
);

export const SceneProblem: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="The problem"
      title="The yield is real. Capturing it is not."
      sub="FXRP is seven months old, ~155M minted, and yields across Kinetic, SparkDEX, Enosys and Firelight have run as high as 50% APR."
    />

    <div style={{ display: "flex", gap: 22, flex: 1, marginTop: 14 }}>
      <ProblemCard
        n="01"
        delay={40}
        title="Fragmentation"
        body={
          <>
            Four-plus protocols, rates moving independently. Capturing them means watching all of
            them continuously and moving between them — which costs more in gas and attention than
            most positions earn.
          </>
        }
      />
      <ProblemCard
        n="02"
        delay={62}
        title="A public strategy stops working"
        body={
          <>
            A rule expressed as on-chain transactions is not merely copyable — it is{" "}
            <span style={{ color: c.text }}>exploitable</span>. Know the rule, front-run the buy.
            Know the thresholds, push a metric past one and force the rebalance.
          </>
        }
      />
      <ProblemCard
        n="03"
        delay={84}
        title="Off-chain signals never land"
        body={
          <>
            Exchange volume, realised volatility, 24h drawdown — all of them say something about
            where FXRP yield is heading. No on-chain FXRP product uses any of them.
          </>
        }
      />
    </div>

    <Reveal delay={140}>
      <div
        style={{
          marginTop: 30,
          fontSize: 27,
          color: c.muted,
          borderTop: `1px solid ${c.line}`,
          paddingTop: 26,
        }}
      >
        Solving all three at once needs{" "}
        <span style={{ color: c.text }}>confidential compute</span>,{" "}
        <span style={{ color: c.text }}>verified off-chain data</span> and{" "}
        <span style={{ color: c.text }}>trustless settlement</span> in one system.
      </div>
    </Reveal>
  </Stage>
);

/* ── 3. Why nobody has done it ────────────────────────────────────────── */

export const SceneHumanManaged: React.FC = () => {
  const frame = useCurrentFrame();
  const strike = interpolate(frame, [86, 112], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Reveal delay={0}>
          <div style={{ fontSize: 44, fontWeight: 500, lineHeight: 1.3, maxWidth: 1620 }}>
            Every FXRP yield vault live today is{" "}
            <span style={{ color: c.accent }}>human-managed with a public mandate</span>.
          </div>
        </Reveal>

        <Reveal delay={22}>
          <div style={{ display: "flex", gap: 14, marginTop: 30 }}>
            {["earnXRP", "MXRPY", "Spectra vault"].map((v) => (
              <div
                key={v}
                style={{
                  fontFamily: code,
                  fontSize: 22,
                  color: c.muted,
                  border: `1px solid ${c.line}`,
                  borderRadius: 7,
                  padding: "10px 18px",
                  background: c.panel,
                }}
              >
                {v}
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={46}>
          <div style={{ fontSize: 29, color: c.muted, marginTop: 44, lineHeight: 1.5, maxWidth: 1560 }}>
            That is not an oversight. It is what you are left with when the strategy cannot be
            private: you can have a <span style={{ color: c.text }}>discretionary manager</span> or a{" "}
            <span style={{ color: c.text }}>predictable rule</span> —
          </div>
        </Reveal>

        <Reveal delay={70}>
          <div style={{ position: "relative", display: "inline-block", marginTop: 26 }}>
            <span style={{ fontSize: 36, fontWeight: 500, color: c.text }}>
              but not a reactive automated one.
            </span>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: "56%",
                height: 3,
                width: `${strike * 100}%`,
                background: c.accent,
              }}
            />
          </div>
        </Reveal>

        <Reveal delay={118}>
          <div style={{ fontSize: 34, color: c.good, marginTop: 34, fontWeight: 500 }}>
            …unless the strategy can be kept private.
          </div>
        </Reveal>
      </div>
    </Stage>
  );
};

/* ── 4. What Tacit is ─────────────────────────────────────────────────── */

const PART_ROWS = [
  {
    part: "The vault",
    does: "Custody, share accounting, and five hard limits on the agent",
    where: "Coston2 · Solidity",
    color: c.s1,
  },
  {
    part: "The enclave",
    does: "Reads the attested signal, decides the allocation, signs it",
    where: "Flare Confidential Compute",
    color: c.s3,
  },
  {
    part: "The relayer",
    does: "Requests attestation, carries the plan on-chain",
    where: "Anywhere · fully untrusted",
    color: c.dim,
  },
];

export const SceneWhatItIs: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What Tacit is"
      title="An ERC-4626 vault over FXRP, in three parts"
      sub="A depositor sees an ordinary vault: deposit, withdraw, a share price that rises with yield."
    />

    <div style={{ marginTop: 18 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "290px 1fr 420px",
          gap: 20,
          fontFamily: code,
          fontSize: 18,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: c.dim,
          padding: "0 30px 14px",
          borderBottom: `1px solid ${c.line}`,
        }}
      >
        <div>Part</div>
        <div>What it does</div>
        <div>Where it runs</div>
      </div>

      {PART_ROWS.map((r, i) => (
        <Reveal key={r.part} delay={44 + i * 22}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "290px 1fr 420px",
              gap: 20,
              alignItems: "center",
              padding: "24px 30px",
              borderBottom: `1px solid ${c.line}`,
              background: i % 2 ? "transparent" : c.panel,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{ width: 12, height: 12, borderRadius: 3, background: r.color, flexShrink: 0 }}
              />
              <span style={{ fontSize: 28, fontWeight: 600 }}>{r.part}</span>
            </div>
            <div style={{ fontSize: 24, color: c.text }}>{r.does}</div>
            <div style={{ fontFamily: code, fontSize: 21, color: c.muted }}>{r.where}</div>
          </div>
        </Reveal>
      ))}
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={140}>
      <div
        style={{
          background: `linear-gradient(90deg, ${c.accent}1c, transparent)`,
          borderLeft: `3px solid ${c.accent}`,
          padding: "30px 34px",
          borderRadius: 8,
        }}
      >
        <div style={{ fontFamily: code, fontSize: 18, color: c.accent, letterSpacing: "0.14em", marginBottom: 12 }}>
          THE WHOLE DESIGN, IN ONE SENTENCE
        </div>
        <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.015em", fontFamily: sans }}>
          The enclave controls strategy quality, never fund safety.
        </div>
      </div>
    </Reveal>
  </Stage>
);
