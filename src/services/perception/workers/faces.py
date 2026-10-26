# Faces on screen: detection + landmarks (SCRFD-10G), identity embeddings (ArcFace R50 / WebFace600K) — both from
# InsightFace's buffalo_l pack, run with onnxruntime (CUDA when present) — then frame-to-frame tracks and identity
# clusters over the whole file. AdaFace (IR-101, WebFace12M) adds a second embedding for tracks shot in poor light or
# blurred, where it holds up better; two tracks are compared with AdaFace when either is poor, with ArcFace otherwise.
#
# The video is decoded once at 25 fps with the long side at 960 px (read in place, nothing written but the cache).
# For active-speaker detection every track keeps its per-frame mouth-area crop (112×112 gray, the LR-ASD recipe),
# saved next to the result as tracks/<id>.npy.
#
# job: {media, ffmpeg, modelsDir, workDir, fps=25, longSide=960, shotCuts: [t…], minTrackS=0.4, detThresh=0.5}
# result: {model, device, fps, size: [w, h], tracks: [{id, t0, t1, frames, identity, quality, poor, crop,
#          boxes: [[t, x, y, w, h, score]…] (normalised, every frame)}], identities: [{id, tracks, seconds, poor}]}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcommon as pc  # noqa: E402

ARC_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]
EMBED_EVERY = 5          # frames between two identity embeddings of a track
MAX_GAP = 10             # frames a track may miss (blink, turn, hand) before it ends
IOU_MATCH = 0.3
CROP_SCALE = 0.40        # LR-ASD / TalkNet crop: the box widened so the mouth and chin are in
SAME_ARC, SAME_ADA = 0.42, 0.40   # cosine similarity above which two tracks are one person


def session(path, dev):
    import onnxruntime as ort
    prov = (["CUDAExecutionProvider"] if dev == "cuda" else []) + ["CPUExecutionProvider"]
    so = ort.SessionOptions()
    so.log_severity_level = 3
    return ort.InferenceSession(path, so, providers=prov)


class SCRFD:
    def __init__(self, path, dev, size=640):
        self.s = session(path, dev)
        self.inp = self.s.get_inputs()[0].name
        self.size = size

    def __call__(self, img, thresh=0.5, nms=0.4):
        import cv2
        import numpy as np
        h, w = img.shape[:2]
        scale = self.size / max(h, w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        canvas = np.zeros((self.size, self.size, 3), np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (self.size, self.size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.s.run(None, {self.inp: blob})
        boxes, kpss, scores = [], [], []
        for i, stride in enumerate((8, 16, 32)):
            sc = outs[i].reshape(-1)
            bb = outs[i + 3].reshape(-1, 4) * stride
            kp = outs[i + 6].reshape(-1, 10) * stride
            g = self.size // stride
            cy, cx = np.mgrid[:g, :g]
            centers = np.repeat(np.stack([cx, cy], -1).reshape(-1, 2) * stride, 2, axis=0).astype(np.float32)
            keep = np.where(sc >= thresh)[0]
            if not len(keep):
                continue
            c = centers[keep]
            b = bb[keep]
            boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], -1))
            k = kp[keep].reshape(-1, 5, 2) + c[:, None, :]
            kpss.append(k)
            scores.append(sc[keep])
        if not boxes:
            return np.zeros((0, 4)), np.zeros((0, 5, 2)), np.zeros(0)
        boxes, kpss, scores = np.concatenate(boxes) / scale, np.concatenate(kpss) / scale, np.concatenate(scores)
        idx = cv2.dnn.NMSBoxes([[float(x1), float(y1), float(x2 - x1), float(y2 - y1)] for x1, y1, x2, y2 in boxes], scores.tolist(), thresh, nms)
        idx = np.array(idx).reshape(-1)
        return boxes[idx], kpss[idx], scores[idx]


class Embedder:
    """ArcFace ((x−127.5)/127.5) or AdaFace — the CVLFace export — ((x/255−0.5)/0.5), both RGB: 112×112 aligned BGR
    crops → unit vectors."""

    def __init__(self, path, dev, kind):
        self.s = session(path, dev)
        self.inp = self.s.get_inputs()[0].name
        self.kind = kind

    def __call__(self, crops):
        import numpy as np
        if not crops:
            return np.zeros((0, 512), np.float32)
        x = np.stack(crops).astype(np.float32)
        if self.kind == "arcface":
            x = (x[..., ::-1] - 127.5) / 127.5
        else:
            x = (x[..., ::-1] / 255.0 - 0.5) / 0.5
        x = np.ascontiguousarray(x.transpose(0, 3, 1, 2))
        out = []
        for i in range(0, len(x), 32):
            y = self.s.run(None, {self.inp: x[i:i + 32]})[0]
            out.append(y.reshape(len(y), -1))
        y = np.concatenate(out)
        return y / np.maximum(1e-6, np.linalg.norm(y, axis=1, keepdims=True))


def aligned(img, kps):
    import cv2
    import numpy as np
    M, _ = cv2.estimateAffinePartial2D(np.asarray(kps, np.float32), np.asarray(ARC_DST, np.float32), method=cv2.LMEDS)
    return cv2.warpAffine(img, M, (112, 112), borderValue=0.0)


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / max(1e-6, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def quality(img, box):
    """(sharpness, brightness) of the face area: variance of the Laplacian and mean luma."""
    import cv2
    x1, y1, x2, y2 = (int(max(0, v)) for v in box)
    f = img[y1:max(y1 + 2, y2), x1:max(x1 + 2, x2)]
    if f.size == 0:
        return 0.0, 0.0
    g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (64, 64))
    return float(cv2.Laplacian(g, cv2.CV_64F).var()), float(g.mean())


def crop_at(window, origin, s, cx, cy):
    """LR-ASD's crop of one frame: the (smoothed) box half-size s and centre, widened by CROP_SCALE, 224×224 gray,
    centre 112×112 kept. `window` is the gray area kept around the face, `origin` its top-left in the frame."""
    import cv2
    import numpy as np
    bsi = int(s * (1 + 2 * CROP_SCALE))
    pad = np.pad(window, ((bsi, bsi), (bsi, bsi)), "constant", constant_values=110)
    my, mx = cy - origin[1] + bsi, cx - origin[0] + bsi
    face = pad[max(0, int(my - s)):int(my + s * (1 + 2 * CROP_SCALE)), max(0, int(mx - s * (1 + CROP_SCALE))):int(mx + s * (1 + CROP_SCALE))]
    if face.size == 0:
        return np.full((112, 112), 110, np.uint8)
    return cv2.resize(face, (224, 224))[56:168, 56:168]


def flush(tr, final=False):
    """Crop the track's frames whose 13-frame median (6 before, 6 after) is known; at the end, all of them."""
    import numpy as np
    while tr["pending"] and (final or len(tr["crops"]) < len(tr["boxes"]) - 6):
        k = len(tr["crops"])
        b = np.asarray(tr["boxes"][max(0, k - 6):k + 7], np.float32)
        s = float(np.median(np.maximum(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]) / 2))
        cx, cy = float(np.median((b[:, 0] + b[:, 2]) / 2)), float(np.median((b[:, 1] + b[:, 3]) / 2))
        window, origin = tr["pending"].popleft()
        tr["crops"].append(crop_at(window, origin, s, cx, cy))


def main():
    job, out = pc.args()
    T = pc.Timer()
    import cv2
    import numpy as np
    dev = pc.device(job)
    md = pc.models_dir(job)
    det = SCRFD(os.path.join(md, "buffalo_l", "det_10g.onnx"), dev)
    arc = Embedder(os.path.join(md, "buffalo_l", "w600k_r50.onnx"), dev, "arcface")
    ada_path = os.path.join(md, "adaface", "adaface_ir101_webface12m.onnx")
    ada = Embedder(ada_path, dev, "adaface") if os.path.isfile(ada_path) else None
    T.mark("load")
    fps = float(job.get("fps", 25))
    cuts = sorted(float(t) for t in job.get("shotCuts", []))
    thresh = float(job.get("detThresh", 0.5))
    dur = float(job.get("duration") or 0)
    work = job["workDir"]
    os.makedirs(os.path.join(work, "tracks"), exist_ok=True)

    from collections import deque
    tracks, active = [], []   # track: {id, frames, boxes, scores, last, emb (aligned crops), q, pending, crops}
    size = None
    next_cut = 0
    for i, t, img in pc.video_frames(job["ffmpeg"], job["media"], fps, int(job.get("longSide", 960))):
        if size is None:
            size = (img.shape[1], img.shape[0])
        # A shot cut ends every track: the same box after a cut is another picture.
        while next_cut < len(cuts) and cuts[next_cut] <= t:
            next_cut += 1
            active = []
        boxes, kpss, scores = det(img, thresh)
        keep = [(b, k, s) for b, k, s in zip(boxes, kpss, scores) if min(b[2] - b[0], b[3] - b[1]) >= 20]
        active = [tr for tr in active if i - tr["last"] <= MAX_GAP]
        pairs = sorted(((iou(tr["boxes"][-1], b), ti, di) for ti, tr in enumerate(active) for di, (b, _, _) in enumerate(keep)), reverse=True)
        used_t, used_d, match = set(), set(), {}
        for v, ti, di in pairs:
            if v < IOU_MATCH or ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            match[di] = active[ti]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        for di, (b, k, s) in enumerate(keep):
            tr = match.get(di)
            if tr is None:
                tr = {"id": f"T{len(tracks) + 1}", "frames": [], "boxes": [], "scores": [], "last": i, "emb": [], "q": [],
                      "pending": deque(), "crops": []}
                tracks.append(tr)
                active.append(tr)
            # Only a window around the face is kept for the mouth crop (whole frames would not fit in memory); the
            # crop itself waits until the 6 next boxes are known (13-frame median smoothing, the LR-ASD recipe).
            x1, y1, x2, y2 = b
            r = max(x2 - x1, y2 - y1) * 1.6
            ox, oy = int(max(0, (x1 + x2) / 2 - r)), int(max(0, (y1 + y2) / 2 - r))
            win = (gray[oy:int((y1 + y2) / 2 + r), ox:int((x1 + x2) / 2 + r)].copy(), (ox, oy))
            # Frames the detector missed inside a track: the box is carried (ASD needs a crop for every frame).
            gap = i - tr["last"] - 1 if tr["frames"] else 0
            for g in range(gap if 0 < gap <= MAX_GAP else 0):
                tr["frames"].append(tr["last"] + 1 + g)
                tr["boxes"].append(tr["boxes"][-1])
                tr["scores"].append(0.0)
                tr["pending"].append(win)
            tr["frames"].append(i)
            tr["boxes"].append([float(v) for v in b])
            tr["scores"].append(float(s))
            tr["pending"].append(win)
            tr["last"] = i
            if (len(tr["frames"]) - 1) % EMBED_EVERY == 0:
                tr["emb"].append(aligned(img, k))
                tr["q"].append(quality(img, b))
            flush(tr)
        if dur and i % 25 == 0:
            pc.progress(min(0.9, 0.9 * t / dur))
    T.mark("detect+track")

    min_frames = int(float(job.get("minTrackS", 0.4)) * fps)
    tracks = [tr for tr in tracks if len(tr["frames"]) >= min_frames and tr["emb"]]
    W, H = size or (1, 1)
    res_tracks = []
    for tr in tracks:
        e = arc(tr["emb"])
        tr["arc"] = e.mean(0) / max(1e-6, np.linalg.norm(e.mean(0)))
        sharp = float(np.median([q[0] for q in tr["q"]]))
        light = float(np.median([q[1] for q in tr["q"]]))
        tr["poor"] = bool(sharp < 60 or light < 55)
        if ada is not None:
            a = ada(tr["emb"])
            tr["ada_v"] = a.mean(0) / max(1e-6, np.linalg.norm(a.mean(0)))
        flush(tr, final=True)
        np.save(os.path.join(work, "tracks", f"{tr['id']}.npy"), np.stack(tr["crops"]))
        tr["quality"] = {"sharpness": round(sharp, 1), "brightness": round(light, 1), "det": round(float(np.mean([s for s in tr["scores"] if s > 0] or [0])), 3)}
    T.mark("embed+crops")

    # Identity clusters: average-linkage over tracks (AdaFace when either side is poor and AdaFace is present).
    n = len(tracks)
    sim = np.eye(n)
    for a in range(n):
        for b in range(a + 1, n):
            if ada is not None and (tracks[a]["poor"] or tracks[b]["poor"]):
                v, th = float(tracks[a]["ada_v"] @ tracks[b]["ada_v"]), SAME_ADA
            else:
                v, th = float(tracks[a]["arc"] @ tracks[b]["arc"]), SAME_ARC
            sim[a, b] = sim[b, a] = v - th   # > 0 = same person
    # Two tracks overlapping in time are never the same person.
    for a in range(n):
        for b in range(a + 1, n):
            fa, fb = tracks[a]["frames"], tracks[b]["frames"]
            if fa[0] <= fb[-1] and fb[0] <= fa[-1] and set(fa) & set(fb):
                sim[a, b] = sim[b, a] = -9
    groups = [[k] for k in range(n)]
    while len(groups) > 1:
        best, bi, bj = 0.0, -1, -1
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                v = np.mean([sim[a, b] for a in groups[i] for b in groups[j]])
                if v > best and min(sim[a, b] for a in groups[i] for b in groups[j]) > -9:
                    best, bi, bj = v, i, j
        if bi < 0:
            break
        groups[bi] += groups.pop(bj)
    groups.sort(key=lambda g: -sum(len(tracks[k]["frames"]) for k in g))
    identities = []
    for gi, g in enumerate(groups):
        pid = f"P{gi + 1}"
        for k in g:
            tracks[k]["identity"] = pid
        identities.append({"id": pid, "tracks": [tracks[k]["id"] for k in g], "seconds": round(sum(len(tracks[k]["frames"]) for k in g) / fps, 2),
                           "poor": all(tracks[k]["poor"] for k in g), "thumb": f"thumbs/{pid}.jpg"})
        # A small aligned face of the person (the sharpest sample of the longest track), for the summary page.
        best = max(g, key=lambda k: len(tracks[k]["frames"]))
        q = [x[0] for x in tracks[best]["q"]]
        os.makedirs(os.path.join(work, "thumbs"), exist_ok=True)
        cv2.imwrite(os.path.join(work, "thumbs", f"{pid}.jpg"), tracks[best]["emb"][int(np.argmax(q))])
    for tr in tracks:
        res_tracks.append({
            "id": tr["id"], "t0": round(tr["frames"][0] / fps, 3), "t1": round((tr["frames"][-1] + 1) / fps, 3), "frames": len(tr["frames"]),
            "first": tr["frames"][0], "identity": tr["identity"], "quality": tr["quality"], "poor": tr["poor"], "crop": f"tracks/{tr['id']}.npy",
            "boxes": [[round(f / fps, 3), round(b[0] / W, 4), round(b[1] / H, 4), round((b[2] - b[0]) / W, 4), round((b[3] - b[1]) / H, 4), round(s, 3)]
                      for f, b, s in zip(tr["frames"], tr["boxes"], tr["scores"])],
        })
    T.mark("cluster")
    pc.write(out, {"model": "insightface buffalo_l (SCRFD-10G + ArcFace R50)" + (" + AdaFace IR-101" if ada else ""), "device": dev, "fps": fps,
                   "size": list(size or (0, 0)), "tracks": res_tracks, "identities": identities, "adaface": ada is not None, "timing": T.parts})


if __name__ == "__main__":
    main()
