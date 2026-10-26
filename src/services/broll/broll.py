"""B-roll index of the user's own footage: shots -> keyframes -> embeddings in several indexes, and the query side.

  shots  --video V --out DIR --key K --ffmpeg F [--max-shot 6] [--min-shot 1.2]
         Decodes the video once (4 fps, 384 px short side, auto-rotated: a portrait video stays portrait), finds the cuts
         (colour-histogram jumps above an adaptive threshold), splits long takes into pieces of at most --max-shot s and
         writes 4 keyframes per shot (DIR/frames/K/<n>_<k>.jpg). Prints {"shots": [{startS, endS, frames}]}.
  embed  --index DIR --models DIR --what siglip2,metaclip2,qwen3vl,bge [--device cuda]
         Embeds the shots of DIR/shots.json that a model has not seen yet, one model at a time (each is freed before the
         next): SigLIP2 and MetaCLIP 2 per keyframe, Qwen3-VL-Embedding per shot (its 4 keyframes as a video), bge-m3 per
         shot caption (English caption + Arabic keywords). DIR/emb_<model>.f32 (+ .json: the row -> shot map).
  serve  --index DIR --models DIR [--device cuda]
         {"op": "search", "en": [...], "ar": [...], "k": 100}  -> {"lists": {model: [[shot, score], ...]}}
             SigLIP2 gets the English texts; MetaCLIP 2, Qwen3-VL and bge-m3 get the English and the Arabic ones; a
             shot's score is its best keyframe/text pair.
         {"op": "rerank", "query": "...", "shots": [ids], "frames": 2} -> {"scores": [...]}   (Qwen3-VL-Reranker)
         {"op": "reload"} re-reads the index files.
"""
import argparse, gc, io, json, os, subprocess, sys, time
import numpy as np

REPOS = {
    "siglip2": "google__siglip2-so400m-patch16-naflex",
    "metaclip2": "facebook__metaclip-2-worldwide-huge-quickgelu",
    "qwen3vl": "Qwen__Qwen3-VL-Embedding-2B",
    "bge": "BAAI__bge-m3",
    "reranker": "Qwen__Qwen3-VL-Reranker-2B",
}
FRAME_MODELS = ("siglip2", "metaclip2")
QWEN_INSTRUCT = "Retrieve video shots that match the description."


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n"); sys.stdout.flush()


def norm(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def feat(x):
    """transformers 5 returns an output object from get_*_features; older versions a tensor."""
    return getattr(x, "pooler_output", None) if not hasattr(x, "float") else x


# ---------------------------------------------------------------- shots

def probe(ffprobe, video):
    """(width, height, duration) as displayed: a 90/270 degree display rotation swaps the sides (FFmpeg auto-rotates
    when decoding). -show_streams works on every ffprobe version (old ones lack the stream_side_data section)."""
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", video],
                       capture_output=True, text=True, encoding="utf8")
    d = json.loads(r.stdout or "{}")
    if not d.get("streams"):
        raise SystemExit(f"ffprobe found no video stream: {r.stderr[-300:]}")
    st = d["streams"][0]
    w, h = st.get("width", 16), st.get("height", 9)
    rot = next((abs(int(float(sd["rotation"]))) for sd in st.get("side_data_list", []) or [] if sd.get("rotation")), 0)
    rot = rot or abs(int((st.get("tags") or {}).get("rotate", 0) or 0))
    if rot % 180 == 90:
        w, h = h, w
    return w, h, float(d.get("format", {}).get("duration", 0) or 0)


def cmd_shots(a):
    from PIL import Image
    W0, H0, dur = probe(a.ffprobe, a.video)
    short = 384
    if W0 >= H0:
        H = short; W = int(round(W0 * short / H0 / 2) * 2)
    else:
        W = short; H = int(round(H0 * short / W0 / 2) * 2)
    fps = 4.0
    cmd = [a.ffmpeg, "-hide_banner", "-loglevel", "error", "-threads", "0", "-i", a.video, "-an", "-vf", f"fps={fps},scale={W}:{H}:flags=bilinear",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    size = W * H * 3
    frames, hists = [], []
    t0 = time.time()
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        f = np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3)
        small = f[::4, ::4]
        q = (small // 32).reshape(-1, 3).astype(np.int32)
        hist = np.bincount(q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2], minlength=512).astype(np.float32)
        hists.append(hist / hist.sum())
        # kept JPEG-encoded until the cuts are known (an hour at 4 fps is ~0.5 GB this way, ~11 GB raw)
        b = io.BytesIO(); Image.fromarray(f).save(b, format="JPEG", quality=88); frames.append(b.getvalue())
        if len(frames) % 200 == 0:
            emit({"progress": min(0.95, len(frames) / max(1, dur * fps)), "step": "decode"})
    p.wait()
    n = len(frames)
    if n == 0:
        raise SystemExit("no frames decoded: " + p.stderr.read().decode("utf8", "replace")[-400:])
    d = np.array([0.0] + [float(np.abs(hists[i] - hists[i - 1]).sum()) for i in range(1, n)])
    # adaptive threshold: a jump well above the local level of motion, and above an absolute floor
    cuts = [0]
    for i in range(1, n):
        lo, hi = max(1, i - 8), min(n, i + 8)
        local = np.median(d[lo:hi])
        if d[i] > max(0.45, local * 3 + 0.15) and (i - cuts[-1]) / fps >= a.min_shot:
            cuts.append(i)
    cuts.append(n)
    shots = []
    for s, e in zip(cuts[:-1], cuts[1:]):
        length = (e - s) / fps
        pieces = max(1, int(np.ceil(length / a.max_shot)))
        for k in range(pieces):
            ps, pe = s + (e - s) * k // pieces, s + (e - s) * (k + 1) // pieces
            if pe - ps >= 1:
                shots.append((ps, pe))
    out_dir = os.path.join(a.out, "frames", a.key)
    os.makedirs(out_dir, exist_ok=True)
    res = []
    for j, (s, e) in enumerate(shots):
        names = []
        for k, frac in enumerate((0.125, 0.375, 0.625, 0.875)):
            i = min(n - 1, s + int((e - s) * frac))
            rel = f"frames/{a.key}/{j:04d}_{k}.jpg"
            with open(os.path.join(a.out, rel), "wb") as fh:
                fh.write(frames[i])
            names.append(rel)
        # motion of the shot (mean histogram change): a static shot vs. a moving one
        motion = float(d[s + 1:e].mean()) if e - s > 1 else 0.0
        res.append({"startS": round(s / fps, 3), "endS": round(min(dur or e / fps, e / fps), 3), "frames": names, "motion": round(motion, 4)})
    emit({"shots": res, "width": W0, "height": H0, "durationS": dur, "decodeS": round(time.time() - t0, 1), "cuts": len(cuts) - 2})


# ---------------------------------------------------------------- models

def load(name, models, device):
    import torch
    path = os.path.join(models, REPOS[name])
    dtype = torch.float16 if device == "cuda" else torch.float32
    if name in FRAME_MODELS:
        from transformers import AutoModel, AutoProcessor
        m = AutoModel.from_pretrained(path, dtype=dtype).to(device).eval()
        return {"model": m, "proc": AutoProcessor.from_pretrained(path), "dtype": dtype}
    if name == "bge":
        from transformers import AutoModel, AutoTokenizer
        m = AutoModel.from_pretrained(path, dtype=dtype).to(device).eval()
        return {"model": m, "tok": AutoTokenizer.from_pretrained(path), "dtype": dtype}
    sys.path.insert(0, path)
    if name == "qwen3vl":
        from scripts.qwen3_vl_embedding import Qwen3VLEmbedder
        e = Qwen3VLEmbedder(model_name_or_path=path, dtype=torch.bfloat16, max_pixels=384 * 384, total_pixels=4 * 384 * 384)
        sys.path.remove(path); sys.modules.pop("scripts", None); sys.modules.pop("scripts.qwen3_vl_embedding", None)
        return {"emb": e}
    if name == "reranker":
        from scripts.qwen3_vl_reranker import Qwen3VLReranker
        r = Qwen3VLReranker(model_name_or_path=path, dtype=torch.bfloat16, max_pixels=448 * 448, total_pixels=4 * 448 * 448)
        sys.path.remove(path); sys.modules.pop("scripts", None); sys.modules.pop("scripts.qwen3_vl_reranker", None)
        return {"rr": r}
    raise ValueError(name)


def free(m):
    import torch
    m.clear(); gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def images_embed(M, name, files, device, bs=16):
    import torch
    from PIL import Image
    out = []
    for i in range(0, len(files), bs):
        ims = [Image.open(f).convert("RGB") for f in files[i:i + bs]]
        with torch.no_grad():
            inp = M["proc"](images=ims, return_tensors="pt").to(device)
            if "pixel_values" in inp:
                inp["pixel_values"] = inp["pixel_values"].to(M["dtype"])
            f = feat(M["model"].get_image_features(**inp))
        out.append(norm(f.float().cpu().numpy()))
    return np.concatenate(out) if out else np.zeros((0, 1), np.float32)


def texts_embed(M, name, texts, device):
    import torch
    with torch.no_grad():
        if name == "siglip2":
            inp = M["proc"](text=[t.lower() for t in texts], padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(device)
            f = feat(M["model"].get_text_features(**inp))
        elif name == "metaclip2":
            inp = M["proc"](text=texts, padding=True, truncation=True, return_tensors="pt").to(device)
            f = feat(M["model"].get_text_features(**inp))
        elif name == "bge":
            inp = M["tok"](texts, padding=True, truncation=True, max_length=512, return_tensors="pt").to(device)
            f = M["model"](**inp).last_hidden_state[:, 0]
        elif name == "qwen3vl":
            f = M["emb"].process([{"text": t, "instruction": QWEN_INSTRUCT} for t in texts])
        else:
            raise ValueError(name)
    return norm(f.float().cpu().numpy())


def caption_text(s):
    c = s.get("caption") or {}
    kw = c.get("keywordsAr") or []
    kwe = c.get("keywordsEn") or []
    return " ".join([c.get("en", ""), c.get("ar", ""), " ".join(kwe), " ".join(kw)]).strip()


def read_index(d):
    return json.load(open(os.path.join(d, "shots.json"), encoding="utf8"))


def read_emb(d, name):
    j = os.path.join(d, f"emb_{name}.json")
    if not os.path.exists(j):
        return None, None
    meta = json.load(open(j, encoding="utf8"))
    mat = np.fromfile(os.path.join(d, f"emb_{name}.f32"), dtype=np.float32).reshape(len(meta["rows"]), meta["dims"]) if meta["rows"] else np.zeros((0, meta["dims"]), np.float32)
    return meta, mat


def write_emb(d, name, rows, mat):
    mat = np.asarray(mat, dtype=np.float32)
    mat.tofile(os.path.join(d, f"emb_{name}.f32.tmp"))
    os.replace(os.path.join(d, f"emb_{name}.f32.tmp"), os.path.join(d, f"emb_{name}.f32"))
    json.dump({"rows": rows, "dims": int(mat.shape[1]) if mat.ndim == 2 and mat.shape[0] else 0}, open(os.path.join(d, f"emb_{name}.json"), "w", encoding="utf8"))


def cmd_embed(a):
    import torch
    idx = read_index(a.index)
    shots = {s["id"]: s for s in idx["shots"]}
    report = {}
    for name in a.what.split(","):
        t0 = time.time()
        meta, mat = read_emb(a.index, name)
        rows = meta["rows"] if meta else []
        keep = [i for i, r in enumerate(rows) if r[0] in shots]  # rows of shots that were removed go away
        rows = [rows[i] for i in keep]
        mat = mat[keep] if mat is not None and len(keep) else None
        seen = {r[0] for r in rows}
        todo = [s for s in idx["shots"] if s["id"] not in seen and (name != "bge" or s.get("caption"))]
        if not todo:
            report[name] = {"new": 0}; continue
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        M = load(name, a.models, a.device)
        new_rows, new_vecs = [], []
        if name in FRAME_MODELS:
            files = [(s["id"], k, os.path.join(a.index, f)) for s in todo for k, f in enumerate(s["frames"])]
            for i in range(0, len(files), 64):
                part = files[i:i + 64]
                new_vecs.append(images_embed(M, name, [f for _, _, f in part], a.device))
                new_rows += [[sid, k] for sid, k, _ in part]
                emit({"progress": (i + len(part)) / len(files), "model": name})
        elif name == "qwen3vl":
            for i, s in enumerate(todo):
                v = M["emb"].process([{"video": [os.path.join(a.index, f) for f in s["frames"]], "instruction": "Represent the video shot."}])
                new_vecs.append(norm(v.float().cpu().numpy())); new_rows.append([s["id"], -1])
                if i % 10 == 0:
                    emit({"progress": (i + 1) / len(todo), "model": name})
        elif name == "bge":
            for i in range(0, len(todo), 32):
                part = todo[i:i + 32]
                new_vecs.append(texts_embed(M, name, [caption_text(s) for s in part], a.device)); new_rows += [[s["id"], -1] for s in part]
        vec = np.concatenate(new_vecs)
        mat = vec if mat is None else np.concatenate([mat, vec])
        write_emb(a.index, name, rows + new_rows, mat)
        peak = torch.cuda.max_memory_allocated() / 2 ** 30 if torch.cuda.is_available() else 0
        report[name] = {"new": len(todo), "rows": len(new_rows), "seconds": round(time.time() - t0, 1), "peakGB": round(peak, 2)}
        free(M)
    emit({"done": True, "report": report})


def cmd_serve(a):
    loaded, embs = {}, {}

    def reload():
        embs.clear()
        for name in ("siglip2", "metaclip2", "qwen3vl", "bge"):
            meta, mat = read_emb(a.index, name)
            if meta and meta["rows"]:
                embs[name] = (meta["rows"], mat)

    def model(name):
        if name not in loaded:
            loaded[name] = load(name, a.models, a.device)
        return loaded[name]

    reload()
    emit({"ready": True, "indexes": {k: len(v[0]) for k, v in embs.items()}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req["op"] == "reload":
                reload(); emit({"indexes": {k: len(v[0]) for k, v in embs.items()}}); continue
            if req["op"] == "search":
                lists = {}
                for name, (rows, mat) in embs.items():
                    texts = list(req.get("en", [])) + ([] if name == "siglip2" else list(req.get("ar", [])))
                    if not texts:
                        continue
                    q = texts_embed(model(name), name, texts, a.device)
                    sims = (mat @ q.T).max(axis=1)
                    best = {}
                    for (sid, _), v in zip(rows, sims):
                        if v > best.get(sid, -9):
                            best[sid] = float(v)
                    lists[name] = sorted(best.items(), key=lambda x: -x[1])[: int(req.get("k", 100))]
                emit({"lists": lists}); continue
            if req["op"] == "rerank":
                idx = {s["id"]: s for s in read_index(a.index)["shots"]}
                rr = model("reranker")["rr"]
                nf = int(req.get("frames", 2))
                docs = []
                for sid in req["shots"]:
                    s = idx[sid]
                    fr = [os.path.join(a.index, f) for f in s["frames"]]
                    pick = fr[1:3] if nf == 2 else fr
                    d = {"video": pick} if len(pick) > 1 else {"image": pick[0]}
                    if s.get("caption", {}).get("en"):
                        d["text"] = s["caption"]["en"]
                    docs.append(d)
                scores = rr.process({"instruction": "Given a description of a shot, judge whether the video shot shows it.", "query": {"text": req["query"]}, "documents": docs})
                emit({"scores": [float(x) for x in scores]}); continue
            emit({"error": f"unknown op {req.get('op')}"})
        except Exception as e:
            import traceback
            emit({"error": (str(e) + " " + traceback.format_exc()[-800:])[:1200]})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["shots", "embed", "serve"])
    p.add_argument("--video"); p.add_argument("--out"); p.add_argument("--key"); p.add_argument("--ffmpeg", default="ffmpeg"); p.add_argument("--ffprobe", default="ffprobe")
    p.add_argument("--max-shot", dest="max_shot", type=float, default=6.0); p.add_argument("--min-shot", dest="min_shot", type=float, default=1.2)
    p.add_argument("--index"); p.add_argument("--models"); p.add_argument("--what", default="siglip2,metaclip2,qwen3vl,bge")
    p.add_argument("--device", default="cuda")
    a = p.parse_args()
    {"shots": cmd_shots, "embed": cmd_embed, "serve": cmd_serve}[a.cmd](a)
