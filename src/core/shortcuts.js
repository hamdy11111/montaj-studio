// Keyboard shortcut registry (FEAT-138, report Appendix C). Defaults reproduce preset «Shortcut 1» as documented.
// A chord is "Ctrl+Alt+Shift+Key" with a canonical modifier order. Mouse gestures are display-only (fixed).
import { AppError } from "./validation.js";

export const PRESET_IDS = [1, 2, 3, 4, 5];
const MOD_ORDER = ["Ctrl", "Alt", "Shift"];

/** [id, tab, label (English, as in the report), default chord ("" = unassigned), flags] */
const DEFS = [
  ["split", "timeline", "Split", "E"], ["splitAll", "timeline", "Split all", "Ctrl+Shift+B"], ["selectMode", "timeline", "Select mode", "V"],
  ["splitMode", "timeline", "Split mode", "B"], ["selectLeftward", "timeline", "Select leftward", "["], ["selectRightward", "timeline", "Select rightward", "]"],
  ["toggleMagnet", "timeline", "Main track magnet", "P"], ["toggleSnapping", "timeline", "Auto snapping", "N"], ["toggleLinkage", "timeline", "Linkage switch", "`"],
  ["togglePreviewAxis", "timeline", "Preview axis switch", "S"], ["zoomIn", "timeline", "Zoom in", "Ctrl+="], ["zoomOut", "timeline", "Zoom out", "Ctrl+-"],
  ["zoomWheel", "timeline", "Zoom in/Zoom out", "Ctrl+Wheel", { fixed: true }], ["scrollVertical", "timeline", "Up/Down", "Wheel", { fixed: true }],
  ["scrollHorizontal", "timeline", "Left/Right", "Alt+Wheel", { fixed: true }], ["toggleClipActive", "timeline", "Activate/Deactivate clip", ""],
  ["extractAudio", "timeline", "Extract/Restore audio", ""], ["addMarker", "timeline", "Add marker", "M"], ["addMarkerColor", "timeline", "Add marker with new color", "Alt+M"],
  ["nextMarker", "timeline", "Go to next marker", "Shift+M"], ["prevMarker", "timeline", "Go to previous marker", "Alt+Shift+M"],
  ["prevFrame", "timeline", "Previous frame", "Left"], ["nextFrame", "timeline", "Next frame", "Right"], ["firstFrame", "timeline", "Locate to first frame", "Home"],
  ["lastFrame", "timeline", "Locate to last frame", "End"], ["prevCut", "timeline", "Last cut point", "Up"], ["nextCut", "timeline", "Next cut point", "Down"],
  ["inPoint", "timeline", "In point", "I"], ["outPoint", "timeline", "Out point", "O"], ["selectByClip", "timeline", "Select by clip", "Shift+X"],
  ["deselect", "timeline", "Deselect", "Alt+X"], ["group", "timeline", "Group", "Ctrl+G"], ["ungroup", "timeline", "Ungroup", "Ctrl+Shift+G"],
  ["speedPanel", "timeline", "Show speed panel", "Ctrl+R"], ["curveSpeed", "timeline", "Curve speed", "Shift+B"], ["createCompound", "timeline", "Create compound clip (subproject)", "Alt+G"],
  ["undoCompound", "timeline", "Undo compound clip (subproject)", "Alt+Shift+G"], ["volumeUp", "timeline", "Volume +0.1dB", "Ctrl+."], ["volumeDown", "timeline", "Volume -0.1dB", "Ctrl+,"],
  ["playInOut", "timeline", "In", "Shift+Enter"], ["shuttleLeft", "timeline", "Shuttle left", "J"], ["shuttleStop", "timeline", "Shuttle stop", "K"], ["shuttleRight", "timeline", "Shuttle right", "L"],
  ["deleteLeft", "timeline", "Delete left", "Q"], ["deleteRight", "timeline", "Delete right", "W"], ["keyframePanel", "timeline", "Show/Hide keyframe panel", "Alt+K"],
  ["addKeyframeOnPanel", "timeline", "Add keyframe on keyframe panel", "Shift+Click", { fixed: true }], ["addKeyframe", "timeline", "Add keyframe", "Alt+Shift+K"],
  ["easeIn", "timeline", "Ease in", ""], ["easeOut", "timeline", "Ease out", ""], ["easing", "timeline", "Easing", ""], ["linear", "timeline", "Linear", ""],
  ["stepForwardMany", "timeline", "Step forward many frames", "Shift+Right"], ["stepBackMany", "timeline", "Step back many frames", "Shift+Left"],
  ["zoomFit", "timeline", "Zoom to fit timeline", "Shift+Z"], ["freeze", "timeline", "Freeze", ""], ["reverse", "timeline", "Reverse", ""], ["mirror", "timeline", "Mirror", ""],
  ["rotate", "timeline", "Rotate", ""], ["crop", "timeline", "Crop", ""], ["trimClip", "timeline", "Trim clip", ""], ["generateCaptions", "timeline", "Generate captions", ""],
  ["isolateNone", "timeline", "Don't isolate voice", ""], ["keepVocal", "timeline", "Keep vocal", ""], ["removeVocal", "timeline", "Remove vocal", ""],
  ["openFileLocation", "timeline", "Open file location", ""], ["linkToMedia", "timeline", "Link to media", ""], ["splitScenes", "timeline", "Split scenes", ""],
  ["replaceClip", "timeline", "Replace clip", ""], ["exportSelected", "timeline", "Export selected clips", ""], ["savePreset", "timeline", "Save preset", ""],
  ["preprocessCompound", "timeline", "Pre-process compound clip (subproject)", ""], ["clearBeats", "timeline", "Clear beats", ""], ["voiceover", "timeline", "Voiceover", ""],
  ["recordScreen", "timeline", "Record screen", "Ctrl+Alt+P"],
  ["playPause", "player", "Play/Pause", "Space"], ["fullscreen", "player", "Enter/Exit full screen", "Ctrl+Shift+F"], ["playerZoomIn", "player", "Zoom in player", "Alt+Shift+="],
  ["playerZoomOut", "player", "Zoom out player", "Alt+Shift+-"], ["playerZoomFit", "player", "Zoom to fit player", "Alt+Shift+Z"], ["toggleRulers", "player", "Show/hide rulers", "Ctrl+Alt+R"],
  ["toggleGuides", "player", "Show/hide guides", "Ctrl+;"],
  ["copy", "basic", "Copy", "Ctrl+C"], ["cut", "basic", "Cut", "Ctrl+X"], ["paste", "basic", "Paste", "Ctrl+V"], ["copyAttributes", "basic", "Copy attributes", "Ctrl+Shift+C"],
  ["pasteAttributes", "basic", "Paste attributes", "Ctrl+Shift+V"], ["delete", "basic", "Delete", "Backspace"], ["undo", "basic", "Undo", "Ctrl+Z"], ["redo", "basic", "Redo / Reset", "Ctrl+Shift+Z"],
  ["importMedia", "basic", "Import media", "Ctrl+I"], ["exportStill", "basic", "Export still frames", ""], ["export", "basic", "Export", "Ctrl+E"], ["newProject", "basic", "New project", "Ctrl+N"],
  ["switchMaterialPanel", "basic", "Switch material panel", "Tab"], ["backToHome", "basic", "Back to edit / home", "Ctrl+Alt+Q"], ["quit", "basic", "Quit", "Ctrl+Q"],
  ["exitFullscreen", "basic", "Exit full screen", "Escape"], ["selectAll", "basic", "Select all", "Ctrl+A"],
  ["resizeTextFromCenter", "other", "Resize the text box from the center", "Alt+Drag", { fixed: true }],
];

export const COMMANDS = DEFS.map(([id, tab, label, chord, flags = {}]) => ({ id, tab, label, defaultChord: chord, fixed: !!flags.fixed }));
export const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));

export function defaultBindings() {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaultChord]));
}

const KEY_ALIASES = { " ": "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Esc: "Escape", Del: "Delete", "+": "=", "_": "-" };

/** Canonical chord from a KeyboardEvent-like object. Returns "" for bare modifier presses. */
export function chordFromEvent(e) {
  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  if (e.code?.startsWith("Key")) key = e.code.slice(3);
  else if (e.code?.startsWith("Digit")) key = e.code.slice(5);
  else if (e.code === "Backquote") key = "`";
  key = KEY_ALIASES[key] ?? key;
  if (key.length === 1) key = key.toUpperCase();
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

export function normalizeChord(chord) {
  if (!chord) return "";
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  if (parts.some((p) => !MOD_ORDER.includes(p))) throw new AppError("VALIDATION", "err.shortcutInvalid");
  return [...mods, key].join("+");
}

/** Validate a new binding for `commandId`; returns {chord, conflictWith|null}. */
export function checkBinding(bindings, commandId, chord) {
  const cmd = COMMANDS.find((c) => c.id === commandId);
  if (!cmd) throw new AppError("NOT_FOUND", "err.commandNotFound");
  if (cmd.fixed) throw new AppError("VALIDATION", "err.shortcutFixed");
  const norm = normalizeChord(chord);
  if (norm && norm.split("+").length > 4) throw new AppError("VALIDATION", "err.shortcutTooManyModifiers");
  const conflictWith = norm ? Object.entries(bindings).find(([id, c]) => id !== commandId && c === norm)?.[0] || null : null;
  return { chord: norm, conflictWith };
}

/** Apply a binding; when `override` is true the conflicting command is unassigned. */
export function applyBinding(bindings, commandId, chord, { override = false } = {}) {
  const { chord: norm, conflictWith } = checkBinding(bindings, commandId, chord);
  if (conflictWith && !override) throw new AppError("CONFLICT", "err.shortcutConflict", { conflictWith });
  const next = { ...bindings, [commandId]: norm };
  if (conflictWith) next[conflictWith] = "";
  return next;
}

/** All conflicting pairs in a binding map (used to flag rows with the warning icon). */
export function findConflicts(bindings) {
  const byChord = {};
  for (const [id, c] of Object.entries(bindings)) if (c) (byChord[c] ||= []).push(id);
  return Object.values(byChord).filter((ids) => ids.length > 1);
}

/** Display form, e.g. "Ctrl+Left" → ["Ctrl", "←"]. */
export function displayKeys(chord) {
  const map = { Left: "←", Right: "→", Up: "↑", Down: "↓", "=": "+", Backspace: "⌫ Backspace", Escape: "Esc" };
  return chord ? chord.split("+").map((k) => map[k] || k) : [];
}

export function lookup(bindings, chord) {
  if (!chord) return null;
  return Object.entries(bindings).find(([, c]) => c === chord)?.[0] || null;
}
