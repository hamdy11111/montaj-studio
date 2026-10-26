"""Run every speech model of the Phase 0 comparison on the reference clips, one after the other (one command).

Each engine runs with its own environment's Python (bench/asr_engines.py ENGINES[...]["python"] under runtime\\) and
holds the shared GPU lock (D:\\capcut new\\gpu-lock.mjs, name asr-ab) for its own run only — released even when it fails.
Engines whose hyp\\<name>.json already exists are skipped unless --force. Then bench/asr-score.mjs writes the page:
the final «مقارنة النماذج» when reference.json exists, otherwise the provisional agreement page.

    python bench/asr_all.py [--dir <...\\النتائج\\الكتابة>] [--only qwencleo,cohere] [--force] [--no-lock]
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from asr_engines import ENGINES  # noqa: E402

RUNTIME = os.path.join(APP, "runtime")
LOCK = r"D:\capcut new\gpu-lock.mjs"
ORDER = ["nemo", "whisper", "qwencleo", "qwen3", "cohere", "jais", "voxtral"]
NEMO = os.path.join(APP, "src", "services", "asr", "models", "asr-egyptian-nemo-v2.0.nemo")


def bench_dir():
    """montaj-bench\النتائج\الكتابة next to the app (main checkout) or two levels up (a worktree)."""
    for up in ("..", os.path.join("..", "..")):
        d = os.path.abspath(os.path.join(APP, up, "montaj-bench", "النتائج", "الكتابة"))
        if os.path.isdir(d):
            return d
    return os.path.abspath(os.path.join(APP, "..", "montaj-bench", "النتائج", "الكتابة"))


def python_of(engine):
    return os.path.join(RUNTIME, ENGINES[engine]["python"], "Scripts", "python.exe")


def lock(cmd):
    return subprocess.run(["node", LOCK, cmd, "asr-ab", "--wait-min", "240"], check=cmd == "acquire").returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=bench_dir())
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-lock", action="store_true", help="the caller already holds the GPU lock")
    a = ap.parse_args()
    ffmpeg = os.path.join(APP, "node_modules", "ffmpeg-static", "ffmpeg.exe")
    todo = a.only.split(",") if a.only else ORDER
    failed = []
    for eng in todo:
        hyp = os.path.join(a.dir, "hyp", f"{eng}.json")
        if os.path.exists(hyp) and not a.force:
            print(f"{eng}: already done ({hyp})")
            continue
        py = python_of(eng)
        if not os.path.exists(py):
            print(f"{eng}: no environment at {py} — skipped")
            failed.append(eng)
            continue
        cmd = [py, "-X", "utf8", os.path.join(HERE, "asr_run.py"), "--engine", eng, "--ffmpeg", ffmpeg, "--dir", a.dir]
        if eng == "nemo":
            cmd += ["--model", NEMO]
        if not a.no_lock:
            lock("acquire")
        try:
            code = subprocess.run(cmd, env={**os.environ, "PYTHONUTF8": "1", "HF_HUB_OFFLINE": "1"}).returncode
        finally:
            if not a.no_lock:
                lock("release")
        if code:
            failed.append(eng)
    subprocess.run(["node", os.path.join(HERE, "asr-score.mjs"), "--dir", a.dir])
    if failed:
        print("failed or skipped:", ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
