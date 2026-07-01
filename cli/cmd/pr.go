package cmd

import (
	"net/url"

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
	var primary, secondary, query string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List PRs (no pagination) with optional category and search filters",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			q := url.Values{}
			if primary != "" {
				q.Set("primary", primary)
			}
			if secondary != "" {
				q.Set("secondary", secondary)
			}
			if query != "" {
				q.Set("q", query)
			}
			data, err := c.Get("/api/v1/prs", q)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	f := cmd.Flags()
	f.StringVar(&primary, "primary", "", "primary category (platform discovery filter)")
	f.StringVar(&secondary, "secondary", "", "secondary filter (review status / merge state)")
	f.StringVar(&query, "query", "", "search text (title / repo / author / number)")
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
