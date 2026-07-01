package cmd

import (
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
)

func newPrCmd() *cobra.Command {
	pr := &cobra.Command{
		Use:   "pr",
		Short: "Browse pull requests",
	}
	pr.AddCommand(
		newPrListCmd(),
		newPrShowCmd(),
		newPrDiffCmd(),
		newPrActivityCmd(),
		newPrCommitsCmd(),
		newPrReviewersCmd(),
	)
	return pr
}

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

func newPrShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Show PR description detail",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]))
		},
	}
}

func newPrDiffCmd() *cobra.Command {
	var file, side string
	cmd := &cobra.Command{
		Use:   "diff <id>",
		Short: "List changed files, or fetch one file's content with --file",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
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
			data, err := c.Get("/api/v1/prs/"+url.PathEscape(args[0])+"/diff", q)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "fetch this file's content instead of the changed-file list")
	cmd.Flags().StringVar(&side, "side", "", "file side when --file is set: base|head")
	return cmd
}

func newPrActivityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activity <id>",
		Short: "Show the PR activity timeline (comments / commits / review decisions)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]) + "/activity")
		},
	}
}

func newPrCommitsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "commits <id>",
		Short: "List the PR commits",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]) + "/commits")
		},
	}
}

func newPrReviewersCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "reviewers <id>",
		Short: "Show reviewer approval status",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]) + "/reviewers")
		},
	}
}
