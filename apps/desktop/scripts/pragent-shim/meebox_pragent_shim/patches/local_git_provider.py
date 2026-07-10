"""LocalGitProvider patch (version-guarded): binary-safe get_diff_files + get_line_link anchor + repo-context file fetch."""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _pragent_version, _warn


def patch(module) -> None:
    """LocalGitProvider.get_diff_files blindly .decode('utf-8') on every diff file, and on a binary
    file (images / build artifacts / UTF-16 etc., e.g. starting with 0xff) throws UnicodeDecodeError, crashing the whole review.
    Replace with a binary-safe version: files that fail to decode are skipped (review doesn't handle binaries), the rest of the logic identical to upstream."""
    # version guard: only patch the pinned pr-agent version; on mismatch skip the whole group (including get_line_link).
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _warn(
            f"pr-agent {installed} does not match the {_EXPECTED_PRAGENT_VERSION} that the meebox patch is adapted for; "
            "patches skipped (/review line-number anchoring and binary-safe diff disabled). If this is an intentional upgrade, sync "
            "runtime.py's _EXPECTED_PRAGENT_VERSION + pragent-runtime.json and re-verify."
        )
        return
    from pr_agent.algo.types import EDIT_TYPE, FilePatchInfo

    def get_diff_files(self):
        diffs = self.repo.head.commit.diff(
            self.repo.merge_base(self.repo.head, self.repo.branches[self.target_branch_name]),
            create_patch=True,
            R=True,
        )
        diff_files = []
        for diff_item in diffs:
            try:
                original_file_content_str = (
                    diff_item.a_blob.data_stream.read().decode("utf-8")
                    if diff_item.a_blob is not None
                    else ""
                )
                new_file_content_str = (
                    diff_item.b_blob.data_stream.read().decode("utf-8")
                    if diff_item.b_blob is not None
                    else ""
                )
                patch_str = diff_item.diff.decode("utf-8")
            except (UnicodeDecodeError, ValueError):
                # binary file can't be utf-8 decoded → skip this file
                continue
            edit_type = EDIT_TYPE.MODIFIED
            if diff_item.new_file:
                edit_type = EDIT_TYPE.ADDED
            elif diff_item.deleted_file:
                edit_type = EDIT_TYPE.DELETED
            elif diff_item.renamed_file:
                edit_type = EDIT_TYPE.RENAMED
            diff_files.append(
                FilePatchInfo(
                    original_file_content_str,
                    new_file_content_str,
                    patch_str,
                    # a deleted file's b_path is None → FilePatchInfo.filename=None, and downstream
                    # set_file_languages / extract_relevant_lines_str's filename.rsplit/strip
                    # would crash, and one crash interrupts the whole review's line-snippet extraction (even findings for non-deleted files lose
                    # code snippets). Fall back to a_path to guarantee filename is never None.
                    diff_item.b_path or diff_item.a_path,
                    edit_type=edit_type,
                    old_filename=None
                    if diff_item.a_path == diff_item.b_path
                    else diff_item.a_path,
                )
            )
        self.diff_files = diff_files
        return diff_files

    module.LocalGitProvider.get_diff_files = get_diff_files

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

    def get_line_link(self, relevant_file, relevant_line_start, relevant_line_end=None):
        f = quote((relevant_file or "").lstrip("/"), safe="/")
        if not f:
            return ""
        if not relevant_line_start:
            return f"meebox:///{f}"
        if relevant_line_end and relevant_line_end != relevant_line_start:
            return f"meebox:///{f}#L{relevant_line_start}-L{relevant_line_end}"
        return f"meebox:///{f}#L{relevant_line_start}"

    module.LocalGitProvider.get_line_link = get_line_link

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

    # get_repo_file_content: pr-agent 0.39.0's configuration.toml ships a new default
    # `repo_context_files = ["AGENTS.md"]` — build_repo_context() fetches those files from the reviewed
    # repo and injects them as <instruction_files> so /review /describe /improve follow the project's own
    # conventions. The base class returns "" (no-op), so LocalGitProvider is judged "does not support
    # repository file fetching" and logs a WARNING each run while silently skipping the feature. Implement it
    # by reading the blob straight from the base branch's tree object (not the working tree): the review's diff
    # is head.commit vs merge-base(target_branch_name), and target_branch_name is the branch the PR merges
    # into — the trusted "default/base branch" content the feature wants (repo_context_from_default_branch=true).
    # Reading the tree object (never the working tree) also keeps this independent of _prepare_repo's working-tree
    # sanitizing of agent instruction files (that guards the /ask CLI subprocess; repo_context serves the other
    # tools). A missing file / any git error degrades to "" (no context) rather than raising, so
    # build_repo_context treats it as "no context" and never caches a fetch error.
    def get_repo_file_content(self, file_path, from_default_branch=False):
        rel = (file_path or "").lstrip("/")
        if not rel:
            return ""
        try:
            # For a local provider there is no remote "default branch" distinct from the PR base, so both the
            # default-branch and target-branch cases collapse to target_branch_name (guaranteed to exist by
            # _prepare_repo). `git show <ref>:<path>` returns the file text, or errors if the path is absent.
            return self.repo.git.show(f"{self.target_branch_name}:{rel}")
        except Exception:
            return ""

    module.LocalGitProvider.get_repo_file_content = get_repo_file_content
