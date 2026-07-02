package cmd

import (
	"fmt"

	"github.com/huhamhire/code-meeseeks/cli/internal/render"
	"github.com/spf13/cobra"
)

// newSkillCmd builds `meebox skill`: prints the agent-facing usage doc (SKILL.md) embedded
// into the binary at build time. Lets the binary self-document even when detached from its
// release archive (self-introspection), and keeps the emitted doc in lock-step with the
// shipped SKILL.md. doc is injected from main; empty only in bare unit-test builds.
func newSkillCmd(doc string) *cobra.Command {
	return &cobra.Command{
		Use:   "skill",
		Short: "Print the embedded agent usage doc (SKILL.md)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if doc == "" {
				return fmt.Errorf("skill doc not embedded in this build")
			}
			fmt.Fprint(render.Stdout, doc)
			return nil
		},
	}
}
