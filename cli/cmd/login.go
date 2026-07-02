package cmd

import (
	"fmt"

	"github.com/huhamhire/code-meeseeks/cli/internal/render"
	"github.com/huhamhire/code-meeseeks/cli/internal/settings"
	"github.com/spf13/cobra"
)

// newLoginCmd builds `meebox login --token <token> [--server <url>]`: persists the API token
// (and optional server URL, default loopback) to ~/.code-meeseeks/cli.yaml so later commands
// need no `--token` / env each time. Completes CLI config management — the CLI could read
// cli.yaml but had no way to write it. Purely local: it saves credentials, it does not verify
// them against the server (run `meebox whoami` afterwards to confirm they resolve).
func newLoginCmd() *cobra.Command {
	var token, server string
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Save the API token (and optional server URL) to ~/.code-meeseeks/cli.yaml",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if server == "" {
				server = settings.DefaultAPIURL()
			}
			path, err := settings.Save(settings.Settings{APIURL: server, Token: token})
			if err != nil {
				return err
			}
			if !gflags.quiet {
				fmt.Fprintf(render.Stdout, "Saved credentials for %s to %s\n", server, path)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&token, "token", "", "API bearer token (from Settings → Integration)")
	cmd.Flags().StringVar(&server, "server", "", "API base URL (default "+settings.DefaultAPIURL()+")")
	_ = cmd.MarkFlagRequired("token")
	return cmd
}
