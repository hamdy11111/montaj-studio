"""CLAP (LAION larger_clap_general) for the sound-effects library: audio and text in one embedding space.

  index  --lib DIR --model DIR --ffmpeg EXE [--device cuda|cpu]
         Embeds every sound of DIR/library.json (first 10 s, 48 kHz mono) and measures it (duration, peak, RMS).
         Writes DIR/clap_audio.f32 (N x D float32, L2-normalised, rows in the order of clap_index.json "ids") and
         DIR/clap_index.json. Sounds already embedded (same file size) are reused, so a top-up is quick.
  serve  --model DIR [--device cpu]
         One JSON request per stdin line: {"texts": [...]} -> {"vectors": [[...], ...]} (L2-normalised), one line out.
"""
import argparse, json, os, subprocess, sys, time
import numpy as np

SR = 48000
MAX_S = 10.0


def load_model(model_dir, device):
    import torch
    from transformers import ClapModel, ClapProcessor
    proc = ClapProcessor.from_pretrained(model_dir)
    model = ClapModel.from_pretrained(model_dir).to(device).eval()
    return torch, proc, model


def decode(ffmpeg, path):
    r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf8", "replace")[-300:])
    return np.frombuffer(r.stdout, dtype=np.float32)


def stats(x):
    if not len(x):
        return {"durationS": 0, "peakDb": -120, "rmsDb": -120, "onsetS": 0}
    peak = float(np.max(np.abs(x)))
    # loudest 50 ms window: where the accent of the sound is (a riser peaks at its end, a hit at its start)
    win = int(SR * 0.05)
    n = len(x) // win
    e = (x[: n * win].reshape(n, win) ** 2).mean(axis=1) if n else np.array([float((x ** 2).mean())])
    rms = float(np.sqrt((x ** 2).mean()))
    db = lambda v: round(20 * np.log10(max(v, 1e-6)), 1)
    return {"durationS": round(len(x) / SR, 3), "peakDb": db(peak), "rmsDb": db(rms), "accentS": round(float(np.argmax(e)) * 0.05, 3)}


def norm(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def embed_text(torch, proc, model, device, texts):
    with torch.no_grad():
        t = proc(text=texts, return_tensors="pt", padding=True).to(device)
        f = model.get_text_features(**t)
        f = getattr(f, "pooler_output", f)
    return norm(f.float().cpu().numpy())


def cmd_index(a):
    lib = a.lib
    sounds = json.load(open(os.path.join(lib, "library.json"), encoding="utf8"))["sounds"]
    old_ids, old_vec, old_meta = [], None, {}
    idx_file, vec_file = os.path.join(lib, "clap_index.json"), os.path.join(lib, "clap_audio.f32")
    if os.path.exists(idx_file) and os.path.exists(vec_file):
        old = json.load(open(idx_file, encoding="utf8"))
        old_ids, old_meta = old["ids"], old.get("meta", {})
        old_vec = np.fromfile(vec_file, dtype=np.float32).reshape(len(old_ids), old["dims"])
    old_pos = {k: i for i, k in enumerate(old_ids)}
    torch, proc, model = load_model(a.model, a.device)
    ids, vecs, meta, failed = [], [], {}, []
    batch, t0 = [], time.time()

    def flush():
        if not batch:
            return
        with torch.no_grad():
            inp = proc(audio=[b[1] for b in batch], sampling_rate=SR, return_tensors="pt", padding=True).to(a.device)
            f = model.get_audio_features(**inp)
            f = getattr(f, "pooler_output", f)
        for (sid, _), v in zip(batch, norm(f.float().cpu().numpy())):
            ids.append(sid); vecs.append(v)
        batch.clear()

    for k, s in enumerate(sounds):
        f = os.path.join(lib, s["file"])
        try:
            size = os.path.getsize(f)
        except OSError:
            failed.append([s["id"], "missing"]); continue
        if s["id"] in old_pos and old_meta.get(s["id"], {}).get("size") == size:
            ids.append(s["id"]); vecs.append(old_vec[old_pos[s["id"]]]); meta[s["id"]] = old_meta[s["id"]]
            continue
        try:
            x = decode(a.ffmpeg, f)
        except Exception as e:
            failed.append([s["id"], str(e)[:200]]); continue
        meta[s["id"]] = {**stats(x), "size": size}
        batch.append((s["id"], x[: int(SR * MAX_S)] if len(x) else np.zeros(SR // 10, np.float32)))
        if len(batch) >= 16:
            flush()
            print(json.dumps({"progress": (k + 1) / len(sounds)}), flush=True)
    flush()
    dims = int(vecs[0].shape[0]) if vecs else 512
    np.asarray(vecs, dtype=np.float32).tofile(vec_file + ".tmp")
    os.replace(vec_file + ".tmp", vec_file)
    json.dump({"model": os.path.basename(a.model.rstrip("/\\")), "dims": dims, "ids": ids, "meta": meta, "failed": failed,
               "seconds": round(time.time() - t0, 1), "device": a.device}, open(idx_file + ".tmp", "w", encoding="utf8"))
    os.replace(idx_file + ".tmp", idx_file)
    print(json.dumps({"done": True, "count": len(ids), "failed": len(failed), "seconds": round(time.time() - t0, 1)}), flush=True)


def cmd_serve(a):
    torch, proc, model = load_model(a.model, a.device)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            out = {"vectors": embed_text(torch, proc, model, a.device, req["texts"]).round(6).tolist()}
        except Exception as e:  # report and keep serving
            out = {"error": str(e)[:500]}
        sys.stdout.write(json.dumps(out) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["index", "serve"])
    p.add_argument("--lib"); p.add_argument("--model", required=True); p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--device", default="cpu")
    a = p.parse_args()
    {"index": cmd_index, "serve": cmd_serve}[a.cmd](a)
