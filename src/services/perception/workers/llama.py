# A local llama.cpp server for one stage: started with the model (and its multimodal projector), asked over its
# OpenAI-style HTTP API on 127.0.0.1, stopped when the stage ends so its GPU memory goes back.
import base64
import json
import os
import socket
import subprocess
import time
import urllib.request

import pcommon as pc


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Server:
    def __init__(self, exe, model, mmproj=None, ctx=16384, extra=(), log_path=None):
        self.port = free_port()
        cmd = [exe, "-m", model, "--host", "127.0.0.1", "--port", str(self.port), "-ngl", "999", "-c", str(ctx), "-np", "1",
               "-fa", "on", "--jinja", "--no-webui", "--chat-template-kwargs", json.dumps({"enable_thinking": False})]
        if mmproj:
            cmd += ["--mmproj", mmproj]
        cmd += list(extra)
        # The server logs a lot: to a file (a pipe nobody reads would fill up and stall it).
        self.log_path = log_path or os.devnull
        self.log = open(self.log_path, "w", encoding="utf-8", errors="replace")
        self.p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=self.log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def wait(self, timeout=900):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.p.poll() is not None:
                raise RuntimeError("llama-server exited: " + self.tail())
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=5) as r:
                    if json.loads(r.read() or b"{}").get("status") == "ok":
                        return round(time.time() - t0, 1)
            except Exception:  # noqa: BLE001 — still loading
                pass
            time.sleep(1.5)
        raise RuntimeError("llama-server did not become ready")

    def chat(self, messages, schema=None, max_tokens=900, temperature=0.3, timeout=600):
        body = {"messages": messages, "max_tokens": max_tokens, "temperature": temperature, "top_p": 0.8, "top_k": 20, "min_p": 0,
                "chat_template_kwargs": {"enable_thinking": False}}
        if schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": schema, "strict": True}}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/chat/completions", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read())
        return j["choices"][0]["message"].get("content") or "", j.get("usage", {}), j.get("timings", {})

    def tail(self, n=1500):
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                return f.read()[-n:]
        except OSError:
            return ""

    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(20)
            except subprocess.TimeoutExpired:
                self.p.kill()
        self.log.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.stop()


def image_part(path):
    with open(path, "rb") as f:
        return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")}}


def audio_part(path):
    with open(path, "rb") as f:
        return {"type": "input_audio", "input_audio": {"data": base64.b64encode(f.read()).decode("ascii"), "format": "wav"}}


def keyframe(ffmpeg, media, t, out, side=640):
    """One frame at `t` s as JPEG with the long side `side` (read in place; written to the stage's cache folder)."""
    if not os.path.isfile(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", media, "-frames:v", "1",
                        "-vf", f"scale='if(gt(iw,ih),{side},-2)':'if(gt(iw,ih),-2,{side})'", "-q:v", "3", out], check=True)
    return out


def parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    a, b = text.find("{"), text.rfind("}")
    return json.loads(text[a:b + 1])


__all__ = ["Server", "image_part", "audio_part", "keyframe", "parse_json", "pc"]
