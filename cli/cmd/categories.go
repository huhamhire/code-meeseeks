package cmd

import "github.com/spf13/cobra"

// newCategoriesCmd builds `meebox pr categories`: lists the enabled platform's available
// filter labels — `categories` (discovery) and `statuses` (review/merge) (GET /categories).
// Lives under `pr` because it is the filter vocabulary for `pr list` (--category / --status).
func newCategoriesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "categories",
		Short: "List available PR classification labels for the enabled platforms",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/categories")
		},
	}
}
