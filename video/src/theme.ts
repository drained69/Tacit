import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

// Only the weights/subsets actually used. Loading the full families issues
// ~120 network requests per render worker, which dominates render time.
const inter = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
const mono = loadMono("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export const sans = inter.fontFamily;
export const code = mono.fontFamily;

/**
 * Palette is lifted from ui/styles.css so the video reads as the same product
 * as the app. Series colours are the dataviz reference dark trio, validated
 * all-pairs against the panel surface #131318 (CVD dE 9.4, normal 20.9).
 */
export const c = {
  bg: "#0a0a0c",
  panel: "#131318",
  panel2: "#1a1a21",
  line: "#26262f",
  text: "#e8e8ec",
  muted: "#8a8a99",
  dim: "#5c5c6b",
  accent: "#e62058",
  accentDim: "#7d1130",
  good: "#35c47a",
  warn: "#e0a020",
  idle: "#4a4a58",
  // categorical series (venues)
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
} as const;

export const FPS = 30;

/** Scene lengths in frames, in playback order. Budgets are set so that every
 *  scene still holds for ~3s after its last element has finished revealing —
 *  there is no narration, so reading time is the only pacing constraint. */
export const SCENES = {
  title: 150,
  problem: 330,
  humanManaged: 225,
  whatItIs: 270,
  architecture: 375,
  lifecycle: 420,
  invariants: 375,
  attack: 495,
  residual: 330,
  fuzz: 330,
  firelight: 420,
  primitives: 375,
  realOrSim: 330,
  live: 285,
  closing: 330,
} as const;

export const TOTAL = Object.values(SCENES).reduce((a, b) => a + b, 0);
