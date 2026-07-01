// Command meebox is the CLI client for the Code Meeseeks local API.
//
// It is a thin client over the desktop app's local HTTP API (see
// docs/arch/04-integration). All exposed capabilities are read-only;
// write operations (commenting, approving, publishing) are intentionally
// not provided — integrators implement those against the platform directly.
package main

import "github.com/huhamhire/code-meeseeks/cli/cmd"

func main() {
	cmd.Execute()
}
