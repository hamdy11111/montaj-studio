# Person matte for Montaj Studio ("text behind the person"): reads raw RGB frames (w×h, rgb24) on stdin and writes
# one 8-bit mask per frame (w×h, gray: 255 = person incl. hair) on stdout. Model: MediaPipe Selfie Multiclass
# (Apache-2.0, bundled in models/), run locally on the CPU. The model runs on every `--step`-th frame (it costs
# ~70 ms a frame); frames in between get the linear blend of the masks around them. The mask is then smoothed in
# time (no flicker) and its edge softened. With --boxes, one JSON line per frame is written to that file: the face
# box and the head box (face + hair), [x0, y0, x1, y1] in fractions of the frame, or null when not found.
import argparse
import json
import os
import sys

import numpy as np

FACE, HAIR = 3, 1  # categories of the multiclass model: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 others


def box(mask):
    ys = np.where(mask.any(axis=1))[0]
    xs = np.where(mask.any(axis=0))[0]
    if len(xs) < 2 or len(ys) < 2:
        return None
    h, w = mask.shape
    return [float(xs[0]) / w, float(ys[0]) / h, float(xs[-1] + 1) / w, float(ys[-1] + 1) / h]


def lerp_box(a, b, f):
    if a is None or b is None:
        return a if f < 0.5 else b
    return [x + (y - x) * f for x, y in zip(a, b)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--step", type=int, default=2)
    ap.add_argument("--boxes", default=None)
    ap.add_argument("--model", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "selfie_multiclass_256x256.tflite"))
    a = ap.parse_args()

    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=a.model), running_mode=vision.RunningMode.VIDEO,
        output_confidence_masks=True, output_category_mask=False))
    w, h, step = a.width, a.height, max(1, a.step)
    size = w * h * 3
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    boxes_out = open(a.boxes, "w", encoding="utf-8") if a.boxes else None
    sigma = max(1.0, w / 640)
    state = {"ema": None}

    def infer(frame, i):
        res = seg.segment_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame)), int(i * 1000 / a.fps))
        cm = [np.squeeze(c.numpy_view()) for c in res.confidence_masks]
        person = cv2.resize((1.0 - cm[0]).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)  # class 0 = background
        face = cm[FACE] > 0.5
        head = face | (cm[HAIR] > 0.5)
        return person, box(face), box(head)

    def emit(m, face, head):
        e = state["ema"]
        e = m if e is None else 0.65 * m + 0.35 * e
        state["ema"] = e
        out = np.clip((e - 0.35) / 0.3, 0.0, 1.0)  # firm edge, a little inside the soft confidence ramp
        out = cv2.GaussianBlur(out, (0, 0), sigmaX=sigma)
        stdout.write((out * 255).astype(np.uint8).tobytes())
        if boxes_out:
            r = lambda b: None if b is None else [round(x, 4) for x in b]
            boxes_out.write(json.dumps([r(face), r(head)]) + "\n")

    prev, pending, i = None, 0, 0
    while True:
        buf = stdin.read(size)
        if len(buf) < size:
            break
        if i % step == 0 or prev is None:
            cur = infer(np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3), i)
            for k in range(1, pending + 1):  # frames between the two model runs
                f = k / (pending + 1)
                emit((1 - f) * prev[0] + f * cur[0], lerp_box(prev[1], cur[1], f), lerp_box(prev[2], cur[2], f))
            emit(*cur)
            prev, pending = cur, 0
        else:
            pending += 1
        i += 1
    for _ in range(pending):  # tail after the last model run
        emit(*prev)
    stdout.flush()
    if boxes_out:
        boxes_out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
