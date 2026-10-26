"""Speech-model engines for the Phase 0 comparison (bench/asr_run.py) and the pure helpers they share.

Every engine loads once (load) and turns a list of 16 kHz mono WAV files into one text each (transcribe). Weights are
read in place: the user's Hugging Face cache for models already downloaded there (QwenCleo, Qwen3-ASR, the Cohere int8
build, Voxtral), runtime\\models\\asr-ab for the one this session downloaded (Jais-ASR). Nothing is copied.

Environments (each engine's Python, see ENGINES[...]["python"]):
    runtime\\asr        NeMo (the app's own speech model)               transformers 4.57
    runtime\\dub        faster-whisper large-v3 (the draft model)
    runtime\\asr-qwen   qwen-asr / qwencleo-asr: QwenCleo-ASR, Qwen3-ASR   transformers 4.57.6 (pinned by qwen-asr)
    runtime\\asr-hf     transformers 5.16.1: Cohere Transcribe Arabic (int8), Jais-ASR, Voxtral Realtime Arabic

The helpers at the top (plan_chunks, rms_frames, join_texts, strip_tags) have no heavy imports so the unit tests run
with any Python.
"""
import os
import re

SR = 16000

# name → how to run it. "repo" is the Hugging Face id (read from the local cache, offline), "dir" a local folder.
ENGINES = {
    "nemo": {"python": "asr", "label": "NeMo مصري (الحالي)", "plan": "baseline"},
    "whisper": {"python": "dub", "label": "Whisper large-v3 (المسودة)", "plan": "draft"},
    "qwencleo": {"python": "asr-qwen", "repo": "mohammedaly22/QwenCleo-ASR", "label": "QwenCleo-ASR", "plan": "contender"},
    "qwen3": {"python": "asr-qwen", "repo": "Qwen/Qwen3-ASR-1.7B", "label": "Qwen3-ASR-1.7B (الأصلي)", "plan": "rejected-control"},
    "cohere": {"python": "asr-hf", "repo": "NAMAA-Space/cohere-transcribe-arabic-07-2026-int8", "label": "Cohere Transcribe Arabic (int8)",
               "plan": "contender", "max_s": 30.0},
    "jais": {"python": "asr-hf", "dir": os.path.join("models", "asr-ab", "Jais-ASR"), "label": "Jais-ASR", "plan": "optional",
             "max_s": 30.0},
    "voxtral": {"python": "asr-hf", "repo": "mistralai/Voxtral-Mini-4B-Realtime-Arabic", "label": "Voxtral Realtime Arabic",
                "plan": "extra"},
}


# --- pure helpers ---------------------------------------------------------------------------------------------------

def rms_frames(samples, frame=160):
    """Loudness of every 10 ms frame (160 samples at 16 kHz) of a mono float sequence."""
    out = []
    for i in range(0, len(samples), frame):
        part = samples[i:i + frame]
        out.append((sum(x * x for x in part) / max(len(part), 1)) ** 0.5)
    return out


def plan_chunks(energy, frame_s=0.01, max_s=30.0, min_s=None):
    """Split a clip longer than max_s into pieces of at most max_s, cutting at the quietest frame of each piece's
    second half (a pause between words, not the middle of one). Returns [(start_s, end_s)] covering the whole clip."""
    total = len(energy) * frame_s
    if total <= max_s:
        return [(0.0, round(total, 3))]
    min_s = max_s / 2 if min_s is None else min_s
    per = int(round(max_s / frame_s))
    lo_off = int(round(min_s / frame_s))
    cuts, start = [], 0
    while len(energy) - start > per:
        window = range(start + lo_off, start + per + 1)
        cut = min(window, key=lambda i: (energy[i], -i))   # quietest; the later one on a tie keeps pieces long
        cuts.append(cut)
        start = cut
    edges = [0] + cuts + [len(energy)]
    return [(round(a * frame_s, 3), round(b * frame_s, 3)) for a, b in zip(edges, edges[1:])]


TAG = re.compile(r"<\|[^|>]*\|>|</?[a-z_]+>|\[(?:no[_ ]speech|music|noise|silence)\]", re.I)


def strip_tags(text):
    """Special tokens some models leave in their text (<|ar|>, <asr_text>, [no speech]…) → plain words."""
    return re.sub(r"\s+", " ", TAG.sub(" ", str(text or ""))).strip()


def join_texts(parts):
    return re.sub(r"\s+", " ", " ".join(strip_tags(p) for p in parts if p)).strip()


# --- shared plumbing ------------------------------------------------------------------------------------------------

def _read(path):
    import soundfile as sf
    a, sr = sf.read(path, dtype="float32")
    if getattr(a, "ndim", 1) > 1:
        a = a.mean(axis=1)
    assert sr == SR, f"{path}: {sr} Hz (bench/asr_run.py writes 16 kHz)"
    return a


def _pieces(audio, max_s):
    """[(numpy chunk)] for one clip: the whole clip, or its quiet-point pieces when it is longer than max_s."""
    if not max_s or len(audio) <= max_s * SR:
        return [audio]
    import numpy as np
    n = len(audio) // 160
    energy = np.sqrt((audio[: n * 160].reshape(n, 160) ** 2).mean(axis=1)).tolist()
    plan = plan_chunks(energy, max_s=max_s)
    return [audio[int(a * SR): int(b * SR) if i < len(plan) - 1 else len(audio)] for i, (a, b) in enumerate(plan)]


def snapshot_dir(repo):
    """Local folder of a model already in the Hugging Face cache (no network). Several of the user's downloads have
    no refs\\main (fetched by commit), so the snapshot folder is read directly — the cache itself is never written."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE
    try:
        return snapshot_download(repo, local_files_only=True)
    except Exception:
        snaps = os.path.join(HF_HUB_CACHE, "models--" + repo.replace("/", "--"), "snapshots")
        found = sorted((os.path.join(snaps, d) for d in os.listdir(snaps)), key=os.path.getmtime) if os.path.isdir(snaps) else []
        if not found:
            raise FileNotFoundError(f"{repo} is not in the Hugging Face cache ({HF_HUB_CACHE})")
        return found[-1]


_snapshot = snapshot_dir


def _cuda():
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


# --- engines --------------------------------------------------------------------------------------------------------

class Nemo:
    def __init__(self, model_path):
        self.model_path = model_path

    def load(self):
        import torch
        from nemo.collections.asr.models import ASRModel
        self.device = _cuda()
        self.model = ASRModel.restore_from(self.model_path, map_location=self.device).eval()
        self.torch = torch

    def transcribe(self, files):
        out = []
        with self.torch.inference_mode():
            for g in range(0, len(files), 8):
                part = self.model.transcribe(files[g:g + 8], batch_size=4, verbose=False)
                part = part[0] if isinstance(part, tuple) else part
                out.extend([getattr(h, "text", h) for h in part])
        return out


class Whisper:
    def load(self):
        try:
            import torch  # noqa: F401 — the CUDA libraries for ctranslate2 on Windows
        except ImportError:
            pass
        from faster_whisper import WhisperModel
        import ctranslate2
        self.device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        self.model = WhisperModel("large-v3", device=self.device, compute_type="float16" if self.device == "cuda" else "int8")

    def transcribe(self, files):
        out = []
        for f in files:
            parts, _ = self.model.transcribe(f, language="ar", beam_size=5, condition_on_previous_text=False)
            out.append(" ".join(p.text.strip() for p in parts))
        return out


class Qwen:
    """QwenCleo-ASR and its base Qwen3-ASR through the qwen-asr package (transformers backend, bf16, greedy)."""

    def __init__(self, repo):
        self.repo = repo

    def load(self):
        import torch
        from qwen_asr import Qwen3ASRModel
        self.device = _cuda()
        self.model = Qwen3ASRModel.from_pretrained(_snapshot(self.repo), dtype=torch.bfloat16, device_map=f"{self.device}:0" if self.device == "cuda" else "cpu")

    def transcribe(self, files):
        out = []
        for g in range(0, len(files), 8):
            res = self.model.transcribe(audio=files[g:g + 8], language="Arabic")
            out.extend(strip_tags(r.text) for r in res)
        return out


class Cohere:
    """Cohere Transcribe Arabic 07-2026, NAMAA-Space's bitsandbytes LLM.int8() build (the official weights are gated).
    Pieces of at most 30 s (the model takes 35 s at most)."""

    def __init__(self, repo, max_s):
        self.repo, self.max_s = repo, max_s

    def load(self):
        import torch
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration
        path = _snapshot(self.repo)
        self.device, self.torch = _cuda(), torch
        self.processor = AutoProcessor.from_pretrained(path)
        self.model = CohereAsrForConditionalGeneration.from_pretrained(path, device_map="auto").eval()

    def transcribe(self, files):
        out = []
        for f in files:
            texts = []
            for piece in _pieces(_read(f), self.max_s):
                inputs = self.processor(piece, sampling_rate=SR, language="ar", return_tensors="pt").to(self.model.device, dtype=self.model.dtype)
                with self.torch.inference_mode():
                    ids = self.model.generate(**inputs, max_new_tokens=256)
                texts.append(self.processor.decode(ids[0] if getattr(ids, "ndim", 1) > 1 else ids, skip_special_tokens=True))
            out.append(join_texts(texts))
        return out


class Jais:
    """IFM Jais-ASR (bf16, its own modelling code from the downloaded folder). Egyptian pinned (language="EG": it may
    still answer "no speech") and English kept in Latin letters (code_switch), like the user writes it."""

    def __init__(self, folder, max_s):
        self.folder, self.max_s = folder, max_s

    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
        self.device, self.torch = _cuda(), torch
        self.processor = AutoProcessor.from_pretrained(self.folder, trust_remote_code=True)
        self.processor.tokenizer.padding_side = "left"
        self.model = AutoModelForCausalLM.from_pretrained(self.folder, trust_remote_code=True, device_map="auto", dtype=torch.bfloat16).eval()
        import importlib.util
        spec = importlib.util.spec_from_file_location("jais_postprocess", os.path.join(self.folder, "postprocess.py"))
        import sys
        self.post = sys.modules["jais_postprocess"] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.post)   # pure Python: reads the leading [EG] / [IFM-NoTranscript] decision tag
        self.prompt = self.processor.tokenizer.apply_chat_template([{"role": "user", "content": [{"type": "audio"}]}], tokenize=False,
                                                                   add_generation_prompt=True, code_switch=True)

    def _run(self, waves):
        inputs = self.processor(text=[self.prompt] * len(waves), audio=waves, sampling_rate=[SR] * len(waves), padding=True,
                                return_tensors="pt").to(self.model.device)
        with self.torch.inference_mode():
            ids = self.model.generate(**inputs, do_sample=False, max_new_tokens=256, language="EG")
        ids = ids[:, inputs["input_ids"].shape[1]:]
        # "[EG] text" → text; "[IFM-NoTranscript]" (the model's own "no speech here") → ""
        return [strip_tags(self.post.split_text(t).text) for t in self.processor.batch_decode(ids, skip_special_tokens=True)]

    def transcribe(self, files):
        out = []
        for f in files:
            out.append(join_texts(self._run(_pieces(_read(f), self.max_s))))
        return out


class Voxtral:
    """Mistral's Voxtral Mini 4B Realtime Arabic, offline in transformers (whole clip, greedy)."""

    def __init__(self, repo):
        self.repo = repo

    def load(self):
        import torch
        from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration
        path = _snapshot(self.repo)
        self.device, self.torch = _cuda(), torch
        self.processor = AutoProcessor.from_pretrained(path)
        self.model = VoxtralRealtimeForConditionalGeneration.from_pretrained(path, dtype=torch.bfloat16, device_map="auto").eval()

    def transcribe(self, files):
        out = []
        for f in files:
            inputs = self.processor(_read(f), return_tensors="pt").to(self.model.device, dtype=self.model.dtype)
            with self.torch.inference_mode():
                ids = self.model.generate(**inputs, do_sample=False)
            out.append(strip_tags(self.processor.batch_decode(ids, skip_special_tokens=True)[0]))
        return out


def make(engine, runtime, model=None):
    e = ENGINES[engine]
    if engine == "nemo":
        return Nemo(model)
    if engine == "whisper":
        return Whisper()
    if engine in ("qwencleo", "qwen3"):
        return Qwen(e["repo"])
    if engine == "cohere":
        return Cohere(e["repo"], e["max_s"])
    if engine == "jais":
        return Jais(model or os.path.join(runtime, e["dir"]), e["max_s"])
    if engine == "voxtral":
        return Voxtral(e["repo"])
    raise ValueError(engine)
