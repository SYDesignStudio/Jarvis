"""
Transcribe one call recording on this PC — nothing leaves the machine.

    py transcribe.py <audio file>        -> JSON on stdout

{ "text", "segments": [{start, end, text}], "language", "duration", "device", "model" }

Uses faster-whisper. On the RTX card it runs large-v3-turbo in float16
(minutes of audio in seconds); if CUDA cannot start it falls back to the CPU
with the smaller model so a recording is never lost to a driver problem.
The model downloads once (to the Hugging Face cache) on first use.
Env: JARVIS_WHISPER_MODEL, JARVIS_WHISPER_DEVICE (cuda|cpu).
"""
import glob
import json
import os
import site
import sys


def _add_cuda_dlls():
    # pip's nvidia-cublas/cudnn wheels put their DLLs in site-packages/nvidia/*/bin;
    # Windows will not find them on its own.
    roots = site.getsitepackages() + [site.getusersitepackages()]
    for root in roots:
        for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def _load(device):
    from faster_whisper import WhisperModel

    if device == "cuda":
        name = os.environ.get("JARVIS_WHISPER_MODEL", "large-v3-turbo")
        return WhisperModel(name, device="cuda", compute_type="float16"), name
    name = os.environ.get("JARVIS_WHISPER_MODEL", "small")
    return WhisperModel(name, device="cpu", compute_type="int8"), name


def _transcribe_mlx(path):
    """Apple silicon: mlx-whisper runs the same large-v3-turbo on the Mac's own chip."""
    import mlx_whisper

    name = os.environ.get("JARVIS_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
    r = mlx_whisper.transcribe(path, path_or_hf_repo=name, word_timestamps=False)
    segments = [
        {"start": round(float(s["start"]), 1), "end": round(float(s["end"]), 1), "text": str(s["text"]).strip()}
        for s in r.get("segments", [])
    ]
    return {
        "text": " ".join(s["text"] for s in segments).strip() or str(r.get("text", "")).strip(),
        "segments": segments,
        "language": r.get("language", ""),
        "duration": round(segments[-1]["end"], 1) if segments else 0,
        "device": "mlx",
        "model": name,
    }


def transcribe(path):
    if sys.platform == "darwin":
        try:
            return _transcribe_mlx(path)
        except ImportError:
            pass  # no mlx-whisper installed: fall through to faster-whisper on the CPU
    _add_cuda_dlls()
    wanted = os.environ.get("JARVIS_WHISPER_DEVICE", "cuda" if sys.platform == "win32" else "cpu")
    order = ["cuda", "cpu"] if wanted == "cuda" else ["cpu"]
    last = None
    for device in order:
        try:
            model, name = _load(device)
            segs, info = model.transcribe(path, vad_filter=True, beam_size=5)
            segments = [
                {"start": round(s.start, 1), "end": round(s.end, 1), "text": s.text.strip()}
                for s in segs
            ]
            return {
                "text": " ".join(s["text"] for s in segments).strip(),
                "segments": segments,
                "language": info.language,
                "duration": round(info.duration, 1),
                "device": device,
                "model": name,
            }
        except Exception as err:  # CUDA missing/broken -> try the CPU
            last = err
    raise last


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        print(json.dumps({"error": "usage: transcribe.py <audio file>"}))
        sys.exit(2)
    try:
        print(json.dumps(transcribe(sys.argv[1]), ensure_ascii=False))
    except Exception as err:
        print(json.dumps({"error": f"{type(err).__name__}: {err}"}))
        sys.exit(1)
