package render

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/huhamhire/code-meeseeks/cli/internal/apiclient"
	"github.com/huhamhire/code-meeseeks/cli/internal/settings"
)

func TestExitCodeFor(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"nil", nil, ExitOK},
		{"no token", settings.ErrNoToken, ExitAuth},
		{"401 unauthorized", &apiclient.APIError{Status: 401}, ExitAuth},
		{"403 forbidden", &apiclient.APIError{Status: 403}, ExitAuth},
		{"404 not found", &apiclient.APIError{Status: 404}, ExitNotFound},
		{"500 server", &apiclient.APIError{Status: 500}, ExitGeneric},
		{"generic", errors.New("boom"), ExitGeneric},
	}
	for _, c := range cases {
		if got := ExitCodeFor(c.err); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestOutputYAMLAndJSON(t *testing.T) {
	orig := Stdout
	defer func() { Stdout = orig }()
	var buf bytes.Buffer
	Stdout = &buf

	data := json.RawMessage(`{"platform":"github","primary":["review-requested"]}`)

	// YAML (default, human-friendly)
	buf.Reset()
	if err := Output(ModeYAML, data); err != nil {
		t.Fatalf("yaml output: %v", err)
	}
	if got := buf.String(); !strings.Contains(got, "platform: github") {
		t.Errorf("yaml output missing key: %q", got)
	}

	// JSON (machine contract) — must be valid, re-parseable JSON
	buf.Reset()
	if err := Output(ModeJSON, data); err != nil {
		t.Fatalf("json output: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(buf.Bytes(), &v); err != nil {
		t.Fatalf("json output not valid JSON: %v (%q)", err, buf.String())
	}
	if v["platform"] != "github" {
		t.Errorf("json output wrong platform: %v", v["platform"])
	}
}

func TestOutputEmptyData(t *testing.T) {
	orig := Stdout
	defer func() { Stdout = orig }()
	var buf bytes.Buffer
	Stdout = &buf
	if err := Output(ModeYAML, nil); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(buf.String()) != "null" {
		t.Errorf("empty data should print null, got %q", buf.String())
	}
}
