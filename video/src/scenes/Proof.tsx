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
  { move: "Sign a plan for a signal Flare never certified", err: "InvalidProof" },
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
        sub="Every plan below carries a real signature from the one enclave this vault was told to trust. The attacker is inside the part that was supposed to be safe. Here is what it can accomplish."
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
                padding: "13px 26px",
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
        <div style={{ display: "flex", gap: 20, marginTop: 20 }}>
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
            TEST: test_whatTheEnclaveCanStillDo
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

/** The five properties asserted by `MaliciousEnclaveInvariant.t.sol`. Names are
 *  verbatim from the suite so a viewer can grep for them; the plain reading sits
 *  beside each one because the identifier alone is not an explanation. */
const INVARIANTS = [
  { n: "invariant_enclaveCannotDestroyValue", plain: "the share price never falls" },
  { n: "invariant_sharesRemainBacked", plain: "every share stays fully backed" },
  { n: "invariant_neverOverAllocated", plain: "the vault never allocates more than it holds" },
  { n: "invariant_nonceMonotonic", plain: "no plan can be replayed" },
  { n: "invariant_capsConstrainTheEnclave", plain: "no venue goes over its cap, checked as each plan lands" },
];

export const SceneFuzz: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Testing against attacks nobody wrote"
      title="The tests do not know what the attack is"
      sub="The fuzzer signs thousands of random rebalance plans as the enclave — random weights, random prices, random timing, with real deposits and withdrawals interleaved — and re-checks the same five properties after every one."
    />

    <div style={{ display: "flex", gap: 22, marginTop: 6 }}>
      {[
        { v: 2700, s: "", label: "hostile plans signed per property", delay: 44 },
        { v: 16000, s: "+", label: "plans across a full run", delay: 56 },
        { v: 5, s: "", label: "properties re-checked after each one", delay: 68 },
        { v: 0, s: "", label: "times any of them broke", delay: 80, good: true },
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
      <div style={{ fontFamily: code, fontSize: 20, color: c.muted, lineHeight: 2.0 }}>
        {INVARIANTS.map((iv) => (
          <div key={iv.n} style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ color: c.good, fontSize: 20 }}>✓</span>
            <span style={{ width: 560, flexShrink: 0 }}>{iv.n}</span>
            <span style={{ color: c.text }}>{iv.plain}</span>
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

/** Every claim here is checked against the adapter, not the write-up:
 *  probeSynchronous() and the AsyncWithdrawalUnsupported tripwire are in
 *  ERC4626Venue.sol, liquidOnDemand and InsufficientLiquidity in TacitVault.sol,
 *  and liquidityBps() is the number the enclave actually clips against. */
const DEFENCES = [
  {
    t: "Test the venue before trusting it",
    b: "probeSynchronous() withdraws 1% and watches for the tell: shares gone, no tokens back.",
  },
  {
    t: "Shares leaving without tokens arriving is an error",
    b: "The adapter reverts, which undoes the burn. A failed rebalance beats a fake one.",
  },
  {
    t: "Only count money the vault can actually get",
    b: "A queued venue counts as zero. Ask for more than that and the withdrawal reverts.",
  },
  {
    t: "Tell the strategy what each venue will release",
    b: "Every venue reports how much of its position is available now. The enclave plans under it.",
  },
];

export const SceneFirelight: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What integration actually taught us"
      title="Firelight takes the withdrawal and pays later"
      sub="Reading the deployed contract instead of the write-up caught a difference that a trusting vault would have turned into a bank run."
    />

    <div style={{ display: "flex", gap: 22, marginBottom: 32 }}>
      <Reveal delay={40} style={{ flex: 1 }}>
        <Panel accent={c.s1} style={{ padding: "26px 30px", height: "100%" }}>
          <div style={{ fontFamily: code, fontSize: 17, letterSpacing: "0.14em", color: c.s1 }}>
            INSTANT EXIT · VENUE A, VENUE B
          </div>
          <div style={{ fontSize: 29, fontWeight: 600, margin: "14px 0 12px" }}>
            Ask for the money, get the money
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            Tokens arrive in the same transaction. What every integration quietly assumes.
          </div>
        </Panel>
      </Reveal>
      <Reveal delay={62} style={{ flex: 1 }}>
        <Panel accent={c.warn} style={{ padding: "26px 30px", height: "100%" }}>
          <div style={{ fontFamily: code, fontSize: 17, letterSpacing: "0.14em", color: c.warn }}>
            QUEUED EXIT · FIRELIGHT
          </div>
          <div style={{ fontSize: 29, fontWeight: 600, margin: "14px 0 12px" }}>
            The shares vanish and nothing arrives
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            It takes the withdrawal, opens a claim, and settles later — through the same call that
            every other vault uses to pay immediately. A vault that counts that as cash is
            promising money it does not have.
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
        The vault still does not support queued venues — it{" "}
        <span style={{ color: c.text }}>notices them and refuses</span>, rather than booking money
        it cannot get. Saying so out loud is the difference between a known limit and a hidden one.
      </div>
    </Reveal>
  </Stage>
);
