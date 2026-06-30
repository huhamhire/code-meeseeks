// Package render handles CLI output formatting (text vs JSON) and the mapping
// of errors to process exit codes per docs/arch/04-integration/02-cli.md.
package render

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/huhamhire/code-meeseeks/cli/internal/apiclient"
	"github.com/huhamhire/code-meeseeks/cli/internal/settings"
)

// Mode selects the output format.
type Mode int

const (
	ModeText Mode = iota
	ModeJSON
)

// Process exit codes.
const (
	ExitOK       = 0
	ExitGeneric  = 1
	ExitAuth     = 2
	ExitNotFound = 3
)

// Output writes API data to stdout per the selected mode.
//
// NOTE: text mode currently mirrors JSON pretty-printing. Per-command,
// human-friendly table rendering is a deliberate follow-up — the scaffold
// keeps a single code path so the wiring is verifiable end to end first.
func Output(_ Mode, data json.RawMessage) error {
	return writeJSON(data)
}

func writeJSON(data json.RawMessage) error {
	if len(data) == 0 {
		fmt.Println("null")
		return nil
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		// Valid JSON we can't re-decode into `any` is unlikely; print verbatim.
		fmt.Println(string(data))
		return nil
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Errorln prints an error to stderr.
func Errorln(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
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
