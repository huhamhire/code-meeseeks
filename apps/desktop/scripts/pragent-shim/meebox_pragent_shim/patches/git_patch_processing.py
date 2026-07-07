"""git_patch_processing patch (version-guarded, self-disabling): fix phantom "unchanged" line on single-line hunks.

===============================================================================================================
MAINTENANCE NOTE — remove this shim once pr-agent fixes the bug upstream.
---------------------------------------------------------------------------------------------------------------
Bug: pr-agent renders a single-line file change (e.g. VERSION `1.5.2` -> `1.5.3`, a hash/checksum file, any
hunk whose OLD side is exactly one line) so the model sees the OLD value as a still-present, unchanged line —
it then wrongly reports "the file now contains both the old and new value".

Root cause (in pr_agent/algo/git_patch_processing.py):
  1. git omits the hunk line-count when it is 1, so a single-line change emits `@@ -1 +1 @@`
     (which per the unified-diff spec means `@@ -1,1 +1,1 @@`).
  2. `extract_hunk_headers` coerces every missing regex group to 0, so the omitted size becomes size1=0
     (it should be 1).
  3. `process_patch_lines`' trailing-context slice `file_original_lines[start1 + size1 - 1 : ...]` then reads
     from `1 + 0 - 1 = 0` — i.e. re-reads the CHANGED line itself — and appends it as a phantom unchanged
     context line, which `decouple_and_convert_to_hunks_with_lines_numbers` places into `__new hunk__`.

Fix: default an OMITTED hunk size to 1 (spec-correct) instead of 0, keeping an EXPLICIT 0 (e.g. `@@ -0,0 +1 @@`
new-file case) as 0. This makes the trailing-context slice start after the hunk, so no phantom line is emitted.

Upstream status (re-checked at pr-agent 0.39.0): still present — `extract_hunk_headers` is byte-identical to
0.36.0 and still coerces the omitted size to 0; no upstream issue/PR addresses it (PRs #2322 / #2330 guard a
DIFFERENT None — a fully malformed `@@` line where `match` itself is None — not the size default).

Removal / upgrade checklist:
  * This patch is BOTH version-guarded (only applies to the pinned _EXPECTED_PRAGENT_VERSION) AND self-disabling
    (it probes the live `extract_hunk_headers`; if upstream already returns size1=1 for `@@ -1 +1 @@`, it does
    nothing). So on a pr-agent bump, re-verify: if the probe reports the bug is gone, DELETE this file and its
    registration in `../__init__` apply(); if it persists, bump _EXPECTED_PRAGENT_VERSION and keep it.
  * Reproduce quickly against the vendored runtime with `MEEBOX_SHIM_DEBUG=1` (the probe logs which branch it took).
===============================================================================================================
"""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version, _warn


def patch(module) -> None:
    # Version guard: this reimplementation mirrors the pinned pr-agent's extract_hunk_headers structure; on a
    # version mismatch skip rather than risk a wrong reimplementation (safe degradation, consistent with the
    # other shim patches). The warning is the "pay attention on upgrade" signal.
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _warn(
            f"pr-agent {installed} does not match the {_EXPECTED_PRAGENT_VERSION} that the meebox patch is "
            "adapted for; git_patch_processing patch skipped (single-line-hunk phantom-line fix disabled). If "
            "this is an intentional upgrade, sync runtime.py's _EXPECTED_PRAGENT_VERSION + pragent-runtime.json, "
            "re-verify whether upstream has fixed the omitted-hunk-size bug, and remove this shim if so."
        )
        return

    orig_extract = module.extract_hunk_headers
    re_hunk_header = module.RE_HUNK_HEADER

    # Self-disable if upstream already fixed it: git omits the size for `@@ -1 +1 @@`, so a correct implementation
    # yields size1 == 1. If the live function already returns a non-zero size here, the bug is gone — do nothing.
    probe = re_hunk_header.match("@@ -1 +1 @@")
    try:
        _, probe_size1, _, _, _ = orig_extract(probe)
    except Exception as exc:  # noqa: BLE001 - unexpected upstream signature change → skip, don't crash the run
        _debug(f"git_patch_processing: extract_hunk_headers probe failed ({exc}); patch skipped")
        return
    if probe_size1 != 0:
        _debug(
            "git_patch_processing: upstream already defaults an omitted hunk size correctly "
            "(probe size1=%r); phantom-line shim skipped — safe to delete this file" % probe_size1
        )
        return

    def extract_hunk_headers(match):
        # Faithful mirror of upstream extract_hunk_headers, with ONE correction: an omitted hunk line-count
        # (regex group is None) defaults to 1 per the unified-diff spec — git drops ",N" only when N == 1 —
        # instead of upstream's blanket 0. An EXPLICIT 0 (present in the text, e.g. the `@@ -0,0 +1 @@` new-file
        # case) is untouched because its group is "0", not None. Only the two size groups (indices 1 and 3) get
        # the size default; any other missing group keeps the original 0 fallback.
        res = list(match.groups())
        for i in range(len(res)):
            if res[i] is None:
                res[i] = 1 if i in (1, 3) else 0
        try:
            start1, size1, start2, size2 = map(int, res[:4])
        except (ValueError, TypeError):  # '@@ -0,0 +1 @@' case (mirrors upstream's bare except)
            start1, size1, size2 = map(int, res[:3])
            start2 = 0
        section_header = res[4]
        return section_header, size1, size2, start1, start2

    module.extract_hunk_headers = extract_hunk_headers
    _debug("git_patch_processing: applied single-line-hunk phantom-line fix (omitted hunk size -> 1)")
