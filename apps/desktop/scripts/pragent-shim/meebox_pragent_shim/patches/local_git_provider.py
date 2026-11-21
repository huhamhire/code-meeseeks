"""LocalGitProvider patch (version-guarded): anchors, diff counts, and dirty-tolerant repo preparation."""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _pragent_version, _warn


def patch(module) -> None:
    """Inject the methods LocalGitProvider does not implement: the structured /review anchor (get_line_link),
    a dirty-tolerant _prepare_repo, labels, and diff line counts.

    Binary-safe get_diff_files used to live here too; pr-agent 0.45.0 fixed it upstream (it now skips a file that
    fails to decode, with a warning), so that override is gone — one less thing to keep in step with upstream.
    Trusted base-branch repository context is native in 0.50.0, so that override is also retired.
    """
    # version guard: only patch the pinned pr-agent version; on mismatch skip the whole group.
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _warn(
            f"pr-agent {installed} does not match the {_EXPECTED_PRAGENT_VERSION} that the meebox patch is adapted for; "
            "patches skipped (/review line-number anchoring disabled). If this is an intentional upgrade, sync "
            "runtime.py's _EXPECTED_PRAGENT_VERSION + pragent-runtime.json and re-verify."
        )
        return

    # _prepare_repo: upstream throws "repository is not in a clean state" when repo.is_dirty(). For CLI-mode
    # /ask worktrees we sanitize as needed — truncating the repo's own agent instruction files (CLAUDE.md / AGENTS.md / .cursor rules
    # etc., to prevent the CLI subprocess from auto-loading and polluting the answer); if these files are tracked by the repo, sanitizing makes the working tree "dirty", tripping this guard
    # → the whole /ask crashes at the git-provider acquisition stage, never writing review.md. But the diff comes from branch commits (head.commit vs
    # merge-base, see get_diff_files), independent of whether the working tree is dirty, so the dirty check is a false positive for this "one-shot controlled worktree" setup.
    # Keep only the required "target branch exists" check, drop the dirty check.
    def _prepare_repo(self):
        if self.target_branch_name not in self.repo.heads:
            raise KeyError(f"Branch: {self.target_branch_name} does not exist")

    module.LocalGitProvider._prepare_repo = _prepare_repo

    # get_line_link: the base class defaults to `return ''`, and LocalGitProvider doesn't implement it → /review's
    # key_issues rendering (convert_to_markdown_v2) takes the "no link + non-GFM" branch, dropping
    # relevant_file/start_line/end_line (see ROADMAP M5 anchor root cause). Fill in as
    # meebox:///<url-encoded-file>#L<s>-L<e>, so it takes the [**header**](link) branch,
    # and parse-output derives the structured anchor from the link (same source as real providers, not dependent on the model self-reporting a marker).
    from urllib.parse import quote

    def _line_no(value):
        """A usable 1-based line number, or 0 for "no specific line"."""
        try:
            n = int(value)
        except (TypeError, ValueError):
            return 0
        return n if n > 0 else 0

    def get_line_link(self, relevant_file, relevant_line_start, relevant_line_end=None):
        f = quote((relevant_file or "").lstrip("/"), safe="/")
        if not f:
            return ""
        # `-1` is upstream's "whole file, no particular line" (pr_description passes it for every File Walkthrough
        # row). It is truthy, so a plain falsiness check let it through and produced `#L-1` — a fragment the app then
        # parsed into a bogus anchor at line -1. Anything that is not a positive line number yields a file-level link.
        start = _line_no(relevant_line_start)
        if not start:
            return f"meebox:///{f}"
        end = _line_no(relevant_line_end)
        if end and end != start:
            return f"meebox:///{f}#L{start}-L{end}"
        return f"meebox:///{f}#L{start}"

    module.LocalGitProvider.get_line_link = get_line_link

    # num_plus_lines / num_minus_lines: FilePatchInfo defaults both to -1, and only the real platform providers fill
    # them in — LocalGitProvider does not, so /describe's File Walkthrough rendered every row as "+-1/--1". Wrap
    # rather than reimplement get_diff_files: upstream owns how the diff is produced (0.45.0 also made it binary-safe),
    # and this only backfills two derived counters, computed the same way the platform providers do.
    _orig_get_diff_files = module.LocalGitProvider.get_diff_files

    def get_diff_files(self):
        files = _orig_get_diff_files(self)
        for f in files or []:
            if getattr(f, "num_plus_lines", -1) >= 0:
                continue  # already counted (a future upstream that fills them in wins)
            lines = (getattr(f, "patch", None) or "").splitlines()
            # Count the same way the platform providers do: any line starting with +/-, which includes the
            # `+++`/`---` file headers. Kept identical rather than "corrected" so the numbers agree across providers.
            f.num_plus_lines = len([ln for ln in lines if ln.startswith("+")])
            f.num_minus_lines = len([ln for ln in lines if ln.startswith("-")])
        return files

    module.LocalGitProvider.get_diff_files = get_diff_files

    # uniformly enable GFM: LocalGitProvider defaults to False for 'gfm_markdown', causing /describe's
    # enable_pr_diagram (on by default in configuration.toml) to be gated off by `enable and is_supported(gfm_markdown)`,
    # not producing the mermaid architecture diagram; /review etc. also take the non-GFM simplified branch. Here we make gfm_markdown
    # return True, so describe outputs mermaid diagrams as needed and each tool takes GFM rich markdown (details / tables /
    # mermaid). Format compatibility is handled by the app-side markdown parsing (rehype + mermaid rendering). Other capabilities stay as-is.
    _orig_is_supported = module.LocalGitProvider.is_supported

    def is_supported(self, capability):
        if capability == "gfm_markdown":
            return True
        return _orig_is_supported(self, capability)

    module.LocalGitProvider.is_supported = is_supported

    # get_pr_labels: the base class doesn't implement it, and LocalGitProvider directly throws NotImplementedError('Getting labels
    # is not implemented for the local git provider'). After /review runs it calls set_review_labels →
    # get_pr_labels(update=True) reads existing labels to merge; a local repo has no "label" concept, so the exception is caught by pr_reviewer
    # and logged as ERROR noise (the review result is unaffected). A local repo has no remote labels, so returning an empty list suffices:
    # set_review_labels then takes publish_labels (which LocalGitProvider is already a no-op for), silent throughout.
    def get_pr_labels(self, update=False):
        return []

    module.LocalGitProvider.get_pr_labels = get_pr_labels

    # Committed base-branch context reads are implemented upstream in 0.50.0.
