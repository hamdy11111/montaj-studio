# Health check of a Python environment, run with that environment's own python:
#   1. every installed distribution's files (from its RECORD) exist and have the recorded size — a package whose
#      folder was deleted or truncated still "is installed" for pip, so `pip install -r` alone would not repair it;
#   2. the pinned requirements are installed at their versions (missing or other versions are listed);
#   3. the layer's imports work (each module imported in turn; the first error per module is kept).
# Usage: python -I venv_check.py <requirements.txt> <module,module,…>   →  one JSON line on stdout.
import json
import os
import re
import sys
import importlib
import importlib.metadata as md


def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def check_files(dist, shared):
    """Files of the distribution that are missing or have the wrong size (compiled caches skipped). A file that another
    installed distribution also lists (opencv-python-headless and opencv-contrib-python both write cv2/; two packages
    shipping docs/conf.py) belongs to whichever was installed last: not a breakage."""
    bad = []
    for f in dist.files or []:
        s = str(f)
        if "__pycache__" in s or s.endswith(".pyc") or f.size is None or s in shared:
            continue
        p = f.locate()
        try:
            if os.path.getsize(p) != int(f.size):
                bad.append(s)
        except OSError:
            bad.append(s)
        if len(bad) >= 5:
            break
    return bad


def main():
    req_file, modules = sys.argv[1], [m for m in sys.argv[2].split(",") if m]
    installed = {}
    broken = []
    dists = [d for d in md.distributions() if d.metadata["Name"]]
    seen, shared = set(), set()
    for dist in dists:
        for f in dist.files or []:
            s = str(f)
            (shared if s in seen else seen).add(s)
    for dist in dists:
        name = dist.metadata["Name"]
        installed[norm(name)] = dist.version
        bad = check_files(dist, shared)
        if bad:
            broken.append({"name": name, "version": dist.version, "files": bad})
    missing, other = [], []
    for line in open(req_file, encoding="utf-8"):
        line = line.split("#")[0].strip()
        m = re.match(r"^([A-Za-z0-9_.\-]+)\s*(?:==\s*([^\s;]+)|@\s*\S+)", line)
        if not m:
            continue
        name, want = norm(m.group(1)), m.group(2)
        have = installed.get(name)
        if have is None:
            missing.append(m.group(1))
        elif want and have != want and have.split("+")[0] != want.split("+")[0]:
            other.append({"name": m.group(1), "want": want, "have": have})
    errors = {}
    for mod in modules:
        try:
            importlib.import_module(mod)
        except BaseException as e:  # noqa: BLE001 — a broken native module can raise anything
            errors[mod] = f"{type(e).__name__}: {e}"[:300]
    print(json.dumps({"python": sys.version.split()[0], "broken": broken, "missing": missing, "other": other,
                      "imports": errors, "ok": not (broken or missing or other or errors)}))


if __name__ == "__main__":
    main()
