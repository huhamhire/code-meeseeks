package cmd

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

// readOnlyInstructions is the set of agent instructions the CLI may send via
// `pr agent instruct`. These are the read-only pr-agent tools; write review actions
// have dedicated commands (`pr approve` / `pr needswork` / `pr comment`) and are not
// routed through instruct. The server independently enforces the same whitelist.
var readOnlyInstructions = map[string]bool{
	"describe": true,
	"review":   true,
	"ask":      true,
	"improve":  true,
}

// newAgentCmd builds the `pr agent` subgroup: review-agent operations, all PR-scoped
// (each requires `--pr <id>`). Wiring only; nested under `pr`.
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
		newAgentStopCmd(),
		newAgentRunCmd(),
	)
	return a
}

// newAgentRunCmd builds the `pr agent run` subgroup: inspect / cancel individual pr-agent
// tool-call runs in the queue — finer-grained than the PR-level `agent stop`.
func newAgentRunCmd() *cobra.Command {
	r := &cobra.Command{
		Use:   "run",
		Short: "Inspect or cancel individual pr-agent runs",
	}
	r.AddCommand(newAgentRunListCmd(), newAgentRunCancelCmd())
	return r
}

// newAgentRunListCmd builds `pr agent run list --pr <id>`: the PR's active + waiting
// pr-agent runs (runId / tool / state), the source of run ids to cancel
// (GET /prs/{id}/agent/runs).
func newAgentRunListCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the PR's active and queued pr-agent runs",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/agent/runs")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentRunCancelCmd builds `pr agent run cancel --pr <id> --run <runId>`: cancels one
// pr-agent run (active SIGKILL / waiting dequeue) (POST /prs/{id}/agent/runs/{runId}/cancel).
// Unlike `agent stop` (halts the whole PR agent), this targets a single tool-call run.
func newAgentRunCancelCmd() *cobra.Command {
	var pr, run string
	cmd := &cobra.Command{
		Use:   "cancel",
		Short: "Cancel one pr-agent run by id (see `run list`)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return postAndRender(
				"/api/v1/prs/"+url.PathEscape(pr)+"/agent/runs/"+url.PathEscape(run)+"/cancel", nil)
		},
	}
	prIDFlag(cmd, &pr)
	cmd.Flags().StringVar(&run, "run", "", "run id to cancel (from `pr agent run list`)")
	_ = cmd.MarkFlagRequired("run")
	return cmd
}

// newAgentStatusCmd builds `pr agent status --pr <id>`: the agent's current run state
// snapshot (GET /prs/{id}/agent).
func newAgentStatusCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the agent's current execution status",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/agent")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentHistoryCmd builds `pr agent history --pr <id>`: the multi-turn conversation
// history (GET /prs/{id}/agent/conversation).
func newAgentHistoryCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "history",
		Short: "Show the agent conversation history",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return getAndRender("/api/v1/prs/" + url.PathEscape(pr) + "/agent/conversation")
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentReviewCmd builds `pr agent review --pr <id>`: kicks off the review micro-flow
// (describe→review→ask→summary) (POST /prs/{id}/agent/review).
func newAgentReviewCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "review",
		Short: "Run auto review on a PR",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(pr)+"/agent/review", nil)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentInstructCmd builds `pr agent instruct --pr <id> <command> [args...]`: sends a
// single read-only pr-agent instruction (POST /prs/{id}/agent/instruct). Write tools are
// rejected up front (and again by the server).
func newAgentInstructCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "instruct <command> [args...]",
		Short: "Send a read-only agent instruction (describe|review|ask|improve)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			instruction := strings.TrimPrefix(args[0], "/")
			if !readOnlyInstructions[instruction] {
				return fmt.Errorf("instruction %q is not a read-only command; use `pr approve` / `pr needswork` / `pr comment` for write actions", args[0])
			}
			c, err := resolveClient()
			if err != nil {
				return err
			}
			body := map[string]any{"command": instruction}
			if len(args) > 1 {
				body["args"] = strings.Join(args[1:], " ")
			}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(pr)+"/agent/instruct", body)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentChatCmd builds `pr agent chat --pr <id> <message>`: sends a natural-language
// message that may trigger agent tasks (POST /prs/{id}/agent/chat).
func newAgentChatCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "chat <message>",
		Short: "Send a natural-language chat message (may trigger agent tasks)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := resolveClient()
			if err != nil {
				return err
			}
			body := map[string]any{"message": strings.Join(args, " ")}
			data, err := c.Post("/api/v1/prs/"+url.PathEscape(pr)+"/agent/chat", body)
			if err != nil {
				return err
			}
			return renderData(data)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}

// newAgentStopCmd builds `pr agent stop --pr <id>`: interrupts the PR's running agent in
// any phase (thinking / executing) (POST /prs/{id}/agent/stop). PR-level stop — it halts
// the whole agent for that PR, not one specific tool run.
func newAgentStopCmd() *cobra.Command {
	var pr string
	cmd := &cobra.Command{
		Use:   "stop",
		Short: "Stop the PR's running agent (interrupts any in-progress phase)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return postAndRender("/api/v1/prs/"+url.PathEscape(pr)+"/agent/stop", nil)
		},
	}
	prIDFlag(cmd, &pr)
	return cmd
}
