// Package render handles CLI output formatting (text vs JSON) and the mapping
// of errors to process exit codes per docs/arch/04-integration/02-cli.md.
package render

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

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
	// Indent the raw bytes rather than unmarshal→marshal: json.Indent preserves the
	// server's object key order (the view-layer field order), which decoding into a
	// Go map would lose.
	var buf bytes.Buffer
	if err := json.Indent(&buf, data, "", "  "); err != nil {
		fmt.Fprintln(Stdout, string(data))
		return nil
	}
	buf.WriteByte('\n')
	_, err := Stdout.Write(buf.Bytes())
	return err
}

func writeYAML(data json.RawMessage) error {
	if len(data) == 0 {
		fmt.Fprintln(Stdout, "null")
		return nil
	}
	// Build the YAML tree from the JSON token stream so object key order is preserved
	// (a Go map would sort keys and drop the server's intended field order).
	node, err := jsonToYAMLNode(data)
	if err != nil {
		// Not decodable as JSON — fall back to the raw payload.
		fmt.Fprintln(Stdout, string(data))
		return nil
	}
	out, err := yaml.Marshal(node)
	if err != nil {
		return err
	}
	_, err = Stdout.Write(out)
	return err
}

// jsonToYAMLNode decodes JSON into a *yaml.Node tree, preserving object key order
// (unlike decoding into map[string]any, which loses insertion order).
func jsonToYAMLNode(data []byte) (*yaml.Node, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return buildYAMLValue(dec)
}

func buildYAMLValue(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); ok {
		switch delim {
		case '{':
			m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				val, err := buildYAMLValue(dec)
				if err != nil {
					return nil, err
				}
				m.Content = append(m.Content,
					&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, val)
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return m, nil
		case '[':
			s := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for dec.More() {
				val, err := buildYAMLValue(dec)
				if err != nil {
					return nil, err
				}
				s.Content = append(s.Content, val)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return s, nil
		}
	}
	return scalarYAMLNode(tok), nil
}

func scalarYAMLNode(tok json.Token) *yaml.Node {
	switch t := tok.(type) {
	case string:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}
	case json.Number:
		tag := "!!int"
		if strings.ContainsAny(t.String(), ".eE") {
			tag = "!!float"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: t.String()}
	case bool:
		v := "false"
		if t {
			v = "true"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: v}
	default: // nil
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
	}
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
