// Undo/Redo (FEAT-022): snapshot history per timeline. Consecutive edits sharing a coalesce key within
// `coalesceMs` (e.g. dragging a slider) collapse into one undo step.
import { deepClone } from "./util.js";

export class History {
  constructor({ limit = 200, coalesceMs = 800 } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = null;
    this.lastAt = 0;
  }

  /** Record the state *before* an edit. */
  push(stateBefore, label = "", coalesceKey = null, now = Date.now()) {
    if (coalesceKey && coalesceKey === this.lastKey && now - this.lastAt < this.coalesceMs && this.undoStack.length) {
      this.lastAt = now;
      this.redoStack = [];
      return false;
    }
    this.undoStack.push({ state: deepClone(stateBefore), label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.lastKey = coalesceKey;
    this.lastAt = now;
    return true;
  }

  /**
   * Merge every entry pushed since `depth` into one, labelled `label` (a skill run is one undo step). Returns
   * true when something was merged.
   */
  squashSince(depth, label) {
    if (this.undoStack.length <= depth) return false;
    const first = this.undoStack[depth];
    this.undoStack.length = depth;
    this.undoStack.push({ state: first.state, label });
    this.redoStack = [];
    this.lastKey = null;
    return true;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Returns the state to restore, given the current one. */
  undo(current) {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ state: deepClone(current), label: entry.label });
    this.lastKey = null;
    return { state: entry.state, label: entry.label };
  }

  redo(current) {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ state: deepClone(current), label: entry.label });
    this.lastKey = null;
    return { state: entry.state, label: entry.label };
  }

  info() {
    return { canUndo: this.canUndo(), canRedo: this.canRedo(), undoLabel: this.undoStack.at(-1)?.label || "", redoLabel: this.redoStack.at(-1)?.label || "", depth: this.undoStack.length };
  }

  clear() { this.undoStack = []; this.redoStack = []; this.lastKey = null; }
}
