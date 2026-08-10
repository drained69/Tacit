import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { c, code } from "../theme";
import { Heading, Panel, Reveal, Stage } from "../components/ui";

/* ── 8. Assume the enclave is hostile ─────────────────────────────────── */

const ATTACKS = [
  { move: "Put the entire treasury into one venue", err: "VenueCapExceeded" },
  { move: "Write targets that allocate 150% of the vault", err: "TargetsOverAllocate" },
  { move: "Move everything at once, then again, then again", err: "TurnoverExceeded" },
  { move: "Execute against a pool it has just manipulated", err: "PriceOutOfBand" },
  { move: "Reuse yesterday's more favourable signal", err: "SignalStale" },
  { move: "Sign a plan for a signal the FDC never attested", err: "InvalidProof" },
  { move: "Point the plan at a different signal than the proof carries", err: "SignalMismatch" },
  { move: "Grind the vault with back-to-back rebalances", err: "RebalanceTooSoon" },
];

export const SceneAttack: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage>
      <Heading
        eyebrow="Adversarial testing"
        title="Now assume the enclave is completely compromised"
        sub="Every plan below carries a genuine signature from the registered TEE identity. The attacker is inside the trusted component. Here is what it can accomplish."
      />

      <div style={{ flex: 1 }}>
        {ATTACKS.map((a, i) => {
          const delay = 40 + i * 28;
          const t = interpolate(frame - delay, [0, 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const flash = interpolate(frame - delay, [10, 18, 34], [0, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={a.err}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                padding: "17px 26px",
                borderBottom: `1px solid ${c.line}`,
                background: `rgba(230,32,88,${flash * 0.1})`,
                opacity: t,
                transform: `translateX(${(1 - t) * -12}px)`,
              }}
            >
              <div
                style={{
                  fontFamily: code,
                  fontSize: 17,
                  color: c.dim,
                  width: 34,
                  flexShrink: 0,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </div>
              <div style={{ fontSize: 25, flex: 1 }}>{a.move}</div>
              <div
                style={{
                  fontSize: 25,
                  color: c.accent,
                  fontWeight: 700,
                  width: 34,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                ✕
              </div>
              <div
                style={{
                  fontFamily: code,
                  fontSize: 20,
                  color: c.accent,
                  width: 400,
                  flexShrink: 0,
                  textAlign: "right",
                }}
              >
                revert {a.err}
              </div>
            </div>
          );
        })}
      </div>

      <Reveal delay={300}>
        <div style={{ display: "flex", gap: 20, marginTop: 24 }}>
          <Panel accent={c.good} style={{ flex: 1, padding: "24px 28px" }}>
            <div style={{ fontSize: 28, fontWeight: 600, marginBottom: 10 }}>
              Eight attempts, eight reverts
            </div>
            <div style={{ fontSize: 22, color: c.muted, lineHeight: 1.5 }}>
              A stolen enclave key does not become a withdrawal. The signature only buys the right
              to <span style={{ color: c.text }}>propose</span>.
            </div>
          </Panel>
          <Panel style={{ flex: 1, padding: "24px 28px" }}>
            <div style={{ fontSize: 28, fontWeight: 600, marginBottom: 10 }}>
              Without the enclave key
            </div>
            <div style={{ fontSize: 22, color: c.muted, lineHeight: 1.5 }}>
              An outsider gets no further than{" "}
              <span style={{ fontFamily: code, color: c.accent, fontSize: 19 }}>BadSigner</span>. A
              replayed plan hits{" "}
              <span style={{ fontFamily: code, color: c.accent, fontSize: 19 }}>BadNonce</span> or{" "}
              <span style={{ fontFamily: code, color: c.accent, fontSize: 19 }}>PlanExpired</span>.
            </div>
          </Panel>
        </div>
      </Reveal>
    </Stage>
  );
};

/* ── 9. What it CAN still do ──────────────────────────────────────────── */

/** Grouped horizontal bars: the best allocation vs the worst one a hostile
 *  enclave could still sign, with each venue's on-chain cap drawn as a marker
 *  so the constraint is visible rather than asserted. Two series → legend
 *  present, direct value labels, values in text ink not series colour. */
const ALLOC = [
  { venue: "Venue B · 15% APR", best: 60, worst: 0, cap: 60 },
  { venue: "Venue A · 8% APR", best: 30, worst: 5, cap: 60 },
  { venue: "Firelight stXRP", best: 10, worst: 0, cap: 30 },
  { venue: "Idle · 0% APR", best: 0, worst: 95, cap: null },
];

const BAR_H = 21;
const TRACK = 620;
const SCALE = 100;

const AllocBar: React.FC<{ pct: number; color: string; delay: number }> = ({
  pct,
  color,
  delay,
}) => {
  const frame = useCurrentFrame();
  const g = interpolate(frame - delay, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const e = 1 - Math.pow(1 - g, 3);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: TRACK, height: BAR_H, background: c.panel2, borderRadius: 4 }}>
        <div
          style={{
            width: `${(pct / SCALE) * TRACK * e}px`,
            height: BAR_H,
            background: color,
            borderRadius: "0 4px 4px 0",
          }}
        />
      </div>
      <div style={{ fontFamily: code, fontSize: 20, color: c.text, opacity: e, width: 56 }}>
        {pct}%
      </div>
    </div>
  );
};

export const SceneResidual: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="The honest limitation"
      title="What a compromised enclave can still do"
      sub="It cannot take the money. It can absolutely waste the opportunity — and the vault has no way to tell a bad strategy from a cautious one."
    />

    <div style={{ display: "flex", gap: 48, flex: 1 }}>
      <div>
        <div style={{ display: "flex", gap: 26, marginBottom: 20, paddingLeft: 262 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 13, height: 13, borderRadius: 3, background: c.s3 }} />
            <span style={{ fontSize: 19, color: c.muted }}>A good plan</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 13, height: 13, borderRadius: 3, background: c.s2 }} />
            <span style={{ fontSize: 19, color: c.muted }}>Worst still-legal plan</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 2, height: 15, background: c.text }} />
            <span style={{ fontSize: 19, color: c.muted }}>on-chain cap</span>
          </div>
        </div>

        {ALLOC.map((a, i) => (
          <Reveal key={a.venue} delay={44 + i * 20}>
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 18 }}>
              <div style={{ width: 242, fontSize: 22, color: c.text, textAlign: "right" }}>
                {a.venue}
              </div>
              <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 2 }}>
                <AllocBar pct={a.best} color={c.s3} delay={50 + i * 20} />
                <AllocBar pct={a.worst} color={c.s2} delay={56 + i * 20} />
                {a.cap !== null ? (
                  <div
                    style={{
                      position: "absolute",
                      left: (a.cap / SCALE) * TRACK - 1,
                      top: -4,
                      width: 2,
                      height: BAR_H * 2 + 10,
                      background: c.text,
                    }}
                  />
                ) : null}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={130} style={{ flex: 1 }}>
        <Panel accent={c.warn} style={{ padding: "28px 30px" }}>
          <div style={{ fontFamily: code, fontSize: 17, color: c.warn, letterSpacing: "0.14em" }}>
            TEST: whatTheEnclaveCanStillDo
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, margin: "16px 0 18px", lineHeight: 1.25 }}>
            Leave 95% of the treasury sitting idle, forever.
          </div>
          <div style={{ fontSize: 22, color: c.muted, lineHeight: 1.6 }}>
            Every orange bar is inside the caps. The turnover budget is respected. The price band is
            respected. Nothing reverts — the capital simply earns nothing.
            <br />
            <br />
            This is the residual risk, and it is stated rather than hidden. Depositors can withdraw
            at any time, so the exposure is bounded by how long a bad strategy goes unnoticed —{" "}
            <span style={{ color: c.text }}>not by how much it can steal.</span>
          </div>
        </Panel>
      </Reveal>
    </div>
  </Stage>
);

/* ── 10. Invariant fuzzing ────────────────────────────────────────────── */

const Counter: React.FC<{ to: number; delay: number; suffix?: string }> = ({
  to,
  delay,
  suffix = "",
}) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame - delay, [0, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const e = 1 - Math.pow(1 - t, 3);
  return (
    <span style={{ fontFamily: code, fontVariantNumeric: "tabular-nums" }}>
      {Math.round(to * e).toLocaleString("en-US")}
      {suffix}
    </span>
  );
};

export const SceneFuzz: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Stateful invariant fuzzing"
      title="The tests do not know what the attack is"
      sub="Foundry generates hostile rebalance plans against a live vault — random weights, random amounts, random ordering, random depositors — and asserts the properties still hold after every single one."
    />

    <div style={{ display: "flex", gap: 22, marginTop: 6 }}>
      {[
        { v: 2700, s: "", label: "hostile plans per invariant", delay: 44 },
        { v: 16000, s: "+", label: "plans per campaign run", delay: 56 },
        { v: 5, s: "", label: "properties asserted after each one", delay: 68 },
        { v: 0, s: "", label: "violations found", delay: 80, good: true },
      ].map((m) => (
        <Reveal key={m.label} delay={m.delay} style={{ flex: 1 }}>
          <Panel style={{ padding: "30px 28px", height: "100%" }}>
            <div
              style={{
                fontSize: 64,
                fontWeight: 700,
                color: m.good ? c.good : c.text,
                letterSpacing: "-0.03em",
              }}
            >
              <Counter to={m.v} delay={m.delay + 6} suffix={m.s} />
            </div>
            <div style={{ fontSize: 21, color: c.muted, marginTop: 12, lineHeight: 1.4 }}>
              {m.label}
            </div>
          </Panel>
        </Reveal>
      ))}
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={130}>
      <div style={{ fontFamily: code, fontSize: 21, color: c.muted, lineHeight: 2.1 }}>
        {[
          "invariant_totalAssetsNeverDropsBeyondTolerance",
          "invariant_venueSharesNeverExceedCaps",
          "invariant_sumOfVenueBalancesEqualsTotalAssets",
          "invariant_shareValueNeverDecreasesFromRebalance",
          "invariant_liquidWithdrawalsAlwaysHonoured",
        ].map((n) => (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ color: c.good, fontSize: 20 }}>✓</span>
            <span>{n}</span>
            <div style={{ flex: 1, borderBottom: `1px dotted ${c.line}`, margin: "0 6px" }} />
            <span style={{ color: c.good }}>PASS</span>
          </div>
        ))}
      </div>
    </Reveal>

    <Reveal delay={210}>
      <div style={{ fontSize: 25, color: c.muted, marginTop: 26 }}>
        Hand-written attacks only find the attacks you imagined. The fuzzer searches the space you
        did not.
      </div>
    </Reveal>
  </Stage>
);

/* ── 11. The Firelight discovery ──────────────────────────────────────── */

const DEFENCES = [
  {
    t: "Venues declare their semantics",
    b: "Each adapter reports liquidOnDemand — whether a withdrawal settles now or enters a queue.",
  },
  {
    t: "Liquidity is computed, not assumed",
    b: "maxWithdraw() counts only assets in synchronous venues plus the idle balance.",
  },
  {
    t: "The vault refuses to over-promise",
    b: "A withdrawal beyond that number reverts with InsufficientLiquidity instead of half-executing.",
  },
  {
    t: "The strategy is told the constraint",
    b: "The enclave receives the async cap as an input, so it plans around it rather than into it.",
  },
];

export const SceneFirelight: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What integration actually taught us"
      title="Firelight does not give the money back on request"
      sub="Reading the deployed contracts rather than the marketing page surfaced a semantic difference that a naive vault would have turned into a bank run."
    />

    <div style={{ display: "flex", gap: 22, marginBottom: 32 }}>
      <Reveal delay={40} style={{ flex: 1 }}>
        <Panel accent={c.s1} style={{ padding: "26px 30px", height: "100%" }}>
          <div style={{ fontFamily: code, fontSize: 17, letterSpacing: "0.14em", color: c.s1 }}>
            SYNCHRONOUS · VENUE A, VENUE B
          </div>
          <div style={{ fontSize: 29, fontWeight: 600, margin: "14px 0 12px" }}>
            withdraw() returns assets in the same transaction
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            What every ERC-4626 integration silently assumes.
          </div>
        </Panel>
      </Reveal>
      <Reveal delay={62} style={{ flex: 1 }}>
        <Panel accent={c.warn} style={{ padding: "26px 30px", height: "100%" }}>
          <div style={{ fontFamily: code, fontSize: 17, letterSpacing: "0.14em", color: c.warn }}>
            ASYNCHRONOUS · FIRELIGHT
          </div>
          <div style={{ fontSize: 29, fontWeight: 600, margin: "14px 0 12px" }}>
            requestWithdraw() opens a queue position
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            Assets arrive later. A vault that treats this as spendable liquidity is insolvent on
            paper the moment enough depositors leave at once.
          </div>
        </Panel>
      </Reveal>
    </div>

    <Reveal delay={96}>
      <div style={{ fontSize: 24, color: c.dim, marginBottom: 20, fontFamily: code, letterSpacing: "0.1em" }}>
        FOUR CHANGES THAT CAME OUT OF IT
      </div>
    </Reveal>

    <div style={{ display: "flex", gap: 18, flex: 1 }}>
      {DEFENCES.map((d, i) => (
        <Reveal key={d.t} delay={110 + i * 26} style={{ flex: 1 }}>
          <div
            style={{
              height: "100%",
              borderTop: `2px solid ${c.good}`,
              paddingTop: 20,
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 600, marginBottom: 12, lineHeight: 1.25 }}>
              {d.t}
            </div>
            <div style={{ fontSize: 20, color: c.muted, lineHeight: 1.55 }}>{d.b}</div>
          </div>
        </Reveal>
      ))}
    </div>

    <Reveal delay={250}>
      <div
        style={{
          marginTop: 30,
          borderTop: `1px solid ${c.line}`,
          paddingTop: 24,
          fontSize: 26,
          color: c.muted,
        }}
      >
        The vault is now correct against{" "}
        <span style={{ color: c.text }}>both kinds of venue</span> — which matters well beyond
        Firelight, because every async venue added later inherits the same handling.
      </div>
    </Reveal>
  </Stage>
);
