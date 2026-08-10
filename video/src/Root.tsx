import React from "react";
import { AbsoluteFill, Composition, Series } from "remotion";
import { FPS, SCENES, TOTAL, c } from "./theme";
import { SceneCtx } from "./components/ui";
import {
  SceneHumanManaged,
  SceneProblem,
  SceneTitle,
  SceneWhatItIs,
} from "./scenes/Intro";
import { SceneArchitecture, SceneInvariants, SceneLifecycle } from "./scenes/System";
import { SceneAttack, SceneFirelight, SceneFuzz, SceneResidual } from "./scenes/Proof";
import { SceneClosing, SceneLive, ScenePrimitives, SceneRealOrSim } from "./scenes/Real";

/** Playback order. Each entry pairs a scene component with its frame budget in
 *  theme.ts, so pacing is retuned in one place and never drifts from the
 *  composition's total duration. */
const TIMELINE: { key: keyof typeof SCENES; Scene: React.FC }[] = [
  { key: "title", Scene: SceneTitle },
  { key: "problem", Scene: SceneProblem },
  { key: "humanManaged", Scene: SceneHumanManaged },
  { key: "whatItIs", Scene: SceneWhatItIs },
  { key: "architecture", Scene: SceneArchitecture },
  { key: "lifecycle", Scene: SceneLifecycle },
  { key: "invariants", Scene: SceneInvariants },
  { key: "attack", Scene: SceneAttack },
  { key: "residual", Scene: SceneResidual },
  { key: "fuzz", Scene: SceneFuzz },
  { key: "firelight", Scene: SceneFirelight },
  { key: "primitives", Scene: ScenePrimitives },
  { key: "realOrSim", Scene: SceneRealOrSim },
  { key: "live", Scene: SceneLive },
  { key: "closing", Scene: SceneClosing },
];

/** Absolute start frame + index for each scene, resolved once. Series re-bases
 *  the frame counter per sequence — great for authoring reveal delays from 0,
 *  useless for anything that has to know where it sits in the whole run. Stage
 *  reads this to dissolve across the boundary and to draw the progress rule. */
const ENTRIES = (() => {
  let start = 0;
  return TIMELINE.map(({ key, Scene }, index) => {
    const entry = { key, Scene, index, start, duration: SCENES[key] };
    start += SCENES[key];
    return entry;
  });
})();

export const TacitDemo: React.FC = () => (
  <AbsoluteFill style={{ background: c.bg }}>
    <Series>
      {ENTRIES.map(({ key, Scene, index, start, duration }) => (
        <Series.Sequence key={key} durationInFrames={duration}>
          <SceneCtx.Provider value={{ index, count: ENTRIES.length, start, duration }}>
            <Scene />
          </SceneCtx.Provider>
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <Composition
    id="TacitDemo"
    component={TacitDemo}
    durationInFrames={TOTAL}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
