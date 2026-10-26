// The editor's Player module (built to src/renderer/js/editor/graphicsPlayer.js): mounts a Remotion Player that shows
// one kit graphic — the same Graphic component the render uses — and lets the editor drive its frame. The editor's
// clock is the only clock: the Player never plays on its own, it is seeked to the playhead on every editor frame.
import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
import { Graphic } from "../remotion/Graphic.jsx";

const Host = forwardRef(function Host({ initial }, ref) {
  const [state, setState] = useState(initial);
  const player = useRef(null);
  useImperativeHandle(ref, () => ({
    update: (next) => setState((s) => ({ ...s, ...next })),
    seek: (frame) => player.current?.seekTo(Math.max(0, Math.min(state.durationInFrames - 1, frame))),
  }), [state.durationInFrames]);
  return (
    <Player ref={player} component={Graphic} inputProps={{ template: state.template, params: state.params, pack: state.pack, assetBase: "", fontBase: false }}
      durationInFrames={Math.max(1, state.durationInFrames)} fps={state.fps} compositionWidth={state.width} compositionHeight={state.height}
      style={{ width: "100%", height: "100%", background: "transparent" }} controls={false} clickToPlay={false} doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false} moveToBeginningWhenEnded={false} initiallyShowControls={false} acknowledgeRemotionLicense
      numberOfSharedAudioTags={0} /* graphics are silent; the shared tags would load a data: sound the app's CSP refuses */ />
  );
});

/**
 * Mount a graphic in `el`. g: { template, params, pack, width, height, fps, durationInFrames }.
 * Returns { update(g), seek(frame), destroy() }.
 */
export function mountGraphic(el, g) {
  const ref = React.createRef();
  const root = createRoot(el);
  root.render(<Host ref={ref} initial={g} />);
  let pendingFrame = null;
  const whenReady = (fn) => (ref.current ? fn() : requestAnimationFrame(() => whenReady(fn)));
  return {
    update: (next) => whenReady(() => ref.current.update(next)),
    seek: (frame) => { pendingFrame = frame; whenReady(() => { if (pendingFrame !== null) { ref.current.seek(pendingFrame); pendingFrame = null; } }); },
    destroy: () => root.unmount(),
  };
}

export const VERSION = "phase3";
