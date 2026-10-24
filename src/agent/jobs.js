// Long-running agent jobs (skill runs, exports): one id, status, progress, result or error, cancel. A job is only
// visible to the client that started it.
import { uid } from "../core/util.js";
import { AppError, toErrorEnvelope } from "../core/validation.js";

export class JobManager {
  constructor({ limit = 200, onChange = () => {} } = {}) {
    this.jobs = new Map();
    this.limit = limit;
    this.onChange = onChange;
  }

  start({ kind, clientId, label, run }) {
    const job = { id: uid(), kind, clientId, label, status: "running", progress: 0, step: "", createdAt: new Date().toISOString(), result: null, error: null, cancelled: false, waiters: [] };
    job.progressFn = (p, step) => { job.progress = Math.max(0, Math.min(1, p)); if (step) job.step = step; this.onChange(this.view(job)); };
    this.jobs.set(job.id, job);
    this.trim();
    Promise.resolve()
      .then(() => run({ progress: job.progressFn, get cancelled() { return job.cancelled; } }))
      .then((result) => this.finish(job, "done", result, null))
      .catch((err) => this.finish(job, job.cancelled ? "cancelled" : "failed", null, toErrorEnvelope(err)));
    return this.view(job);
  }

  finish(job, status, result, error) {
    job.status = status; job.result = result; job.error = error; job.finishedAt = new Date().toISOString();
    if (status === "done") job.progress = 1;
    for (const w of job.waiters.splice(0)) w();
    this.onChange(this.view(job));
  }

  /** Exports run in ExportService; their events feed a mirror job here. */
  trackExport(jobId, { clientId, path }) {
    const job = { id: jobId, kind: "export", clientId, label: path, status: "running", progress: 0, step: "", createdAt: new Date().toISOString(), result: null, error: null, cancelled: false, waiters: [] };
    this.jobs.set(jobId, job);
    this.trim();
  }

  onExportEvent(event, p) {
    const job = p?.jobId && this.jobs.get(p.jobId);
    if (!job) return;
    if (event === "export:progress") { job.progress = p.progress; this.onChange(this.view(job)); }
    else if (event === "export:done") this.finish(job, "done", { path: p.path, sizeBytes: p.sizeBytes }, null);
    else if (event === "export:error") this.finish(job, p.cancelled ? "cancelled" : "failed", null, p.error || { code: "MEDIA", messageKey: "err.exportFailed" });
  }

  get(id, clientId) {
    const job = this.jobs.get(id);
    if (!job || (clientId !== undefined && job.clientId !== clientId)) throw new AppError("NOT_FOUND", "err.jobNotFound", { jobId: id });
    return job;
  }

  status(id, clientId) { return this.view(this.get(id, clientId)); }

  cancel(id, clientId) {
    const job = this.get(id, clientId);
    if (job.status === "running") job.cancelled = true;
    return this.view(job);
  }

  /** Wait until the job ends or `ms` passes; returns its view either way. */
  async wait(id, ms, clientId) {
    const job = this.get(id, clientId);
    if (job.status === "running") await new Promise((resolve) => { const t = setTimeout(resolve, ms); job.waiters.push(() => { clearTimeout(t); resolve(); }); });
    return this.view(job);
  }

  list(clientId) { return [...this.jobs.values()].filter((j) => clientId === undefined || j.clientId === clientId).map((j) => this.view(j)); }

  view(j) { return { jobId: j.id, kind: j.kind, label: j.label, status: j.status, progress: Math.round(j.progress * 1000) / 1000, step: j.step, createdAt: j.createdAt, finishedAt: j.finishedAt, result: j.result, error: j.error }; }

  trim() {
    if (this.jobs.size <= this.limit) return;
    for (const [id, j] of this.jobs) { if (this.jobs.size <= this.limit) break; if (j.status !== "running") this.jobs.delete(id); }
  }
}
