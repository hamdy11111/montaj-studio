// Screen recording and voiceover (FEAT-014, FEAT-057): MediaRecorder in the renderer, saved and imported by the
// main process (record.save). Screen capture uses the main-process display-media handler (primary screen +
// system audio loopback); the voiceover records the default microphone and lands at the playhead.
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { call, guard } from "../api.js";
import { modal } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { formatDuration } from "../../core/util.js";

export async function record(ed, kind /* "screen" | "voice" */) {
  let stream;
  try {
    stream = kind === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
      : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    toast(`${t("ed.record")}: ${err.message}`, "error");
    return;
  }
  const mime = kind === "screen" ? (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm") : "audio/webm;codecs=opus";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const startAt = ed.playhead();
  const started = performance.now();
  const timeEl = h("strong", { class: "ltr" }, "00:00");
  const level = h("div", { class: "progress" }, h("div"));
  let raf, meter;
  if (kind === "voice") {
    const ac = new AudioContext();
    const an = ac.createAnalyser(); an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    meter = () => { an.getByteTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v - 128)); level.firstChild.style.width = `${Math.min(100, (pk / 128) * 140)}%`; raf = requestAnimationFrame(meter); };
    meter();
    rec.addEventListener("stop", () => ac.close().catch(() => {}));
  }
  const timer = setInterval(() => { timeEl.textContent = formatDuration((performance.now() - started) * 1000); }, 250);
  if (kind === "voice") ed.player.play(); // record against the playing timeline (voiceover)
  rec.start(500);
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  const stop = h("button", { class: "btn danger" }, icon("record"), t("ed.stopRecording"));
  const m = modal({ title: kind === "screen" ? t("ed.recordScreen") : t("ed.recordVoice"), width: 360, closable: false,
    body: h("div", { class: "col" }, h("div", { class: "row" }, h("span", { class: "rec-dot" }), t("rec.recording", { t: "" }), timeEl), kind === "voice" ? level : null), footer: [stop] });
  stream.getVideoTracks()[0]?.addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
  stop.onclick = () => { if (rec.state !== "inactive") rec.stop(); };
  await done;
  clearInterval(timer); cancelAnimationFrame(raf);
  stream.getTracks().forEach((tr) => tr.stop());
  if (kind === "voice") ed.player.pause();
  m.close(true);
  const blob = new Blob(chunks, { type: mime });
  if (!blob.size) { toast(t("err.recordingEmpty"), "error"); return; }
  const tst = toast(t("c.loading"), "info", { ms: 60_000 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const media = await guard(() => call("record.save", ed.project().id, bytes, "webm"));
  tst.remove();
  if (!media) return;
  await ed.refreshMedia();
  if (kind === "voice") await ed.exec("addMedia", { mediaId: media.id, toMain: false, atUs: startAt });
  toast(t("rec.saved"), "success");
}
