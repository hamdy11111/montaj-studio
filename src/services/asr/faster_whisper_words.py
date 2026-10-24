# Word-level transcription with faster-whisper, used by Montaj Studio's local speech provider.
# Offline only: models are loaded from the local Hugging Face cache (local_files_only=True), never downloaded.
# Prints one JSON object on stdout: {"language", "duration", "device", "segments": [{start, end, text, words: [...]}]}.
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    from faster_whisper import WhisperModel  # imported here so --help works without the package

    def load(device: str):
        compute = "float16" if device == "cuda" else "int8"
        return WhisperModel(args.model, device=device, compute_type=compute, local_files_only=True)

    devices = ["cuda", "cpu"] if args.device == "auto" else [args.device]
    errors = []
    for device in devices:
        try:
            model = load(device)
            segments, info = model.transcribe(
                args.audio,
                language=None if args.language == "auto" else args.language,
                word_timestamps=True,
                beam_size=5,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            out = []
            for seg in segments:  # the generator does the work; a CUDA failure surfaces here
                out.append({
                    "start": seg.start, "end": seg.end, "text": seg.text.strip(),
                    "words": [{"start": w.start, "end": w.end, "word": w.word.strip(), "p": round(w.probability, 3)} for w in (seg.words or [])],
                })
            json.dump({"language": info.language, "duration": info.duration, "device": device, "segments": out}, sys.stdout, ensure_ascii=False)
            return 0
        except Exception as e:  # noqa: BLE001 — report and try the next device
            errors.append(f"{device}: {type(e).__name__}: {e}")
    sys.stderr.write("\n".join(errors))
    return 2


if __name__ == "__main__":
    sys.exit(main())
