package cmd

import "github.com/spf13/cobra"

// newWhoamiCmd builds `meebox whoami`: the current authenticated user (from the active
// connection's PAT) plus the integrated platform and connection display name (GET /whoami).
// Handy first call to confirm the token resolves to the expected account / platform.
func newWhoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the current user identity and integrated platform",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/whoami")
		},
	}
}
