import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { c, code, sans } from "../theme";
import { Heading, Panel, Pill, Reveal, Stage } from "../components/ui";

/* ── 12. Why Flare specifically ────────────────────────────────────────── */

const PRIMITIVES = [
  {
    name: "FDC Web2Json",
    color: c.s1,
    gives:
      "Turns a public market-data endpoint into an on-chain fact. ~100 providers fetch the same URL, cut it down to the same few numbers, and vote on the answer.",
    without:
      "The enclave's inputs would be whatever the relayer said they were. The vault could not tell a real signal from an invented one.",
  },
  {
    name: "FTSO",
    color: c.s3,
    gives:
      "A decentralised XRP/USD reference from ~100 providers, read on-chain during the rebalance itself.",
    without:
      "The price the plan trades against would be a number nobody could check. The price band is what makes the enclave's output verifiable rather than trusted.",
  },
  {
    name: "FAssets · FXRP",
    color: c.s2,
    gives:
      "Real XRP, bridged and productive on an EVM chain. The vault resolves the token from AssetManagerFXRP.fAsset() rather than hardcoding it.",
    without:
      "There is no XRP-denominated yield to allocate. FXRP is also 6 decimals, not 18 — every amount in the system is scaled accordingly.",
  },
  {
    name: "Confidential Compute",
    color: c.accent,
    gives:
      "A sealed machine that creates its own signing key inside the seal. The strategy runs where nobody — including whoever deployed it — can read it.",
    without:
      "The strategy is public, and a public strategy is front-runnable. This is the primitive the entire premise rests on.",
  },
];

export const ScenePrimitives: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Why this is built on Flare"
      title="Four primitives, and the design needs all four"
      sub="Each one is load-bearing. Remove any of them and the system either stops working or stops being trustworthy."
    />

    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "330px 1fr 1fr",
          gap: 24,
          fontFamily: code,
          fontSize: 17,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: c.dim,
          padding: "0 26px 12px",
          borderBottom: `1px solid ${c.line}`,
        }}
      >
        <div>Primitive</div>
        <div>What it gives Tacit</div>
        <div>What breaks without it</div>
      </div>

      {PRIMITIVES.map((p, i) => (
        <Reveal key={p.name} delay={44 + i * 34}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "330px 1fr 1fr",
              gap: 24,
              padding: "20px 26px",
              borderBottom: `1px solid ${c.line}`,
              background: i % 2 ? "transparent" : c.panel,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: p.color,
                  flexShrink: 0,
                  marginTop: 10,
                }}
              />
              <span style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.15 }}>{p.name}</span>
            </div>
            <div style={{ fontSize: 21, color: c.text, lineHeight: 1.5 }}>{p.gives}</div>
            <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>{p.without}</div>
          </div>
        </Reveal>
      ))}
    </div>

    <div style={{ flex: 1 }} />

    {/* "On one chain" is the claim, and it is also the constraint the cross-chain
     *  scenes exist to answer — all four primitives are Flare's, so the vault cannot
     *  move to the depositor. The last sentence hands off to that answer rather than
     *  leaving the viewer to assume Coston2-only means Coston2-users-only. */}
    <Reveal delay={220}>
      <div style={{ fontSize: 26, color: c.muted, lineHeight: 1.5 }}>
        Four primitives, <span style={{ color: c.text }}>one chain, one transaction path</span> —
        that is what makes Tacit a Flare project and not a generic EVM one, and it is also the
        reason the vault cannot move to the depositor.{" "}
        <span style={{ color: c.text }}>So the deposit comes to it.</span>
      </div>
    </Reveal>
  </Stage>
);

/* ── 15. Real vs simulated ────────────────────────────────────────────── */

/** Three states, not two. `real` means it runs against live infrastructure;
 *  `simulated` means a stand-in sits in the path; `pending` means the code exists
 *  and compiles but nothing is deployed and nothing is tested. That last one is
 *  not a simulation — there is no stand-in, there is simply nothing a user can
 *  reach yet — and folding it into "simulated" would overstate it in the one place
 *  in the deck that exists to not overstate things.
 *
 *  The title below counts the non-green rows, so adding a row means re-reading the
 *  title. The hardware-attestation row stays LAST: the closing panel answers it
 *  directly, and a row between them breaks that pairing. */
const HONESTY: { part: string; state: "real" | "simulated" | "pending"; note: string }[] = [
  { part: "Vault contracts and share accounting", state: "real", note: "Deployed and verified on Coston2" },
  { part: "All five guardrails", state: "real", note: "Enforced in the rebalance path, 61 tests" },
  { part: "FXRP", state: "real", note: "The real FAssets token — 6 decimals, not a mock" },
  { part: "FTSO XRP/USD price feed", state: "real", note: "Read live from ~100 providers" },
  { part: "FDC Web2Json attestation", state: "real", note: "Real attestation round, proof checked on-chain" },
  { part: "Firelight stXRP venue", state: "real", note: "Live third-party vault, ~100k FXRP TVL" },
  { part: "Enclave code path, identity, signing", state: "real", note: "The same binary that runs under FCC" },
  {
    part: "Cross-chain deposits · LayerZero OVault",
    state: "pending",
    note: "Written and compiling — no deployment, no tests yet",
  },
  {
    part: "Hardware attestation quote verification",
    state: "simulated",
    note: "SIMULATED_TEE=true — Coston2 has no Confidential Space hardware",
  },
];

const STATE = {
  real: { label: "● REAL", color: c.good },
  simulated: { label: "◐ SIMULATED", color: c.warn },
  pending: { label: "◇ NOT DEPLOYED", color: c.dim },
} as const;

export const SceneRealOrSim: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What is real and what is not"
      title="One thing is simulated, one is not deployed, both named"
      sub="A demo that blurs this line is not a demo, it is a pitch. So here is the whole list."
    />

    <div>
      {HONESTY.map((h, i) => {
        const s = STATE[h.state];
        return (
          <Reveal key={h.part} delay={38 + i * 17}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 190px 1fr",
                gap: 24,
                alignItems: "center",
                padding: "15px 26px",
                borderBottom: `1px solid ${c.line}`,
                background:
                  h.state === "real" ? (i % 2 ? "transparent" : c.panel) : `${s.color}12`,
              }}
            >
              <div style={{ fontSize: 24, color: c.text }}>{h.part}</div>
              <div>
                <Pill color={s.color}>{s.label}</Pill>
              </div>
              <div style={{ fontFamily: code, fontSize: 19, color: c.muted }}>{h.note}</div>
            </div>
          </Reveal>
        );
      })}
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={190}>
      <Panel accent={c.good} style={{ padding: "26px 30px" }}>
        <div style={{ fontSize: 25, color: c.muted, lineHeight: 1.55 }}>
          Enabling real attestation is{" "}
          <span style={{ fontFamily: code, color: c.text, fontSize: 22 }}>MODE=0</span> on a
          Confidential Space VM plus an allowlisted image hash — a deployment change, not a redesign.
          And because the vault{" "}
          <span style={{ color: c.text }}>never treats enclave output as authoritative</span>, real
          attestation would upgrade the system from <em>bounded</em> to{" "}
          <em>bounded and attested</em>. It would not close a hole.
        </div>
      </Panel>
    </Reveal>
  </Stage>
);

/* ── 16. Live on Coston2 ──────────────────────────────────────────────── */

/** Verbatim from `ui/deployments.json`, which is what the live interface reads.
 *  The scene claims every address is live, so these must be regenerated from that
 *  file — never retyped — whenever the contracts are redeployed. */
const ADDRS = [
  { label: "TacitVault", addr: "0x9446372Ccf68D798c2c82aa09d5C39CC9427F1Ed", color: c.accent },
  { label: "Venue A · 8% APR", addr: "0xeAa13D09e5d501B108c68c2c158eA23e8f64f0e2", color: c.s1 },
  { label: "Venue B · 15% APR", addr: "0x087D3C7d91af876078863b46ed835B5D0142D66a", color: c.s2 },
  { label: "Firelight adapter", addr: "0x0F7fF8Db9EC2bdA72A1B4DA34e0B484AF3D1c351", color: c.s3 },
  { label: "Enclave identity", addr: "0x89E6C7AD562cf6e664aDBE425E9e323F9A8a3bC5", color: c.good },
];

/** Wording matches the venue pills in scene 5 and the Firelight slide in scene 11.
 *  "Instant exit" / "queued exit" replaced sync/async everywhere the viewer can
 *  see, so these two rows must not reintroduce the old vocabulary. */
const GUARDS = [
  { k: "Instant-exit venue cap", v: "60%" },
  { k: "Firelight (queued) cap", v: "30%" },
  { k: "Max turnover per rebalance", v: "30%" },
  { k: "Minimum rebalance interval", v: "300s" },
  { k: "FTSO price band", v: "±5%" },
  { k: "Maximum signal age", v: "1h" },
];

export const SceneLive: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Deployed · Flare Coston2 · chain 114"
      title="None of this is a diagram"
      sub="Every address below is live. Every number on the right is a value the deployed vault currently enforces."
    />

    <div style={{ display: "flex", gap: 30, flex: 1 }}>
      <div style={{ flex: 1.35 }}>
        {ADDRS.map((a, i) => (
          <Reveal key={a.label} delay={40 + i * 22}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: "19px 24px",
                borderBottom: `1px solid ${c.line}`,
              }}
            >
              <div
                style={{ width: 11, height: 11, borderRadius: 3, background: a.color, flexShrink: 0 }}
              />
              <div style={{ fontSize: 24, width: 300, flexShrink: 0 }}>{a.label}</div>
              <div style={{ fontFamily: code, fontSize: 20, color: c.muted }}>{a.addr}</div>
            </div>
          </Reveal>
        ))}

        <Reveal delay={158}>
          <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <Pill color={c.good}>forge test → 61 PASSED</Pill>
            <Pill color={c.good}>go test ./... → 10 PASSED</Pill>
            <Pill color={c.dim}>INCLUDES FORK TESTS VS LIVE FIRELIGHT</Pill>
          </div>
        </Reveal>
      </div>

      <Reveal delay={100} style={{ flex: 1 }}>
        <Panel style={{ padding: "26px 30px" }}>
          <div
            style={{
              fontFamily: code,
              fontSize: 17,
              letterSpacing: "0.14em",
              color: c.accent,
              marginBottom: 22,
            }}
          >
            GUARDRAILS AS DEPLOYED
          </div>
          {GUARDS.map((g, i) => (
            <Reveal key={g.k} delay={112 + i * 13}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  padding: "11px 0",
                  borderBottom: `1px solid ${c.line}`,
                }}
              >
                <div style={{ fontSize: 22, color: c.muted }}>{g.k}</div>
                <div style={{ flex: 1, borderBottom: `1px dotted ${c.line}` }} />
                <div
                  style={{
                    fontFamily: code,
                    fontSize: 24,
                    color: c.text,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {g.v}
                </div>
              </div>
            </Reveal>
          ))}
        </Panel>
      </Reveal>
    </div>
  </Stage>
);

/* ── 17. Closing ──────────────────────────────────────────────────────── */

export const SceneClosing: React.FC = () => {
  const frame = useCurrentFrame();
  const rule = interpolate(frame, [80, 130], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Reveal delay={0}>
          <div style={{ fontFamily: code, fontSize: 20, letterSpacing: "0.18em", color: c.accent }}>
            THE POINT
          </div>
        </Reveal>

        <Reveal delay={12}>
          <div
            style={{
              fontSize: 52,
              fontWeight: 500,
              lineHeight: 1.3,
              maxWidth: 1600,
              marginTop: 24,
              letterSpacing: "-0.015em",
            }}
          >
            An autonomous agent does not have to be trusted to be useful.
          </div>
        </Reveal>

        <Reveal delay={34}>
          <div style={{ fontSize: 30, color: c.muted, marginTop: 28, maxWidth: 1560, lineHeight: 1.55 }}>
            Tacit gives the agent a private strategy, verified inputs, and real capital — and then
            takes away every path from a bad decision to a lost deposit. The interesting question was
            never <em>can an agent trade</em>. It was{" "}
            <span style={{ color: c.text }}>what happens when it turns on you</span>.
          </div>
        </Reveal>

        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, ${c.accent}, ${c.accent}00)`,
            width: `${rule * 55}%`,
            margin: "44px 0 40px",
          }}
        />

        <Reveal delay={92}>
          <div
            style={{
              fontSize: 44,
              fontWeight: 600,
              fontFamily: sans,
              letterSpacing: "-0.02em",
            }}
          >
            The enclave controls strategy quality,{" "}
            <span style={{ color: c.accent }}>never fund safety.</span>
          </div>
        </Reveal>

        {/* The same boundary as one sentence per party, revealed left to right —
         *  which is also the order the pipeline actually runs in. */}
        <div style={{ display: "flex", alignItems: "stretch", marginTop: 32 }}>
          {[
            "The owner sets the rules.",
            "The AI makes the decision.",
            'Anyone can press "execute."',
            "The smart contract is the referee.",
          ].map((line, i) => (
            <Reveal
              key={line}
              delay={104 + i * 10}
              style={{
                flex: 1,
                paddingLeft: i === 0 ? 0 : 26,
                borderLeft: i === 0 ? undefined : `1px solid ${c.line}`,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 500, lineHeight: 1.4, paddingRight: 22 }}>
                {line}
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={152}>
          <div
            style={{
              fontSize: 36,
              fontWeight: 600,
              marginTop: 34,
              letterSpacing: "-0.015em",
              color: c.accent,
            }}
          >
            Thanks for watching.
          </div>
        </Reveal>
      </div>

      <Reveal delay={166}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            borderTop: `1px solid ${c.line}`,
            paddingTop: 30,
          }}
        >
          <div style={{ fontSize: 42, color: c.accent, lineHeight: 1 }}>◆</div>
          <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.03em" }}>Tacit</div>
          <div style={{ flex: 1 }} />
          <Pill color={c.good}>● LIVE ON COSTON2</Pill>
          <Pill color={c.dim}>FLARE SUMMER SIGNAL 2026</Pill>
        </div>
      </Reveal>

      {/* Hand-off to the screen recording spliced on after this card. It is both the
       *  last thing revealed (delay 200, after the footer at 166) and the bottom-most
       *  element, so the viewer's eye ends where the cut happens. Fully opaque at
       *  frame 218 and the scene runs to 375, so it holds ~5s before the fade.
       *
       *  Wording describes what the interface IS, not the order of actions performed
       *  in it — the recording is made separately and must not be able to contradict
       *  this card. */}
      <Reveal delay={200}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            background: c.panel,
            border: `1px solid ${c.line}`,
            borderLeft: `3px solid ${c.accent}`,
            borderRadius: 10,
            padding: "22px 28px",
            marginTop: 30,
          }}
        >
          <div
            style={{
              fontFamily: code,
              fontSize: 18,
              letterSpacing: "0.18em",
              color: c.accent,
              flexShrink: 0,
            }}
          >
            UP NEXT
          </div>
          <div style={{ width: 1, height: 30, background: c.line, flexShrink: 0 }} />
          <div style={{ fontSize: 26, color: c.text, lineHeight: 1.4 }}>
            A screen recording of the live interface follows —{" "}
            <span style={{ color: c.muted }}>
              deposits, withdrawals, the current allocation, the guardrails above, the autopilot's
              status and the last signal Flare attested — every number read straight from the vault
              on Coston2.
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 34, color: c.accent, lineHeight: 1, flexShrink: 0 }}>▶</div>
        </div>
      </Reveal>
    </Stage>
  );
};
