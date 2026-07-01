package cmd

import "github.com/spf13/cobra"

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
