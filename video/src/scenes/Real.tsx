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
      "Turns a public market-data endpoint into an on-chain fact. ~100 providers fetch the same URL, apply the same JQ transform, and vote on the result.",
    without:
      "The enclave's inputs would be a claim from whoever ran the relayer. The vault could not tell a real signal from a fabricated one.",
  },
  {
    name: "FTSO",
    color: c.s3,
    gives:
      "A decentralised XRP/USD reference from ~100 providers, read on-chain during the rebalance itself.",
    without:
      "refPriceMicroUsd in the plan would be an unfalsifiable number. The price band is what makes the enclave's output auditable rather than trusted.",
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
      "A TEE that derives its own signing identity inside the enclave. The strategy runs where nobody — including whoever deployed it — can read it.",
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
              padding: "24px 26px",
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

    <Reveal delay={220}>
      <div style={{ fontSize: 26, color: c.muted, lineHeight: 1.5 }}>
        Attested off-chain data, a decentralised price feed, a bridged real-world asset, and a TEE —{" "}
        <span style={{ color: c.text }}>on one chain, in one transaction path</span>. That
        combination is the reason Tacit is a Flare project and not a generic EVM one.
      </div>
    </Reveal>
  </Stage>
);

/* ── 13. Real vs simulated ────────────────────────────────────────────── */

const HONESTY = [
  { part: "Vault contracts and share accounting", real: true, note: "Deployed and verified on Coston2" },
  { part: "All five guardrails", real: true, note: "Enforced in the rebalance path, 60 tests" },
  { part: "FXRP", real: true, note: "The real FAssets token — 6 decimals, not a mock" },
  { part: "FTSO XRP/USD price feed", real: true, note: "Read live from ~100 providers" },
  { part: "FDC Web2Json attestation", real: true, note: "Real attestation round, real Merkle proof" },
  { part: "Firelight stXRP venue", real: true, note: "Live third-party vault, ~100k FXRP TVL" },
  { part: "Enclave code path, identity, signing", real: true, note: "The same binary that runs under FCC" },
  {
    part: "Hardware attestation quote verification",
    real: false,
    note: "SIMULATED_TEE=true — Coston2 has no Confidential Space hardware",
  },
];

export const SceneRealOrSim: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="What is real and what is not"
      title="One thing is simulated, and it is named here"
      sub="A demo that blurs this line is not a demo, it is a pitch. So here is the whole list."
    />

    <div>
      {HONESTY.map((h, i) => (
        <Reveal key={h.part} delay={38 + i * 17}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 190px 1fr",
              gap: 24,
              alignItems: "center",
              padding: "17px 26px",
              borderBottom: `1px solid ${c.line}`,
              background: h.real ? (i % 2 ? "transparent" : c.panel) : `${c.warn}12`,
            }}
          >
            <div style={{ fontSize: 24, color: c.text }}>{h.part}</div>
            <div>
              <Pill color={h.real ? c.good : c.warn}>{h.real ? "● REAL" : "◐ SIMULATED"}</Pill>
            </div>
            <div style={{ fontFamily: code, fontSize: 19, color: c.muted }}>{h.note}</div>
          </div>
        </Reveal>
      ))}
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

/* ── 14. Live on Coston2 ──────────────────────────────────────────────── */

const ADDRS = [
  { label: "TacitVault", addr: "0xFA02DA641C0DC58625eB3fC77cE772d7b1DdA9A8", color: c.accent },
  { label: "Venue A · 8% APR", addr: "0xCC2f2b4003cBa792f64c0769A2c45b2E77863eEB", color: c.s1 },
  { label: "Venue B · 15% APR", addr: "0xCc36AC63379FE74E6C27414c6b0475c47606D72B", color: c.s2 },
  { label: "Firelight adapter", addr: "0x4a901841Bccd01C990d8d7A0f25E4e4FCf05a124", color: c.s3 },
  { label: "Enclave identity", addr: "0x89E6C7AD562cf6e664aDBE425E9e323F9A8a3bC5", color: c.good },
];

const GUARDS = [
  { k: "Synchronous venue cap", v: "60%" },
  { k: "Firelight (async) cap", v: "30%" },
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
            <Pill color={c.good}>forge test -vv → 60 PASSED</Pill>
            <Pill color={c.good}>go test ./... → 8 PASSED</Pill>
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

/* ── 15. Closing ──────────────────────────────────────────────────────── */

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
      </div>

      {/* Hand-off to the UI walkthrough that is appended after this card. Last
       *  thing revealed, and it holds for ~4s so it is read before the cut. */}
      <Reveal delay={182}>
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
            marginBottom: 30,
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
          <div style={{ fontSize: 27, color: c.text, lineHeight: 1.4 }}>
            A screen recording of the live Tacit interface follows —{" "}
            <span style={{ color: c.muted }}>
              depositing FXRP, watching the enclave publish a plan, and the vault settle it on
              Coston2.
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 34, color: c.accent, lineHeight: 1, flexShrink: 0 }}>▶</div>
        </div>
      </Reveal>

      <Reveal delay={140}>
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
    </Stage>
  );
};
