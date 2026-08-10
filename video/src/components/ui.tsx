import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { SCENES, TOTAL, c, code, sans } from "../theme";

/** Eased fade + rise. Everything in the video enters this way, so the motion
 *  language stays consistent and nothing competes for attention. */
export const useReveal = (delay: number, dur = 18) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame - delay, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const e = 1 - Math.pow(1 - t, 3);
  return { opacity: e, transform: `translateY(${(1 - e) * 14}px)`, t: e };
};

export const Reveal: React.FC<{
  delay: number;
  dur?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay, dur, style, children }) => {
  const r = useReveal(delay, dur);
  return <div style={{ ...style, opacity: r.opacity, transform: r.transform }}>{children}</div>;
};

/** Where a scene sits in the whole video. Root supplies this; Stage uses it to
 *  dissolve between scenes and to draw the persistent progress chrome. */
export type SceneMeta = { index: number; count: number; start: number; duration: number };

export const SceneCtx = React.createContext<SceneMeta>({
  index: 0,
  count: 1,
  start: 0,
  duration: 150,
});

/** Scene boundaries as fractions of the whole run, drawn as chapter ticks. */
const chapterTicks = (): number[] => {
  const out: number[] = [];
  let run = 0;
  for (const d of Object.values(SCENES)) {
    run += d;
    out.push(run / TOTAL);
  }
  return out;
};
const TICKS = chapterTicks();

/** Full-frame stage: flat near-black plane, one soft crimson bloom.
 *
 *  Two things happen here rather than in the scenes. The children dissolve in
 *  and out across the scene boundary — through the flat background, never
 *  through black, so a cut reads as a hand-off rather than a flash. And the
 *  chrome (chapter counter, progress rule) sits outside that dissolve so it
 *  survives the boundary; with no narration it is the only cue for how far
 *  through the video a viewer is. */
export const Stage: React.FC<{ children: React.ReactNode; pad?: number }> = ({
  children,
  pad = 96,
}) => {
  const frame = useCurrentFrame();
  const { index, count, start, duration } = React.useContext(SceneCtx);

  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const fadeIn = interpolate(frame, [0, 9], [0, 1], clamp);
  const fadeOut = interpolate(frame, [duration - 10, duration - 1], [1, 0], clamp);
  const veil = Math.min(fadeIn, fadeOut);

  const abs = start + frame;
  const progress = abs / TOTAL;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: c.bg,
        fontFamily: sans,
        color: c.text,
        padding: pad,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Drifts across the whole run so the frame is never completely static. */}
      <div
        style={{
          position: "absolute",
          top: -420 + Math.sin(abs / 240) * 70,
          left: -280 + Math.cos(abs / 330) * 110,
          width: 1100,
          height: 1100,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${c.accent}14 0%, transparent 62%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 44,
          right: 52,
          fontFamily: code,
          fontSize: 16,
          letterSpacing: "0.16em",
          color: c.dim,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {String(index + 1).padStart(2, "0")} / {count}
      </div>

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          opacity: veil,
        }}
      >
        {children}
      </div>

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: c.line }}>
        <div style={{ height: 3, width: `${progress * 100}%`, background: c.accent }} />
        {TICKS.slice(0, -1).map((t) => (
          <div
            key={t}
            style={{
              position: "absolute",
              top: 0,
              left: `${t * 100}%`,
              width: 1,
              height: 3,
              background: c.bg,
            }}
          />
        ))}
      </div>
    </div>
  );
};

/** Section eyebrow + headline. The eyebrow orients; the headline is the claim. */
export const Heading: React.FC<{
  eyebrow: string;
  title: string;
  sub?: string;
  delay?: number;
}> = ({ eyebrow, title, sub, delay = 0 }) => (
  <div style={{ marginBottom: 40 }}>
    <Reveal delay={delay}>
      <div
        style={{
          fontFamily: code,
          fontSize: 20,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: c.accent,
          marginBottom: 14,
        }}
      >
        {eyebrow}
      </div>
    </Reveal>
    <Reveal delay={delay + 5}>
      <div style={{ fontSize: 58, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
        {title}
      </div>
    </Reveal>
    {sub ? (
      <Reveal delay={delay + 10}>
        <div style={{ fontSize: 27, color: c.muted, marginTop: 16, maxWidth: 1500, lineHeight: 1.45 }}>
          {sub}
        </div>
      </Reveal>
    ) : null}
  </div>
);

export const Panel: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
}> = ({ children, style, accent }) => (
  <div
    style={{
      background: c.panel,
      border: `1px solid ${c.line}`,
      borderLeft: accent ? `3px solid ${accent}` : `1px solid ${c.line}`,
      borderRadius: 10,
      padding: "26px 30px",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Pill: React.FC<{ children: React.ReactNode; color: string }> = ({
  children,
  color,
}) => (
  <span
    style={{
      fontFamily: code,
      fontSize: 19,
      color,
      border: `1px solid ${color}55`,
      background: `${color}14`,
      borderRadius: 6,
      padding: "5px 12px",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);
