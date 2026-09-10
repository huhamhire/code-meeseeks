"""Bake the tiktoken encodings into the embedded runtime, and verify they will be used without a write.

Run by assemble-pragent-runtime.mjs with a mode argument:

  prime   fetch/repair the bundled encoding files (needs network, runs on a machine that can still write)
  verify  assert the bundled files match what tiktoken pins (pure local check, no network)

Why this exists
---------------
litellm points ``TIKTOKEN_CACHE_DIR`` at its own ``litellm_core_utils/tokenizers/`` and ships encoding files there, so
that tiktoken works offline. But the files it ships are **out of sync with the tiktoken it depends on**: each one fails
the ``expected_hash`` pinned in ``tiktoken_ext/openai_public.py``. tiktoken therefore treats the cache as invalid on
every run — it deletes the file and re-downloads it into that same directory, inside site-packages.

Harmless on a build machine, fatal once installed: under ``C:\\Program Files`` (or any read-only install root) the write
raises PermissionError, which propagates out of TokenHandler and kills the whole command. It is not model specific —
every path that counts tokens goes through this.

Priming makes the shipped bytes match what tiktoken expects, so the cache is a **hit** and nothing is written at all.
`verify` is the part that matters for not shipping this again: a stale file still *loads* on the build machine, because
that machine can re-download it — so "it worked in CI" proves nothing. Comparing against the pinned hash tests the thing
that actually decides fetch-or-reuse at runtime.

Only the two encodings modern models resolve to are handled (``o200k_base``, ``cl100k_base``). ``p50k``/``r50k`` belong
to GPT-3-era models that are no longer reachable; priming them would cost download time and size for a path nothing
takes. If that ever changes, `verify` fails loudly rather than letting a broken runtime ship.
"""

import hashlib
import os
import pathlib
import re
import sys

# The encodings any model we support resolves to: pr-agent uses encoding_for_model() when the model name contains
# "gpt" (→ o200k_base or cl100k_base depending on the model) and o200k_base for everything else, including CLI
# providers, whose model field is a command name.
REQUIRED = ("o200k_base", "cl100k_base")


def _cache_dir() -> pathlib.Path:
    import litellm  # noqa: F401  — importing it is what sets TIKTOKEN_CACHE_DIR

    cache = os.environ.get("TIKTOKEN_CACHE_DIR", "")
    if not cache:
        raise SystemExit("litellm did not set TIKTOKEN_CACHE_DIR; the cache location is unknown")
    return pathlib.Path(cache)


def _pins() -> dict:
    """URL → expected sha256, read from the tiktoken build actually installed (never hardcoded here: a hash copied
    into this file would drift from tiktoken on its next upgrade, reintroducing the bug it exists to prevent)."""
    import tiktoken_ext.openai_public as pub

    src = pathlib.Path(pub.__file__).read_text(encoding="utf-8")
    pattern = r'"(https://openaipublic[^"]+\.tiktoken)",\s*\n\s*expected_hash="([0-9a-f]{64})"'
    return dict(re.findall(pattern, src))


def _url_for(pins: dict, name: str) -> str:
    for url in pins:
        if url.endswith(f"/{name}.tiktoken"):
            return url
    raise SystemExit(f"tiktoken does not pin an encoding named {name}")


def prime() -> None:
    import tiktoken

    _cache_dir()  # side effect: sets TIKTOKEN_CACHE_DIR
    for name in REQUIRED:
        # get_encoding validates the cached file against expected_hash and re-fetches on mismatch — exactly the repair
        # wanted here, while the directory is still writable.
        tiktoken.get_encoding(name)
    # Interrupted downloads leave `<key>.<uuid>.tmp` siblings behind; they are dead weight in the shipped runtime.
    cache = _cache_dir()
    for stray in cache.glob("*.tmp"):
        stray.unlink(missing_ok=True)
    print("MEEBOX_TIKTOKEN_PRIMED")


def verify() -> None:
    cache = _cache_dir()
    pins = _pins()
    for name in REQUIRED:
        url = _url_for(pins, name)
        path = cache / hashlib.sha1(url.encode()).hexdigest()
        if not path.exists():
            raise SystemExit(f"tiktoken encoding {name} is missing from the bundled cache ({path})")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != pins[url]:
            raise SystemExit(
                f"bundled tiktoken {name} does not match the hash tiktoken pins, so it would be re-downloaded at "
                f"runtime — which fails in a read-only install dir. expected {pins[url]}, got {actual}"
            )
    print("MEEBOX_TIKTOKEN_VERIFIED")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "prime":
        prime()
    elif mode == "verify":
        verify()
    else:
        raise SystemExit(f"usage: tiktoken-cache.py prime|verify (got {mode!r})")
