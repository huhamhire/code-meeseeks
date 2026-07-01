// Package render handles CLI output formatting (text vs JSON) and the mapping
// of errors to process exit codes per docs/arch/04-integration/02-cli.md.
package render

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/huhamhire/code-meeseeks/cli/internal/apiclient"
	"github.com/huhamhire/code-meeseeks/cli/internal/settings"
	"gopkg.in/yaml.v3"
)

// Stdout / Stderr are the sinks for rendered output and errors. They default to
// the process streams and are overridable in tests to capture output.
var (
	Stdout io.Writer = os.Stdout
	Stderr io.Writer = os.Stderr
)

// Mode selects the output format.
type Mode int

const (
	// ModeYAML renders responses as YAML — the default, human-friendly view
	// (k8s `-o yaml` style): structured yet readable, and derived generically
	// from any response without per-command formatters.
	ModeYAML Mode = iota
	// ModeJSON renders responses as JSON — the stable machine contract for
	// third-party agents / tooling.
	ModeJSON
)

// Process exit codes.
const (
	ExitOK       = 0
	ExitGeneric  = 1
	ExitAuth     = 2
	ExitNotFound = 3
)

// Output writes API data to stdout per the selected mode: YAML (default,
// human-friendly) or JSON (machine contract). Both are generic transforms of
// the response data — no per-command formatting.
func Output(mode Mode, data json.RawMessage) error {
	if mode == ModeJSON {
		return writeJSON(data)
	}
	return writeYAML(data)
}

func writeJSON(data json.RawMessage) error {
	if len(data) == 0 {
		fmt.Fprintln(Stdout, "null")
		return nil
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		// Valid JSON we can't re-decode into `any` is unlikely; print verbatim.
		fmt.Fprintln(Stdout, string(data))
		return nil
	}
	enc := json.NewEncoder(Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func writeYAML(data json.RawMessage) error {
	if len(data) == 0 {
		fmt.Fprintln(Stdout, "null")
		return nil
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		// Not decodable as JSON — fall back to the raw payload.
		fmt.Fprintln(Stdout, string(data))
		return nil
	}
	out, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	_, err = Stdout.Write(out)
	return err
}

// Errorln prints an error to stderr.
func Errorln(err error) {
	fmt.Fprintln(Stderr, "error:", err)
}

// ExitCodeFor maps an error to a process exit code.
func ExitCodeFor(err error) int {
	if err == nil {
		return ExitOK
	}
	if errors.Is(err, settings.ErrNoToken) {
		return ExitAuth
	}
	var ae *apiclient.APIError
	if errors.As(err, &ae) {
		switch {
		case ae.Status == 401 || ae.Status == 403:
			return ExitAuth
		case ae.Status == 404:
			return ExitNotFound
		}
	}
	return ExitGeneric
}
