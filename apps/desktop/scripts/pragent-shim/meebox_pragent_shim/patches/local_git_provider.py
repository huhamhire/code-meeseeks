"""LocalGitProvider 补丁（受版本守卫）：二进制安全 get_diff_files + get_line_link anchor。"""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _pragent_version, _warn


def patch(module) -> None:
    """LocalGitProvider.get_diff_files 对每个 diff 文件无脑 .decode('utf-8')，遇到二进制
    文件（图片 / 编译产物 / UTF-16 等，如 0xff 开头）抛 UnicodeDecodeError 崩掉整个 review。
    换成二进制安全版：解码失败的文件跳过（review 不处理二进制），其余逻辑与上游一致。"""
    # 版本守卫：只对 pin 的 pr-agent 版本打补丁；不符则整组跳过（含 get_line_link）。
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _warn(
            f"pr-agent {installed} 与 meebox 补丁适配的 {_EXPECTED_PRAGENT_VERSION} 不符，"
            "已跳过补丁（/review 行号定位、二进制安全 diff 失效）。如为有意升级，请同步 "
            "runtime.py 的 _EXPECTED_PRAGENT_VERSION + pragent-runtime.json 并重新验证。"
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
                # 二进制文件无法 utf-8 解码 → 跳过该文件
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
                    # 被删除文件 b_path 为 None → FilePatchInfo.filename=None，下游
                    # set_file_languages / extract_relevant_lines_str 的 filename.rsplit/strip
                    # 会崩，且一崩会中断整次 review 的行号片段抽取（连未删文件的 finding 也丢
                    # 代码片段）。回退用 a_path 保证 filename 永不为 None。
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

    # get_line_link: 基类默认 `return ''`，LocalGitProvider 未实现 → /review 的
    # key_issues 渲染（convert_to_markdown_v2）走"无 link + 非 GFM"分支，把
    # relevant_file/start_line/end_line 抹掉（见 ROADMAP M5 anchor 根因）。补成
    # meebox:///<url-encoded-file>#L<s>-L<e>，使其走 [**header**](link) 分支，
    # parse-output 据链接取结构化 anchor（与真实 provider 同源，不依赖模型自报 marker）。
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
