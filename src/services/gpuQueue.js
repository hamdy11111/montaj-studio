// One heavy GPU job at a time across the app's studios (music, video generation, video enhancement): a job takes its
// turn in order, waits while a video export runs, and before it starts the other studios' engines give their models'
// memory back (their processes stay up). A waiting job can be cancelled; nothing is started for it until its turn.
export class GpuQueue {
  constructor({ exporter = null } = {}) {
    this.exporter = exporter;
    this.engines = new Map(); // owner → ComfyEngine
    this.holder = null;       // { owner, id }
    this.waiting = [];        // [{ owner, id, resolve, reject, onWait }]
    this.timer = null;
  }

  register(owner, engine) { this.engines.set(owner, engine); }

  /** Who holds the GPU and who waits (for the progress panels). */
  state() { return { holder: this.holder, waiting: this.waiting.map(({ owner, id }) => ({ owner, id })) }; }

  /**
   * Wait for this job's turn. `onWait(reason)` is told why it waits ("queue" behind another job, "export").
   * Resolves with a release function; call it when the job ends (done, failed or cancelled).
   */
  acquire(owner, id, { onWait = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ owner, id, resolve, reject, onWait });
      this.pump();
    });
  }

  /** A waiting job that is no longer wanted leaves the queue. */
  cancel(id) {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    const [w] = this.waiting.splice(i, 1);
    w.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    this.pump();
    return true;
  }

  pump() {
    clearTimeout(this.timer);
    if (!this.waiting.length) return;
    const next = this.waiting[0];
    if (this.holder) { for (const w of this.waiting) w.onWait("queue"); return; }
    if (this.exporter?.busy?.()) {
      for (const w of this.waiting) w.onWait("export");
      this.timer = setTimeout(() => this.pump(), 1500);
      return;
    }
    this.waiting.shift();
    this.holder = { owner: next.owner, id: next.id };
    // The other studios' engines free their models so this job has the GPU's memory.
    Promise.all([...this.engines].filter(([o, e]) => o !== next.owner && e.running).map(([, e]) => e.release())).finally(() => {
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        if (this.holder?.id === next.id) this.holder = null;
        this.pump();
      });
    });
  }
}
