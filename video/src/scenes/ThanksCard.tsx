import React from "react";
import { AbsoluteFill } from "remotion";
import { Pill } from "../components/ui";
import { c, code, sans } from "../theme";

/* Standalone still card. Not on the timeline — rendered via `npm run still-thanks`
 * so it can be dropped into slides, thumbnails, or the end of a screen recording
 * without touching the main composition.
 *
 * The visual language is copied from SceneClosing so the card reads as the same
 * product: crimson eyebrow, monospace label, white headline, muted body, footer
 * with the ◆ mark and status pills. No entrance animations — a still frame does
 * not need reveals, and the card must look right at frame 0. */
export const ThanksCard: React.FC = () => (
  <AbsoluteFill style={{ background: c.bg, fontFamily: sans, color: c.text }}>
    {/* One soft crimson bloom to match the video's background treatment. */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(1200px 800px at 78% 24%, rgba(230,32,88,0.10), transparent 55%)",
        pointerEvents: "none",
      }}
    />

    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: 96,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* Chapter-style eyebrow so the card stays recognisable next to the
          existing scenes even without the Stage chrome. */}
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ fontSize: 42, color: c.accent, lineHeight: 1 }}>◆</div>
        <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.03em" }}>Tacit</div>
      </div>

      <div style={{ maxWidth: 1600 }}>
        <div
          style={{
            fontFamily: code,
            fontSize: 20,
            letterSpacing: "0.18em",
            color: c.accent,
            marginBottom: 26,
          }}
        >
          THAT'S TACIT
        </div>

        <div
          style={{
            fontSize: 60,
            fontWeight: 500,
            lineHeight: 1.28,
            letterSpacing: "-0.018em",
          }}
        >
          Autonomous treasury management{" "}
          <span style={{ color: c.muted }}>
            without giving the strategy unrestricted control of the funds.
          </span>
        </div>

        {/* Crimson rule matched to the closing card's motion end-state. */}
        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, ${c.accent}, ${c.accent}00)`,
            width: "42%",
            margin: "52px 0 40px",
          }}
        />

        <div
          style={{
            fontSize: 40,
            fontWeight: 600,
            fontFamily: sans,
            color: c.accent,
            letterSpacing: "-0.015em",
          }}
        >
          Thanks for watching.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          borderTop: `1px solid ${c.line}`,
          paddingTop: 30,
        }}
      >
        <div style={{ fontSize: 26, color: c.muted }}>The enclave controls strategy quality,</div>
        <div style={{ fontSize: 26, color: c.text, fontWeight: 600 }}>never fund safety.</div>
        <div style={{ flex: 1 }} />
        <Pill color={c.good}>● LIVE ON COSTON2</Pill>
        <Pill color={c.dim}>FLARE SUMMER SIGNAL 2026</Pill>
      </div>
    </div>
  </AbsoluteFill>
);
