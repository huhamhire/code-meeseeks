package cmd

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// prIDFlag registers the required `--pr <id>` flag (the `id` field from `pr list`)
// on cmd and binds it to target. Making the PR id an explicit named flag (rather than
// a positional arg) keeps every PR-scoped command's invocation self-describing.
func prIDFlag(cmd *cobra.Command, target *string) {
	cmd.Flags().StringVar(target, "pr", "", "PR id (the `id` field from `pr list`)")
	_ = cmd.MarkFlagRequired("pr")
}

// newPrCmd builds the `pr` command group: direct PR-entity operations — browsing plus
// review write actions (approve / needswork / comment). The review agent is its own
// top-level `agent` group (see newAgentCmd), not nested here: since every command is
// PR-scoped via --pr, nesting agent under pr would only add a redundant `pr` segment.
func newPrCmd() *cobra.Command {
	pr := &cobra.Command{
		Use:   "pr",
		Short: "Browse and act on pull requests",
	}
	pr.AddCommand(
		newCategoriesCmd(),
		newRefreshCmd(),
		newPrListCmd(),
		newPrShowCmd(),
		newPrDiffCmd(),
		newPrActivityCmd(),
		newPrCommitsCmd(),
		newPrReviewersCmd(),
		newPrApproveCmd(),
		newPrNeedsworkCmd(),
		newPrCommentCmd(),
	)
	return pr
}

// newPrListCmd builds `pr list`: the paginated, filtered PR list (GET /prs). Returns
// the slim list projection (id / title / author / createdAt first); category/status
// map to the discovery + review/merge filters, skip/limit drive pagination.
func newPrListCmd() *cobra.Command {
	var category, status, query string
	var skip, limit int
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List PRs with category / status filters and skip+limit pagination",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if category != "" {
				q.Set("category", category)
			}
			if status != "" {
				q.Set("status", status)
			}
			if query != "" {
				q.Set("q", query)
			}
			if skip > 0 {
				q.Set("skip", strconv.Itoa(skip))
			}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			data, err := c.Get("/api/v1/prs", q)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	f := cmd.Flags()
	f.StringVar(&category, "category", "", "discovery category (review-requested|created|assigned|mentioned)")
	f.StringVar(&status, "status", "", "status filter (pending|approved|needs_work|conflict|mergeable)")
	f.StringVar(&query, "query", "", "search text (title / repo / author / number)")
	f.IntVar(&skip, "skip", 0, "skip the first N results (pagination offset)")
	f.IntVar(&limit, "limit", 0, "max results to return (default 100 when unset)")
	return cmd
}

// newPrShowCmd builds `pr show --pr <id>`: the full PR detail incl. description (GET /prs/{id}).
func newPrShowCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "show",
		Short: "Show PR description detail",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr))
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrDiffCmd builds `pr diff --pr <id>`: the changed-file list, or (with --file) one
// file's content on the given --side (GET /prs/{id}/diff[?path=&side=]).
func newPrDiffCmd() *cobra.Command {
	var pr, file, side string
	cmd := &cobra.Command{
		Use:   "diff",
		Short: "List changed files, or fetch one file's content with --file",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if file != "" {
				q.Set("path", file)
			}
			if side != "" {
				q.Set("side", side)
			}
			data, err := c.Get("/api/v1/prs/"+url.PathEscape(pr)+"/diff", q)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	prIDFlag(cmd, &pr)
	cmd.Flags().StringVar(&file, "file", "", "fetch this file's content instead of the changed-file list")
	cmd.Flags().StringVar(&side, "side", "", "file side when --file is set: base|head")
	return cmd
}

// newPrActivityCmd builds `pr activity --pr <id>`: the merged activity timeline
// (comments / commits / review decisions) (GET /prs/{id}/activity).
func newPrActivityCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "activity",
		Short: "Show the PR activity timeline (comments / commits / review decisions)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/activity")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrCommitsCmd builds `pr commits --pr <id>`: the PR's own commits (GET /prs/{id}/commits).
func newPrCommitsCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "commits",
		Short: "List the PR commits",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/commits")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrReviewersCmd builds `pr reviewers --pr <id>`: reviewer approval status (GET /prs/{id}/reviewers).
func newPrReviewersCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "reviewers",
		Short: "Show reviewer approval status",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/reviewers")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrApproveCmd builds `pr approve --pr <id>`: records an Approve review decision on
// the platform, i.e. a real remote write (POST /prs/{id}/approve).
func newPrApproveCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "approve",
		Short: "Approve the PR (posts a real review decision to the platform)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return postAndRender("/api/v1/prs/"+url.PathEscape(pr)+"/approve", nil)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrNeedsworkCmd builds `pr needswork --pr <id>`: records a Needs-Work review decision
// on the platform, i.e. a real remote write (POST /prs/{id}/needswork).
func newPrNeedsworkCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "needswork",
		Short: "Mark the PR as needs-work (posts a real review decision to the platform)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return postAndRender("/api/v1/prs/"+url.PathEscape(pr)+"/needswork", nil)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newPrCommentCmd builds `pr comment --pr <id> <message...>`: posts a top-level comment
// to the PR on the platform (POST /prs/{id}/comment).
func newPrCommentCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "comment <message>",
		Short: "Post a top-level comment on the PR",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return postAndRender("/api/v1/prs/"+url.PathEscape(pr)+"/comment",
				map[string]any{"body": strings.Join(args, " ")})
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}
