package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/huhamhire/code-meeseeks/cli/internal/render"
	"github.com/spf13/cobra"
)

// newVersionCmd builds `meebox version`: prints the CLI (client) version and, when
// the local API is reachable, the desktop app (server) version — mirroring `docker version`.
// The client version always renders; if the server can't be reached its field is null and a
// warning goes to stderr, but the exit stays 0 so the client version is usable offline.
// (The root `--version` flag remains the quick client-only path.)
func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show the CLI (client) and app (server) versions",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			out := struct {
				Client string  `json:"client"`
				Server *string `json:"server"`
			}{Client: version}
			if sv, err := fetchServerVersion(); err != nil {
				render.Errorln(fmt.Errorf("server version unavailable: %w", err))
			} else {
				out.Server = &sv
			}
			raw, err := json.Marshal(out)
			if err != nil {
				return err
			}
			return renderData(raw)
		},
	}
}

// fetchServerVersion asks the local API for the desktop app version (GET /version).
func fetchServerVersion() (string, error) {
	c, err := resolveClient()
	if err != nil {
		return "", err
	}
	data, err := c.Get("/api/v1/version", nil)
	if err != nil {
		return "", err
	}
	var sv struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &sv); err != nil {
		return "", err
	}
	return sv.Version, nil
}
