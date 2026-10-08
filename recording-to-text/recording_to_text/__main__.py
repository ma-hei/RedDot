"""Mode 2 on the command line: transcribe WAV files with one or more services, side by side.

    .venv/bin/python -m recording_to_text ../red-dot/src/components/RedDotCode/redDotServer/debug-audio/*.wav
    .venv/bin/python -m recording_to_text FILE... --service google,whisper --language de-DE,none

--service and --language take comma-separated lists; every combination runs, so
"--language de-DE,none" shows what giving no language at all changes. --words lists each word
with its time and confidence; --json prints everything (including extras) instead of the table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .settings import load_settings

load_settings()

from . import Params, ServiceError, Transcript, close_all, read_wav, services, transcribe  # noqa: E402


def parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m recording_to_text", description=__doc__.split("\n\n")[0])
    p.add_argument("files", nargs="+", type=Path, help="WAV files (16-bit mono)")
    p.add_argument("--service", default="google", help=f"comma-separated; available: {', '.join(services())}")
    p.add_argument("--language", default="de-DE", help='comma-separated, e.g. "de-DE,none"; none = let the service detect it')
    p.add_argument("--model", help="the service's model, if not its default (applies to every service given)")
    p.add_argument("--words", action="store_true", help="also list the words with times and confidence")
    p.add_argument("--json", action="store_true", help="print the full results as JSON lines")
    return p.parse_args()


def show(t: Transcript, words: bool) -> None:
    confidence = f"{t.confidence:.2f}" if t.confidence is not None else "  – "
    print(f"  {t.service:<8} {t.model:<12} {t.language or '?':<8} {confidence}  {t.latency_ms:>5} ms  {t.text or '(nothing heard)'}")
    if words:
        for w in t.words:
            times = f"{w.start:5.2f}–{w.end:5.2f} s" if w.start is not None and w.end is not None else "".ljust(13)
            conf = f"{w.confidence:.2f}" if w.confidence is not None else "  – "
            print(f"{'':<13}{times}  {conf}  {w.text}")


async def main() -> int:
    args = parse()
    names = [s.strip() for s in args.service.split(",") if s.strip()]
    languages = [None if l.strip().lower() == "none" else l.strip() for l in args.language.split(",") if l.strip()]
    jobs = [(name, language) for name in names for language in languages]
    failed = False
    try:
        for path in args.files:
            try:
                recording = read_wav(path)
            except (OSError, ServiceError) as e:
                print(f"{path.name}: can't read it ({e})", file=sys.stderr)
                failed = True
                continue
            if not args.json:
                print(f"\n{path.name}  ({recording.seconds:.1f} s)", flush=True)
            results = await asyncio.gather(
                *(transcribe(recording, name, Params(language=language, model=args.model)) for name, language in jobs),
                return_exceptions=True,
            )
            for (name, language), result in zip(jobs, results):
                if isinstance(result, Exception):
                    failed = True
                    why = str(result) if isinstance(result, ServiceError) else f"{type(result).__name__}: {result}"
                    print(f"  {name:<8} language {language or 'none'}: failed: {why}", file=sys.stderr, flush=True)
                elif args.json:
                    print(json.dumps({"file": path.name, "requested_language": language, **result.as_dict()}, ensure_ascii=False))
                else:
                    show(result, args.words)
                    sys.stdout.flush()
    finally:
        await close_all()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
