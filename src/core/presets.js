// Built-in, original presets (no CapCut assets are reused). Each entry has an i18n key and the parameters the
// preview (renderer) and the exporter (FFmpeg) both understand.

/** Filters (FEAT-094): colour looks expressed as Adjust deltas, scaled by intensity 0..100. */
export const FILTER_PRESETS = {
  vivid:     { cat: "featured", adjust: { saturation: 30, contrast: 12, brightness: 3 } },
  warm:      { cat: "life", adjust: { temperature: 35, saturation: 8, brightness: 4 } },
  cool:      { cat: "life", adjust: { temperature: -35, tint: -5, saturation: 5 } },
  golden:    { cat: "landscape", adjust: { temperature: 45, tint: 8, contrast: 8, saturation: 12 } },
  teal:      { cat: "movies", adjust: { temperature: -20, tint: -12, contrast: 18, saturation: -8 } },
  cinematic: { cat: "movies", adjust: { contrast: 22, saturation: -15, shadows: -10, vignette: 25 } },
  fade:      { cat: "retro", adjust: { contrast: -25, brightness: 6, saturation: -20 } },
  vintage:   { cat: "retro", adjust: { temperature: 25, saturation: -30, contrast: -10, vignette: 30 } },
  mono:      { cat: "mono", adjust: { saturation: -100, contrast: 10 } },
  noir:      { cat: "mono", adjust: { saturation: -100, contrast: 40, brightness: -6, vignette: 35 } },
  portrait:  { cat: "portrait", adjust: { brightness: 6, contrast: -6, saturation: -5, temperature: 8, sharpen: 10 } },
  night:     { cat: "night", adjust: { exposure: 18, temperature: -15, contrast: 10, saturation: 10 } },
  food:      { cat: "food", adjust: { saturation: 25, temperature: 18, contrast: 8, sharpen: 15 } },
  dramatic:  { cat: "featured", adjust: { contrast: 35, saturation: 10, shadows: -15, vignette: 20 } },
  pastel:    { cat: "life", adjust: { contrast: -18, brightness: 10, saturation: -12, tint: 6 } },
};
export const FILTER_CATEGORIES = ["featured", "life", "landscape", "portrait", "movies", "retro", "mono", "night", "food"];

/** Effects (FEAT-092) applied to the composite on an effect track, or to one clip (clipEffects / velocity effects). */
export const EFFECTS = {
  blur:       { cat: "basic", ffmpeg: (k) => `gblur=sigma=${(0.5 + k * 0.2).toFixed(2)}` },
  vignette:   { cat: "basic", ffmpeg: (k) => `vignette=angle=${(0.2 + k * 0.008).toFixed(3)}` },
  mono:       { cat: "basic", ffmpeg: () => "hue=s=0" },
  sepia:      { cat: "retro", ffmpeg: (k) => `colorchannelmixer=${sepiaMatrix(k / 100)}` },
  invert:     { cat: "party", ffmpeg: () => "negate" },
  rgb_split:  { cat: "party", ffmpeg: (k) => `rgbashift=rh=${Math.round(k / 8)}:bh=${-Math.round(k / 8)}` },
  noise:      { cat: "retro", ffmpeg: (k) => `noise=alls=${Math.round(k / 2)}:allf=t` },
  old_film:   { cat: "retro", ffmpeg: (k) => `colorchannelmixer=${sepiaMatrix(0.8)},noise=alls=${Math.round(k / 3)}:allf=t,vignette=angle=0.6` },
  pixelate:   { cat: "party", ffmpeg: (k) => `pixelize=width=${4 + Math.round(k / 4)}:height=${4 + Math.round(k / 4)}` },
  edge:       { cat: "party", ffmpeg: () => "edgedetect=mode=colormix:high=0.2" },
  mirror:     { cat: "motion", ffmpeg: () => "split[ma][mb];[mb]hflip,crop=iw/2:ih:iw/2:0[mr];[ma][mr]overlay=W/2:0:format=auto" },
  glow:       { cat: "light", ffmpeg: (k) => `split[ga][gb];[gb]gblur=sigma=${4 + k / 10}[gbl];[ga][gbl]blend=all_mode=screen:all_opacity=${(k / 150).toFixed(2)}` },
  letterbox:  { cat: "movies", ffmpeg: (k) => `drawbox=x=0:y=0:w=iw:h=ih*${(0.04 + k * 0.0012).toFixed(4)}:color=black:t=fill,drawbox=x=0:y=ih-ih*${(0.04 + k * 0.0012).toFixed(4)}:w=iw:h=ih*${(0.04 + k * 0.0012).toFixed(4)}:color=black:t=fill` },
  flash:      { cat: "light", ffmpeg: (k, t0) => `eq=brightness='${(k / 120).toFixed(3)}*max(0,1-abs(sin(PI*(t-${t0})*2)))':eval=frame` },
  shake:      { cat: "motion", ffmpeg: (k, t0) => `crop=iw*0.94:ih*0.94:'iw*0.03+iw*0.03*${(k / 100).toFixed(2)}*sin(2*PI*(t-${t0})*9)':'ih*0.03+ih*0.03*${(k / 100).toFixed(2)}*cos(2*PI*(t-${t0})*7)',scale=iw/0.94:ih/0.94` },
  deflicker:  { cat: "basic", ffmpeg: (k) => `deflicker=size=${3 + Math.round(k / 12)}:mode=pm` }, // Remove flickers (FEAT-050)
  // Constant output size (a size-changing crop breaks the graph): perspective maps a shrinking source window to the frame.
  zoom_pulse: { cat: "motion", ffmpeg: (k, t0, fps = 30) => { const d = `(${(k / 800).toFixed(4)}*abs(sin(PI*(in/${fps}-${t0}))))`; return `perspective=x0='W*${d}':y0='H*${d}':x1='W-W*${d}':y1='H*${d}':x2='W*${d}':y2='H-H*${d}':x3='W-W*${d}':y3='H-H*${d}':interpolation=linear:sense=source:eval=frame`; } },
};
export const EFFECT_CATEGORIES = ["basic", "light", "motion", "party", "retro", "movies"];

function sepiaMatrix(a) {
  // Blend identity with the classic sepia matrix by amount a.
  const m = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const v = m.map((x, i) => (id[i] + (x - id[i]) * a).toFixed(3));
  return `rr=${v[0]}:rg=${v[1]}:rb=${v[2]}:gr=${v[3]}:gg=${v[4]}:gb=${v[5]}:br=${v[6]}:bg=${v[7]}:bb=${v[8]}`;
}

/** Text style presets (FEAT-077 "Preset style"). */
export const TEXT_PRESETS = {
  none: {},
  outline_white: { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 3 },
  outline_black: { color: "#000000", strokeColor: "#FFFFFF", strokeWidth: 3 },
  yellow_bold: { color: "#FFD400", strokeColor: "#000000", strokeWidth: 2, bold: true },
  box_dark: { color: "#FFFFFF", bgColor: "#000000", bgOpacity: 70 },
  box_light: { color: "#111111", bgColor: "#FFFFFF", bgOpacity: 90 },
  neon_cyan: { color: "#00F0FF", shadow: true, strokeColor: "#004D55", strokeWidth: 1 },
  red_pop: { color: "#FF3B3B", strokeColor: "#FFFFFF", strokeWidth: 3, bold: true },
  caption: { color: "#FFFFFF", bgColor: "#000000", bgOpacity: 55, size: 12 },
};

/** Voice changer presets (FEAT-065) implemented with FFmpeg audio filters (sr = sample rate). */
export const VOICE_CHANGERS = {
  none: () => "",
  chipmunk: (sr) => `asetrate=${Math.round(sr * 1.45)},aresample=${sr},atempo=0.69`,
  deep: (sr) => `asetrate=${Math.round(sr * 0.75)},aresample=${sr},atempo=1.333`,
  robot: () => "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
  echo: () => "aecho=0.8:0.88:120:0.4",
  hall: () => "aecho=0.8:0.9:500|900:0.4|0.25",
  telephone: () => "highpass=f=300,lowpass=f=3400",
  megaphone: () => "highpass=f=500,lowpass=f=4000,acompressor=threshold=0.1:ratio=8",
  vibrato: () => "vibrato=f=7:d=0.6",
};

/** Audio enhancement chains (FEAT-060/062, local signal processing — not AI). */
export const AUDIO_CHAINS = {
  denoise: "afftdn=nf=-25",
  enhanceVoice: "highpass=f=80,lowpass=f=12000,acompressor=threshold=0.125:ratio=3:attack=10:release=200,equalizer=f=3000:t=q:w=1:g=3",
  remove_vocal: "pan=stereo|c0=c0-c1|c1=c1-c0",
  keep_vocal: "pan=mono|c0=0.5*c0+0.5*c1,highpass=f=120,lowpass=f=7000",
};

/** Built-in stickers are original SVG shapes shipped with the app (src/renderer/assets/stickers). */
export const BUILTIN_STICKERS = [
  { id: "arrow_right", cat: "shapes" }, { id: "circle_ring", cat: "shapes" }, { id: "star", cat: "shapes" }, { id: "heart", cat: "love" },
  { id: "spark", cat: "emphasis" }, { id: "speech", cat: "emphasis" }, { id: "check", cat: "icons" }, { id: "cross", cat: "icons" },
  { id: "subscribe", cat: "emphasis" }, { id: "underline", cat: "emphasis" }, { id: "fire", cat: "icons" }, { id: "question", cat: "icons" },
];
export const STICKER_CATEGORIES = ["shapes", "emphasis", "icons", "love", "yours"];

export const TRANSITION_CATEGORIES = { basic: ["dissolve", "fade_black"], slide: ["slide_left", "slide_right", "slide_up", "slide_down", "push_left", "push_right"], camera: ["zoom_in", "zoom_out", "spin"] };
