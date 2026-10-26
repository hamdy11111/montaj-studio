// Compositions of the bundle. "Graphic" renders one kit template (its size, rate and length come from the input
// props); "Sheet" lays several graphics out in time one after another (the sample videos per family).
import React from "react";
import { Composition, Sequence, AbsoluteFill } from "remotion";
import { Graphic } from "./Graphic.jsx";

const meta = ({ props }) => ({ durationInFrames: Math.max(1, Math.round(props.durationInFrames || 60)), fps: props.fps || 30, width: props.width || 1080, height: props.height || 1920 });

/** items: [{ template, params, from, durationInFrames }] — each graphic in its own Sequence (its own clock). */
const Sheet = ({ items = [], pack, assetBase, background }) => (
  <AbsoluteFill style={{ background: background || "transparent" }}>
    {items.map((it, i) => (
      <Sequence key={i} from={it.from} durationInFrames={it.durationInFrames} layout="none">
        <Graphic template={it.template} params={it.params} pack={pack} assetBase={assetBase} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const Root = () => (
  <>
    <Composition id="Graphic" component={Graphic} durationInFrames={48} fps={30} width={1080} height={1920}
      defaultProps={{ template: "kinetic-word", params: {}, pack: "punchy", assetBase: "", durationInFrames: 48, fps: 30, width: 1080, height: 1920 }} calculateMetadata={meta} />
    <Composition id="Sheet" component={Sheet} durationInFrames={60} fps={30} width={1080} height={1920}
      defaultProps={{ items: [], pack: "punchy", assetBase: "", durationInFrames: 60, fps: 30, width: 1080, height: 1920 }} calculateMetadata={meta} />
  </>
);
