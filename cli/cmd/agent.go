package cmd

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

// readOnlyInstructions is the set of agent instructions the CLI may send.
// Write tools (approve / needswork / publish …) are intentionally excluded —
// the server also hard-refuses them, this is a friendly front-line check.
var readOnlyInstructions = map[string]bool{
	"describe": true,
	"review":   true,
	"ask":      true,
	"improve":  true,
}

func newAgentCmd() *cobra.Command {
	a := &cobra.Command{
		Use:   "agent",
		Short: "Operate the review agent on a PR",
	}
	a.AddCommand(
		newAgentStatusCmd(),
		newAgentHistoryCmd(),
		newAgentReviewCmd(),
		newAgentInstructCmd(),
		newAgentChatCmd(),
	)
	return a
}

func newAgentStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <id>",
		Short: "Show the agent's current execution status",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]) + "/agent")
		},
	}
}

func newAgentHistoryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "history <id>",
		Short: "Show the agent conversation history",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(args[0]) + "/agent/conversation")
		},
	}
}

func newAgentReviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "review <id>",
		Short: "Run auto review on a PR",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(args[0])+"/agent/review", nil)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
}

func newAgentInstructCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "instruct <id> <command> [args...]",
		Short: "Send a read-only agent instruction (describe|review|ask|improve)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			instruction := strings.TrimPrefix(args[1], "/")
			if !readOnlyInstructions[instruction] {
				return fmt.Errorf("instruction %q is not a read-only command; write operations are not supported via the CLI", args[1])
			}
			c, err := resolveClient()
			if err != nil {
				return err
			}
			body := map[string]any{"command": instruction}
			if len(args) > 2 {
				body["args"] = strings.Join(args[2:], " ")
			}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(args[0])+"/agent/instruct", body)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
}

func newAgentChatCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "chat <id> <message>",
		Short: "Send a natural-language chat message (may trigger agent tasks)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			body := map[string]any{"message": strings.Join(args[1:], " ")}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(args[0])+"/agent/chat", body)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
}
