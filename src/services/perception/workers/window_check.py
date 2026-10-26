# The hook for checks on short windows (plan item 2: "is this reaction caused by that event?", "is this a laugh or a
# cough?"): a yes/no answer with a confidence and a reason for a ≤ 30 s window, asked of a model that sees (and, for
# Qwen3-Omni, hears) the window itself. Used by phase 6 (cause ↔ reaction) on its candidate pairs, not on whole files.
#
#   qwen3-omni  Qwen3-Omni-30B-A3B-Instruct (ggml-org GGUF; upstream llama.cpp ≥ b8769 takes audio and images):
#               the window's sound (WAV) + keyframes with their times. Implemented; runs once its files exist in
#               runtime/models/perception/qwen3-omni-30b-a3b/ (not downloaded yet — needs a practical test).
#   keye        Keye-VL-2.0-30B-A3B ("the exact moment" specialist): needs Kwai's own llama.cpp fork
#               (github.com/Kwai-Keye/llama.cpp, branch keye-vl-v2-30b-release-video, no prebuilt binaries), so it
#               answers {available: false} until that build exists in runtime/llama-keye/.
#
# job: {media, ffmpeg, llama, modelsDir, engine, checks: [{t0, t1, question}], workDir, frames=4}
# result: {engine, available, reason?, answers: [{t0, t1, question, yes, confidence, reason, ms}]}
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402
import llama  # noqa: E402

ENGINES = {
    "qwen3-omni": {"dir": "qwen3-omni-30b-a3b", "model": "Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf", "mmproj": "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf", "audio": True},
    "keye": {"dir": "keye-vl-2.0-30b-a3b", "model": "Keye-VL-2.0-30B-A3B-Q4_K_M.gguf", "mmproj": "mmproj-Keye-VL-2.0-30B-A3B-Q8_0.gguf", "audio": False, "server": os.path.join("llama-keye", "llama-server.exe")},
}
SCHEMA = {"type": "object", "properties": {"yes": {"type": "boolean"}, "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "reason": {"type": "string"}},
          "required": ["yes", "confidence", "reason"]}


def main():
    job, out = pc.args()
    eng = ENGINES.get(job.get("engine", "qwen3-omni"))
    if eng is None:
        raise SystemExit(f"unknown engine {job.get('engine')}")
    md = os.path.join(pc.models_dir(job), eng["dir"])
    exe = os.path.join(os.path.dirname(os.path.dirname(pc.models_dir(job))), eng["server"]) if eng.get("server") else job["llama"]
    missing = [p for p in (os.path.join(md, eng["model"]), os.path.join(md, eng["mmproj"]), exe) if not os.path.isfile(p)]
    if missing:
        pc.write(out, {"engine": job.get("engine"), "available": False, "reason": "not installed: " + ", ".join(missing), "answers": []})
        return
    work = job["workDir"]
    os.makedirs(work, exist_ok=True)
    nf = int(job.get("frames", 4))
    answers = []
    with llama.Server(exe, os.path.join(md, eng["model"]), os.path.join(md, eng["mmproj"]), ctx=16384, log_path=os.path.join(work, "server.log")) as srv:
        srv.wait()
        for i, c in enumerate(job["checks"]):
            t0, t1 = float(c["t0"]), min(float(c["t1"]), float(c["t0"]) + 30)
            content = [{"type": "text", "text": f"Window {t0:.1f}–{t1:.1f} s. Question: {c['question']}"}]
            if eng["audio"]:
                wav = os.path.join(work, f"w{i:04d}.wav")
                subprocess.run([job["ffmpeg"], "-hide_banner", "-v", "error", "-y", "-ss", str(t0), "-t", str(t1 - t0), "-i", job["media"], "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
                content.append({"type": "text", "text": "The window's sound:"})
                content.append(llama.audio_part(wav))
            for k in range(nf):
                t = t0 + (t1 - t0) * (k + 0.5) / nf
                f = llama.keyframe(job["ffmpeg"], job["media"], t, os.path.join(work, f"w{i:04d}_{k}.jpg"), 512)
                content += [{"type": "text", "text": f"Frame at t = {t:.2f} s:"}, llama.image_part(f)]
            ts = time.perf_counter()
            text, _, _ = srv.chat([{"role": "system", "content": "Answer the editor's question about this window of an Egyptian Arabic video with the JSON form only. Be strict: yes only when the window clearly shows it."},
                                   {"role": "user", "content": content}], schema=SCHEMA, max_tokens=300, temperature=0.2)
            a = llama.parse_json(text)
            answers.append({"t0": t0, "t1": t1, "question": c["question"], **a, "ms": round((time.perf_counter() - ts) * 1000)})
            pc.progress((i + 1) / len(job["checks"]))
    pc.write(out, {"engine": job.get("engine"), "available": True, "answers": answers})


if __name__ == "__main__":
    main()
