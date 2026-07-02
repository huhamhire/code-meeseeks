package cmd

import "github.com/spf13/cobra"

// newRefreshCmd builds `meebox pr refresh`: trigger one immediate poll across all connections
// (the same action as the GUI's manual refresh), fetching the latest PRs into local state and
// returning a summary of what changed (POST /refresh). Returns counts:
// fetched / changed / added / removed / errors. Global — not PR-scoped, so no --pr flag.
func newRefreshCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "refresh",
		Short: "Trigger an immediate poll for the latest PRs",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return postAndRender("/api/v1/refresh", nil)
		},
	}
}
