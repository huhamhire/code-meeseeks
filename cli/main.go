// Command meebox is the CLI client for the Code Meeseeks local API.
//
// It is a thin client over the desktop app's local HTTP API (see
// docs/arch/04-integration). All exposed capabilities are read-only;
// write operations (commenting, approving, publishing) are intentionally
// not provided — integrators implement those against the platform directly.
package main

import (
	_ "embed"

	"github.com/huhamhire/code-meeseeks/cli/cmd"
)

// skillDoc is SKILL.md embedded at build time so the binary can self-document its agent
// usage (`meebox skill`) even when detached from its release archive. Embedding keeps the
// emitted doc in lock-step with the shipped SKILL.md. The embed must live in this root
// package because SKILL.md sits at the module root (go:embed cannot reach parent dirs).
//
//go:embed SKILL.md
var skillDoc string

func main() {
	cmd.Execute(skillDoc)
}
