# Shared plumbing of the best-take workers (src/services/takes/workers/*.py) — the same contract as perception's:
#     python -X utf8 <worker>.py --job <job.json> --out <result.json>
# Progress goes to stderr as "PROGRESS 0.42"; anything else on stderr is a log line. One process per job, so the
# models' GPU memory is given back when it ends.
import argparse
import json
import os
import sys


def args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.job, encoding="utf-8") as f:
        job = json.load(f)
    return job, a.out


def progress(p, note=""):
    print(f"PROGRESS {max(0.0, min(1.0, p)):.3f}{(' ' + note) if note else ''}", file=sys.stderr, flush=True)


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def write(out, result):
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, out)
