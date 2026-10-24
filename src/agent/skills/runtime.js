// Skill runtime: runs a skill's steps against one timeline through the Editing API. A top-level run is one
// transaction — its edits are merged into a single undo step "skill:<id>", and on failure (or cancel) the
// timeline is restored to the snapshot taken before the first step. Templates are plain data substitution
// ({{inputs.x}}, {{steps.<id>.result.path}}, {{ctx.timelineId}}, {{settings.<key>}}); nothing is evaluated as code.
// Settings are style values a skill owns (audio.loudness, look.filter, …). In a composition the composing skill's
// value wins for the keys it sets, and two children setting the same key differently is a conflict.
import { AppError } from "../../core/validation.js";
import { mainTrack } from "../../core/model.js";
import { deepClone } from "../../core/util.js";
import { OPERATION_INDEX } from "../operations.js";
import { ajv, satisfies } from "./registry.js";

const MAX_DEPTH = 4;
const durationOf = (tl) => tl.tracks.reduce((m, t) => Math.max(m, ...t.segments.map((s) => s.start + s.duration), 0), 0);

function lookup(root, dotted) {
  if (dotted.startsWith("settings.")) return root.settings?.[dotted.slice(9)]; // keys contain dots
  let v = root;
  for (const k of dotted.split(".")) { if (v === null || v === undefined) return undefined; v = v[k]; }
  return v;
}

/** Substitute {{...}} references. A string that is exactly one reference keeps the referenced value's type. */
export function resolveTemplates(value, scope) {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(value);
    if (whole) return lookup(scope, whole[1]);
    return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, ref) => { const v = lookup(scope, ref); return v === undefined || v === null ? "" : String(v); });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, scope)]).filter(([, v]) => v !== undefined));
  return value;
}

const validators = new Map();
function compiled(schema) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, ajv.compile(schema));
  return validators.get(key);
}

/** Apply defaults and validate inputs against a JSON Schema; throws VALIDATION with the problems. */
export function checkInputs(schema, inputs, field = "inputs") {
  const data = deepClone(inputs || {});
  const v = compiled(schema || { type: "object" });
  if (!v(data)) throw new AppError("VALIDATION", "err.inputsInvalid", { field, errors: (v.errors || []).slice(0, 10).map((e) => `${e.instancePath || "/"} ${e.message}`) });
  return data;
}

export class SkillRuntime {
  constructor({ registry }) { this.registry = registry; }

  timelineFacts(ctx, timelineId) {
    const r = ctx.services.timelines.get(timelineId);
    const main = mainTrack(r.timeline)?.segments || [];
    return { timeline: r.timeline, revision: r.revision, depth: r.history.depth, facts: { timelineId, durationUs: durationOf(r.timeline), mainClipCount: main.length, hasCuts: main.length > 1, revision: r.revision } };
  }

  /** Run a skill. Returns a report { skillId, version, steps:[...], before, after, undoLabel }. */
  async run({ skillId, version = null, timelineId, inputs = {}, ctx, job = null, expectedRevision, depth = 0, settings = null, parentSettings = null }) {
    if (depth > MAX_DEPTH) throw new AppError("VALIDATION", "err.skillTooDeep", { skillId });
    const skill = this.registry.get(skillId, version);
    // Permissions: the caller must hold every scope the skill declares.
    for (const s of skill.permissions) if (!ctx.guard.hasScope(s)) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: s, skillId });
    for (const p of skill.requires?.providers || []) if (p === "whisper" && !(await ctx.services.captions.status()).autoCaptions) throw new AppError("PROVIDER", "err.whisperNotConfigured", { skillId });
    const args = checkInputs(skill.inputs, inputs, `${skillId}.inputs`);

    // Composition: a key set differently by two composed skills is a conflict unless the composing skill sets it.
    const owned = settings || { values: new Map() };
    for (const [k, v] of Object.entries(skill.settings || {})) {
      if (depth > 0 && parentSettings && Object.prototype.hasOwnProperty.call(parentSettings, k)) continue; // parent decides
      const prev = owned.values.get(k);
      if (prev && prev.value !== v) throw new AppError("CONFLICT", "err.skillConflict", { key: k, a: `${prev.skill}=${prev.value}`, b: `${skillId}=${v}` });
      owned.values.set(k, { value: v, skill: skillId });
    }
    const effective = Object.fromEntries(Object.keys(skill.settings || {}).map((k) => [k, owned.values.get(k)?.value]));

    const top = depth === 0;
    if (top) ctx.services.timelines.checkRevision(timelineId, expectedRevision);
    const start = this.timelineFacts(ctx, timelineId);
    const snapshot = top ? deepClone(start.timeline) : null;
    const report = { skillId, version: skill.version, steps: [], before: { durationUs: start.facts.durationUs, revision: start.revision } };
    const results = {};
    try {
      for (const [i, step] of skill.steps.entries()) {
        if (job?.cancelled) throw new AppError("MEDIA", "err.cancelled");
        const facts = this.timelineFacts(ctx, timelineId).facts;
        const scope = { inputs: args, steps: results, ctx: facts, settings: effective };
        if (step.when) {
          const neg = step.when.startsWith("!");
          const val = lookup(scope, step.when.replace(/^!/, ""));
          if (neg ? !!val : !val) { report.steps.push({ id: step.id, title: step.title, status: "skipped", reason: `when ${step.when}` }); continue; }
        }
        job?.progress?.((i / skill.steps.length), step.title || step.op || step.skill);
        const withArgs = resolveTemplates(step.with || {}, scope);
        try {
          let result;
          if (step.op) {
            const op = OPERATION_INDEX.get(step.op);
            if (!op) throw new AppError("VALIDATION", "err.unknownOperation", { op: step.op });
            for (const s of [op.scope, ...(op.needs || [])]) if (!skill.permissions.includes(s) || !ctx.guard.hasScope(s)) throw new AppError("FORBIDDEN", "err.scopeMissing", { scope: s, op: step.op });
            const opArgs = checkInputs(op.input, { timelineId, ...withArgs }, `${step.id}.with`);
            ctx.guard.checkTarget(op, opArgs);
            result = await op.run(ctx, opArgs);
          } else {
            const dep = (skill.dependsOn || []).find((d) => d.id === step.skill);
            const child = this.registry.get(step.skill);
            if (dep?.version && !satisfies(child.version, dep.version)) throw new AppError("CONFLICT", "err.skillVersion", { id: step.skill, need: dep.version, have: child.version });
            result = await this.run({ skillId: step.skill, timelineId, inputs: withArgs, ctx, job, depth: depth + 1, settings: owned, parentSettings: { ...(parentSettings || {}), ...(skill.settings || {}) } });
          }
          results[step.id] = { result };
          report.steps.push({ id: step.id, title: step.title, status: "done", result });
        } catch (err) {
          if (step.onError === "skip") { report.steps.push({ id: step.id, title: step.title, status: "skipped", error: err?.messageKey || String(err?.message || err) }); results[step.id] = { error: err?.messageKey || "error" }; continue; }
          err.step = err.step || `${skillId}/${step.id}`;
          throw err;
        }
      }
      const end = this.timelineFacts(ctx, timelineId);
      for (const check of skill.success || []) {
        const ok = check === "timeline_not_empty" ? end.facts.durationUs > 0
          : check === "duration_reduced" ? end.facts.durationUs < start.facts.durationUs
          : check === "duration_unchanged" ? Math.abs(end.facts.durationUs - start.facts.durationUs) < 1000
          : check === "has_captions" ? end.timeline.tracks.some((t) => t.segments.some((s) => s.text?.isCaption)) : true;
        if (!ok) throw Object.assign(new AppError("VALIDATION", "err.skillCheckFailed", { check, skillId }), { step: `${skillId}/success` });
      }
      report.after = { durationUs: end.facts.durationUs };
      if (top) {
        ctx.services.timelines.squash(timelineId, start.depth, `skill:${skillId}`);
        const now = ctx.services.timelines.get(timelineId);
        report.after.revision = now.revision;
        report.undoLabel = now.history.undoLabel;
      }
      job?.progress?.(1, "done");
      return report;
    } catch (err) {
      if (top && (skill.rollback || "restore") === "restore") {
        ctx.services.timelines.restore(timelineId, snapshot, start.depth, ctx.source);
        err.details = { ...(err.details || {}), rolledBack: true, failedStep: err.step };
      }
      throw err;
    }
  }
}
