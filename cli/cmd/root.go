// Package cmd defines the meebox command tree built on cobra.
package cmd

import (
	"encoding/json"
	"os"

	"github.com/huhamhire/code-meeseeks/cli/internal/apiclient"
	"github.com/huhamhire/code-meeseeks/cli/internal/render"
	"github.com/huhamhire/code-meeseeks/cli/internal/settings"
	"github.com/spf13/cobra"
)

// version is overridden at build time via -ldflags; "dev" for local builds.
var version = "dev"

type globalFlags struct {
	apiURL string
	token  string
	output string
	quiet  bool
}

var gflags globalFlags

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "meebox",
		Short:         "Code Meeseeks CLI — integrate PR review capabilities over the local API",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       version,
	}
	pf := root.PersistentFlags()
	pf.StringVar(&gflags.apiURL, "api-url", "", "API base URL (overrides "+settings.EnvAPIURL+" and cli.yaml)")
	pf.StringVar(&gflags.token, "token", "", "bearer token (overrides "+settings.EnvToken+" and cli.yaml)")
	pf.StringVar(&gflags.output, "output", "yaml", "output format: yaml|json")
	pf.BoolVar(&gflags.quiet, "quiet", false, "suppress non-essential output")

	root.AddCommand(
		newCategoriesCmd(),
		newPrCmd(),
	)
	return root
}

// Execute runs the root command, printing errors to stderr and mapping them
// to process exit codes per docs/arch/04-integration/02-cli.md.
func Execute() {
	if err := newRootCmd().Execute(); err != nil {
		render.Errorln(err)
		os.Exit(render.ExitCodeFor(err))
	}
}

// resolveClient builds an API client from the resolved connection settings.
func resolveClient() (*apiclient.Client, error) {
	s, err := settings.Resolve(settings.Overrides{
		APIURL: gflags.apiURL,
		Token:  gflags.token,
	})
	if err != nil {
		return nil, err
	}
	return apiclient.New(s.APIURL, s.Token), nil
}

func outputMode() render.Mode {
	if gflags.output == "json" {
		return render.ModeJSON
	}
	return render.ModeYAML
}

func renderData(data json.RawMessage) error {
	return render.Output(outputMode(), data)
}

// getAndRender is the common GET-then-render path used by read-only commands.
func getAndRender(path string) error {
	c, err := resolveClient()
	if err != nil {
		return err
	}
	data, err := c.Get(path, nil)
	if err != nil {
		return err
	}
	return renderData(data)
}

// postAndRender is the common POST-then-render path used by action commands
// (agent triggers, review write actions). body may be nil for parameterless POSTs.
func postAndRender(path string, body any) error {
	c, err := resolveClient()
	if err != nil {
		return err
	}
	data, err := c.Post(path, body)
	if err != nil {
		return err
	}
	return renderData(data)
}
