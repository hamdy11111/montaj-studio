# Measurements of each take of a retake group (Phase 5, best take), for core/takeScore.js via services/takes/features.js.
#
#     python -X utf8 take_features.py --job <job.json> --out <result.json>
#
# job: { media, ffmpeg, ffprobe, modelsDir, stages: ["prosody","dnsmos","face","gaze","video"], fps,
#        takes: [{ id, t0, t1, words: [[t0, t1]…], faceBoxes: [[t, x, y, w, h]…] (normalised, perception), faceMode }] }
#   faceMode: "entity" (follow the boxes of the speaker's face from perception), "largest" (no timeline: the biggest
#   face), "none" (the speaker is off screen: no face measures).
# result: { takes: { <id>: { prosody, dnsmos, face, video } }, models: {…}, ms }
#
# Per take, read in place from the media (never copied):
#   prosody  openSMILE eGeMAPSv02 functionals: pitch variety (F0 semitone stddevNorm), loudness mean, voiced segments/s, HNR.
#   dnsmos   DNSMOS P.835 (sig_bak_ovr.onnx, Microsoft DNS-Challenge), the reference recipe: 16 kHz, 9.01 s windows (a
#            shorter take is repeated to fill one), the published polynomial calibration. SIG/BAK/OVRL 1…5.
#   face     the speaker's face box (perception's track, or the largest OpenCV YuNet face), then MediaPipe Face Landmarker
#            (478 points + 52 blendshapes) on a crop around it, 10 frames/s: blinks (eyeBlink > 0.5) whose middle
#            falls inside a word; LibreFace (ONNX from its official NuGet package) on the face aligned like LibreFace's
#            own Python code (eye + lip landmarks → 256 quad → 224 centre crop): AU6, AU12 (real smile), AU1, AU2 (brows).
#   gaze     L2CS-Net ResNet50 (Gaze360 weights, Py-Feat's safetensors re-host) on the face crop: share of frames whose
#            gaze is within `gazeDeg` of the camera.
#   video    picture brightness (mean luma) and shake (median jitter of the frame-to-frame shift around its 5-frame
#            average, px at 320 px wide — a deliberate pan barely moves the median).
import json
import math
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tcommon import args, progress, log, write  # noqa: E402

SR = 16000
AU_KEYS = [1, 2, 4, 5, 6, 9, 12, 15, 17, 20, 25, 26]
# LibreFace's alignment landmark sets (detect_mediapipe_image.py): unique indices of the MediaPipe face-mesh
# connections, in that order — left eye, right eye, lips.
_LEFT = [(263, 249), (249, 390), (390, 373), (373, 374), (374, 380), (380, 381), (381, 382), (382, 362), (263, 466), (466, 388), (388, 387), (387, 386), (386, 385), (385, 384), (384, 398), (398, 362)]
_RIGHT = [(33, 7), (7, 163), (163, 144), (144, 145), (145, 153), (153, 154), (154, 155), (155, 133), (33, 246), (246, 161), (161, 160), (160, 159), (159, 158), (158, 157), (157, 173), (173, 133)]
_LIPS = [(61, 146), (146, 91), (91, 181), (181, 84), (84, 17), (17, 314), (314, 405), (405, 321), (321, 375), (375, 291), (61, 185), (185, 40), (40, 39), (39, 37), (37, 0), (0, 267), (267, 269), (269, 270), (270, 409), (409, 291), (78, 95), (95, 88), (88, 178), (178, 87), (87, 14), (14, 317), (317, 402), (402, 318), (318, 324), (324, 308), (78, 191), (191, 80), (80, 81), (81, 82), (82, 13), (13, 312), (312, 311), (311, 310), (310, 415), (415, 308)]


def _uniq(pairs):
    out = []
    for a, b in pairs:
        if a not in out:
            out.append(a)
        if b not in out:
            out.append(b)
    return out


LF_IDX = _uniq(_LEFT) + _uniq(_RIGHT) + _uniq(_LIPS)
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)


# ------------------------------------------------------------------ media reading
def probe(ffprobe, media):
    out = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", media], capture_output=True, check=True)
    st = (json.loads(out.stdout.decode("utf-8")).get("streams") or [{}])[0]
    w, h = int(st.get("width") or 0), int(st.get("height") or 0)
    rot = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    rot = rot or int(float((st.get("tags") or {}).get("rotate", 0)))
    if abs(rot) % 180 == 90:
        w, h = h, w
    return w, h


def read_audio(ffmpeg, media, t0, t1):
    cmd = [ffmpeg, "-v", "error", "-ss", f"{max(0, t0):.3f}", "-t", f"{max(0.05, t1 - t0):.3f}", "-i", media, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def read_frames(ffmpeg, media, t0, t1, size, fps):
    w, h = size
    cmd = [ffmpeg, "-v", "error", "-ss", f"{max(0, t0):.3f}", "-t", f"{max(0.05, t1 - t0):.3f}", "-i", media, "-an", "-vf", f"fps={fps},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)
    times = [t0 + (i + 0.5) / fps for i in range(n)]
    return frames, times


# ------------------------------------------------------------------ voice
class Prosody:
    def __init__(self):
        import opensmile
        self.smile = opensmile.Smile(feature_set=opensmile.FeatureSet.eGeMAPSv02, feature_level=opensmile.FeatureLevel.Functionals)

    def __call__(self, audio):
        if len(audio) < SR * 0.3:
            return None
        df = self.smile.process_signal(audio, SR)
        row = df.iloc[0]
        g = lambda k: float(row[k]) if k in row and np.isfinite(row[k]) else None  # noqa: E731
        return {"pitchVar": g("F0semitoneFrom27.5Hz_sma3nz_stddevNorm"), "pitchMean": g("F0semitoneFrom27.5Hz_sma3nz_amean"), "loudnessMean": g("loudness_sma3_amean"),
                "loudnessVar": g("loudness_sma3_stddevNorm"), "voicedPerSec": g("VoicedSegmentsPerSec"), "hnr": g("HNRdBACF_sma3nz_amean")}


class Dnsmos:
    LEN = 9.01

    def __init__(self, models_dir):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(os.path.join(models_dir, "dnsmos", "sig_bak_ovr.onnx"), providers=["CPUExecutionProvider"])

    @staticmethod
    def _poly(sig, bak, ovr):  # dnsmos_local.py, is_personalized_MOS = False
        return (np.poly1d([-0.08397278, 1.22083953, 0.0052439])(sig), np.poly1d([-0.13166888, 1.60915514, -0.39604546])(bak), np.poly1d([-0.06766283, 1.11546468, 0.04602535])(ovr))

    def __call__(self, audio):
        if len(audio) < SR * 0.3:
            return None
        n = int(self.LEN * SR)
        a = audio
        while len(a) < n:
            a = np.append(a, audio)
        hops = int(np.floor(len(a) / SR) - self.LEN) + 1
        out = []
        for i in range(max(1, hops)):
            seg = a[i * SR: i * SR + n]
            if len(seg) < n:
                continue
            sig, bak, ovr = self.sess.run(None, {"input_1": seg.astype(np.float32)[None, :]})[0][0]
            out.append(self._poly(sig, bak, ovr))
        m = np.mean(np.array(out), axis=0)
        return {"sig": round(float(m[0]), 3), "bak": round(float(m[1]), 3), "ovrl": round(float(m[2]), 3)}


# ------------------------------------------------------------------ face
class Face:
    def __init__(self, models_dir, gaze=True):
        import onnxruntime as ort
        prov = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
        lf = os.path.join(models_dir, "libreface")
        self.enc = ort.InferenceSession(os.path.join(lf, "LibreFace_AU_Encoder.onnx"), providers=prov)
        self.inten = ort.InferenceSession(os.path.join(lf, "LibreFace_AU_Intensity.onnx"), providers=prov)
        self.landmarker_path = os.path.join(models_dir, "mediapipe", "face_landmarker.task")
        self.yunet_path = os.path.join(models_dir, "yunet", "face_detection_yunet_2023mar.onnx")
        self.gaze = L2cs(models_dir) if gaze else None

    def landmarker(self):
        import mediapipe as mp
        from mediapipe.tasks.python import vision, BaseOptions
        opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=self.landmarker_path), running_mode=vision.RunningMode.IMAGE,
                                            num_faces=3, output_face_blendshapes=True, min_face_detection_confidence=0.4, min_face_presence_confidence=0.4)
        return vision.FaceLandmarker.create_from_options(opts), mp

    def detector(self, size):
        import cv2
        return cv2.FaceDetectorYN.create(self.yunet_path, "", size, 0.6, 0.3, 50)

    def roi(self, fr, t, boxes, mode, det):
        """The speaker's face box (normalised x, y, w, h) in this frame: perception's track of that face (entity), or the
        largest face YuNet finds (no timeline). MediaPipe's landmarker is a short-range model — it misses a face that is
        small in a 4K vertical frame — so it runs on a crop around this box."""
        import cv2
        H, W = fr.shape[:2]
        if mode == "entity":
            if not boxes:
                return None
            near = min(boxes, key=lambda b: abs(b[0] - t))
            return tuple(near[1:5]) if abs(near[0] - t) <= 0.6 else None
        sc = 640 / max(W, H)
        small = cv2.resize(fr, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_AREA)
        det.setInputSize((small.shape[1], small.shape[0]))
        _, faces = det.detect(cv2.cvtColor(small, cv2.COLOR_RGB2BGR))
        if faces is None or not len(faces):
            return None
        f = max(faces, key=lambda r: r[2] * r[3])
        return (f[0] / small.shape[1], f[1] / small.shape[0], f[2] / small.shape[1], f[3] / small.shape[0])

    @staticmethod
    def align(img, lm_px):
        """LibreFace's image_align (FFHQ-style oriented quad from eyes + mouth corners) → 224×224 RGB, normalised NCHW."""
        import cv2
        lm = lm_px[LF_IDX]
        eye_right, eye_left, mouth = lm[0:16], lm[16:32], lm[32:]
        li, ri = int(np.argmin(mouth[:, 0])), int(np.argmax(mouth[:, 0]))
        e_l, e_r = eye_left.mean(0), eye_right.mean(0)
        eye_avg, eye_to_eye = (e_l + e_r) * 0.5, e_r - e_l
        mouth_avg = (mouth[li] + mouth[ri]) / 2.0
        eye_to_mouth = mouth_avg - eye_avg
        x = eye_to_eye - np.flipud(eye_to_mouth) * [-1, 1]
        x = x / max(1e-6, np.hypot(*x))
        x = x * max(np.hypot(*eye_to_eye) * 2.0, np.hypot(*eye_to_mouth) * 1.8)
        y = np.flipud(x) * [-1, 1]
        c = eye_avg + eye_to_mouth * 0.1
        quad = np.stack([c - x - y, c - x + y, c + x + y, c + x - y]).astype(np.float32)  # UL, LL, LR, UR
        S = 512
        M = cv2.getAffineTransform(quad[:3], np.float32([[0, 0], [0, S], [S, S]]))
        warped = cv2.warpAffine(img, M, (S, S), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        a256 = cv2.resize(warped, (256, 256), interpolation=cv2.INTER_AREA)
        crop = a256[16:240, 16:240].astype(np.float32) / 255.0
        return ((crop - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None].astype(np.float32)

    def aus(self, img, lm_px):
        feat = self.enc.run(None, {"image": self.align(img, lm_px)})[0].reshape(1, 512)
        v = self.inten.run(None, {"feature": feat})[0][0]
        return {k: float(min(5.0, max(0.0, x * 5.0))) for k, x in zip(AU_KEYS, v)}

    def run(self, frames, times, words, boxes, mode):
        """One take's frames (RGB, display orientation). Returns the face block of the result."""
        import cv2
        out = {"mode": mode, "frames": len(frames), "faceFrames": 0}
        if mode == "none" or not len(frames):
            return out
        H, W = frames.shape[1:3]
        lmk, mp = self.landmarker()
        det = self.detector((640, 640)) if mode == "largest" else None
        series = []  # per frame: {t, blink, aus, gaze} for the chosen face
        try:
            for fr, t in zip(frames, times):
                box = self.roi(fr, t, boxes, mode, det)
                if box is None:
                    continue
                bx, by, bw, bh = box[0] * W, box[1] * H, box[2] * W, box[3] * H
                side = 2.2 * max(bw, bh)
                x0, y0 = int(max(0, bx + bw / 2 - side / 2)), int(max(0, by + bh / 2 - side / 2))
                x1, y1 = int(min(W, bx + bw / 2 + side / 2)), int(min(H, by + bh / 2 + side / 2))
                if x1 - x0 < 24 or y1 - y0 < 24:
                    continue
                crop = fr[y0:y1, x0:x1]
                k_up = 384 / max(crop.shape[:2])
                if k_up > 1:
                    crop = cv2.resize(crop, (int(crop.shape[1] * k_up), int(crop.shape[0] * k_up)), interpolation=cv2.INTER_CUBIC)
                res = lmk.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(crop)))
                faces = res.face_landmarks or []
                if not faces:
                    continue
                ch, cw = crop.shape[:2]
                k = min(range(len(faces)), key=lambda j: math.hypot(np.mean([p.x for p in faces[j]]) - 0.5, np.mean([p.y for p in faces[j]]) - 0.5))
                pts = np.array([[x0 + p.x * cw * (x1 - x0) / cw, y0 + p.y * ch * (y1 - y0) / ch] for p in faces[k]], np.float32)
                bs = {c.category_name: c.score for c in (res.face_blendshapes[k] if res.face_blendshapes else [])}
                f = {"t": t, "blink": (bs.get("eyeBlinkLeft", 0) + bs.get("eyeBlinkRight", 0)) / 2, "mpSmile": (bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2,
                     "facePx": float(max(bw, bh))}
                try:
                    f["aus"] = self.aus(fr, pts)
                except Exception as e:  # a face at the border of the frame
                    log(f"libreface: {e}")
                if self.gaze:
                    f["gaze"] = self.gaze(fr, pts)
                series.append(f)
        finally:
            lmk.close()
        out["faceFrames"] = len(series)
        out["faceShare"] = round(len(series) / max(1, len(frames)), 3)
        if series:
            out["facePx"] = round(float(np.median([f["facePx"] for f in series])), 1)  # face size in the analysed frames (small → less reliable)
        if not series:
            return out
        # Blinks: runs of closed-eye frames; one counts when its middle falls inside a word.
        closed = [f["blink"] > 0.5 for f in series]
        blinks, mid = 0, 0
        i = 0
        while i < len(series):
            if closed[i]:
                j = i
                while j + 1 < len(series) and closed[j + 1]:
                    j += 1
                blinks += 1
                tm = (series[i]["t"] + series[j]["t"]) / 2
                if any(a <= tm <= b for a, b in words):
                    mid += 1
                i = j + 1
            else:
                i += 1
        dur = max(0.2, times[-1] - times[0] + 1e-3) if len(times) > 1 else 0.2
        out.update({"blinks": blinks, "blinksMidWordCount": mid, "blinksMidWord": round(mid / dur, 3), "mpSmile": round(float(np.mean([f["mpSmile"] for f in series])), 3)})
        au = [f["aus"] for f in series if "aus" in f]
        if au:
            a = lambda k: np.array([x[k] for x in au])  # noqa: E731
            out["aus"] = {str(k): round(float(a(k).mean()), 3) for k in AU_KEYS}
            out["smile"] = round(float(np.mean(np.sqrt(a(6) * a(12)))), 3)  # both cheek raiser and lip corners: a real smile
            brow = (a(1) + a(2)) / 2
            out["brows"] = round(float(brow.std() + 0.25 * brow.mean()), 3)
        gz = [f["gaze"] for f in series if f.get("gaze")]
        if gz:
            ang = np.array([math.hypot(p, y) for p, y in gz])
            out["gazeDeg"] = round(float(np.median(ang)), 2)
            out["gazeShare"] = round(float(np.mean(ang <= (self.gaze.deg if self.gaze else 15))), 3)
        return out


class L2cs:
    """L2CS-Net (ResNet50, 90 bins of 4° per axis) — the upstream model definition, weights from py-feat/l2cs."""

    def __init__(self, models_dir, deg=15.0):
        import torch
        import torch.nn as nn
        import torchvision
        from safetensors.torch import load_file

        class L2CS(nn.Module):
            def __init__(self):
                super().__init__()
                r = torchvision.models.resnet50(weights=None)
                self.conv1, self.bn1, self.relu, self.maxpool = r.conv1, r.bn1, r.relu, r.maxpool
                self.layer1, self.layer2, self.layer3, self.layer4, self.avgpool = r.layer1, r.layer2, r.layer3, r.layer4, r.avgpool
                self.fc_yaw_gaze, self.fc_pitch_gaze = nn.Linear(2048, 90), nn.Linear(2048, 90)
                self.fc_finetune = nn.Linear(2048 + 3, 3)

            def forward(self, x):
                x = self.maxpool(self.relu(self.bn1(self.conv1(x))))
                x = self.avgpool(self.layer4(self.layer3(self.layer2(self.layer1(x))))).flatten(1)
                return self.fc_yaw_gaze(x), self.fc_pitch_gaze(x)

        self.torch = torch
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        m = L2CS()
        m.load_state_dict(load_file(os.path.join(models_dir, "l2cs", "l2cs_gaze360_resnet50.safetensors")))
        self.m = m.eval().to(self.dev)
        self.idx = torch.arange(90, dtype=torch.float32, device=self.dev)
        self.deg = deg

    def __call__(self, img, pts):
        import cv2
        H, W = img.shape[:2]
        x0, y0 = pts.min(0)
        x1, y1 = pts.max(0)
        cx, cy, s = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 1.15
        a, b = int(max(0, cx - s / 2)), int(max(0, cy - s / 2))
        c, d = int(min(W, cx + s / 2)), int(min(H, cy + s / 2))
        if c - a < 16 or d - b < 16:
            return None
        crop = cv2.resize(img[b:d, a:c], (448, 448), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        t = self.torch.from_numpy(((crop - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]).to(self.dev)
        with self.torch.no_grad():
            yaw, pitch = self.m(t)
            yaw = float((self.torch.softmax(yaw, 1) * self.idx).sum() * 4 - 180)
            pitch = float((self.torch.softmax(pitch, 1) * self.idx).sum() * 4 - 180)
        return pitch, yaw


# ------------------------------------------------------------------ picture gate
def video_gate(frames):
    import cv2
    if not len(frames):
        return None
    H, W = frames.shape[1:3]
    sw = 320
    sh = max(16, int(round(H * sw / W)))
    grays = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (sw, sh), interpolation=cv2.INTER_AREA).astype(np.float32) for f in frames]
    luma = float(np.mean([g.mean() for g in grays]))
    sharp = float(np.mean([cv2.Laplacian(g, cv2.CV_32F).var() for g in grays]))
    shake = None
    if len(grays) >= 5:
        win = cv2.createHanningWindow((sw, sh), cv2.CV_32F)
        d = np.array([cv2.phaseCorrelate(grays[i - 1], grays[i], win)[0] for i in range(1, len(grays))])
        traj = np.cumsum(d, 0)
        k = 5
        pad = np.pad(traj, ((k // 2, k // 2), (0, 0)), mode="edge")
        smooth = np.stack([np.convolve(pad[:, j], np.ones(k) / k, mode="valid") for j in range(2)], 1)
        shake = float(np.median(np.sqrt(((traj - smooth) ** 2).sum(1))))  # median: a quick pan moves a few frames, shake moves them all
    return {"luma": round(luma, 2), "sharp": round(sharp, 2), "shake": None if shake is None else round(shake, 3)}


def main():
    job, out = args()
    t_start = time.time()
    stages = set(job.get("stages") or ["prosody", "dnsmos", "face", "gaze", "video"])
    media, ffmpeg = job["media"], job["ffmpeg"]
    models = job["modelsDir"]
    fps = float(job.get("fps") or 10)
    size = None
    need_frames = bool(stages & {"face", "gaze", "video"})
    if need_frames:
        w, h = probe(job.get("ffprobe") or ffmpeg.replace("ffmpeg", "ffprobe"), media)
        long_side = int(job.get("longSide") or 1920)
        sc = min(1.0, long_side / max(w, h))
        size = (max(2, int(round(w * sc / 2)) * 2), max(2, int(round(h * sc / 2)) * 2))
    pros = Prosody() if "prosody" in stages else None
    dns = Dnsmos(models) if "dnsmos" in stages else None
    face = Face(models, gaze="gaze" in stages) if "face" in stages else None
    res, takes = {}, job["takes"]
    for n, tk in enumerate(takes):
        t0, t1 = float(tk["t0"]), float(tk["t1"])
        r = {}
        if pros or dns:
            audio = read_audio(ffmpeg, media, t0, t1)
            if pros:
                r["prosody"] = pros(audio)
            if dns:
                r["dnsmos"] = dns(audio)
        if need_frames:
            frames, times = read_frames(ffmpeg, media, t0, t1, size, fps)
            if "video" in stages:
                r["video"] = video_gate(frames)
            if face:
                r["face"] = face.run(frames, times, [tuple(w) for w in tk.get("words") or []], tk.get("faceBoxes") or [], tk.get("faceMode") or "largest")
        res[str(tk["id"])] = r
        progress((n + 1) / len(takes), f"take {n + 1}/{len(takes)}")
    write(out, {"takes": res, "size": size, "fps": fps, "ms": int((time.time() - t_start) * 1000),
                "models": {"prosody": "openSMILE eGeMAPSv02 functionals" if pros else None, "dnsmos": "DNSMOS P.835 sig_bak_ovr.onnx" if dns else None,
                           "face": "MediaPipe Face Landmarker + LibreFace 2.0 (ONNX)" if face else None, "gaze": "L2CS-Net ResNet50 Gaze360" if face and face.gaze else None}})


if __name__ == "__main__":
    main()
