package cmd

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/huhamhire/code-meeseeks/cli/internal/render"
)

// capturedReq records what the mock server received, for request-shape assertions.
type capturedReq struct {
	called bool
	method string
	path   string
	query  string
	auth   string
	body   string
}

// mockServer stands in for the local API: it records the request and returns the
// documented envelope ({ok:true,data} on 2xx, {ok:false,error} on >=400).
func mockServer(rec *capturedReq, status int, dataJSON string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.called = true
		rec.method = r.Method
		rec.path = r.URL.Path
		rec.query = r.URL.RawQuery
		rec.auth = r.Header.Get("Authorization")
		rec.body = string(body)

		w.Header().Set("Content-Type", "application/json")
		code := status
		if code == 0 {
			code = http.StatusOK
		}
		w.WriteHeader(code)
		if code >= 400 {
			_, _ = io.WriteString(w, `{"ok":false,"error":{"code":"ESV0001"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"data":`+dataJSON+`}`)
	}))
}

// runCmd runs the root command with captured output, returning stdout + the error
// (Execute()'s os.Exit wrapper is bypassed so tests can assert on the error).
func runCmd(args ...string) (string, error) {
	var buf bytes.Buffer
	origOut, origErr := render.Stdout, render.Stderr
	render.Stdout, render.Stderr = &buf, io.Discard
	defer func() { render.Stdout, render.Stderr = origOut, origErr }()

	root := newRootCmd()
	root.SetArgs(args)
	err := root.Execute()
	return buf.String(), err
}

// base flags force explicit connection settings so tests are hermetic (no env /
// local config auto-discovery interference).
func base(srvURL string, rest ...string) []string {
	return append([]string{"--api-url", srvURL, "--token", "tk"}, rest...)
}

func TestCategories(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"platform":"github","primary":["review-requested"],"secondary":["all"]}`)
	defer srv.Close()

	out, err := runCmd(base(srv.URL, "categories")...)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.method != http.MethodGet || rec.path != "/api/v1/categories" {
		t.Errorf("wrong request: %s %s", rec.method, rec.path)
	}
	if rec.auth != "Bearer tk" {
		t.Errorf("wrong auth header: %q", rec.auth)
	}
	if !strings.Contains(out, "platform: github") {
		t.Errorf("output missing rendered field: %q", out)
	}
}

func TestPrListFilters(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `[]`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "pr", "list", "--primary", "created", "--secondary", "approved", "--query", "foo")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.path != "/api/v1/prs" {
		t.Errorf("wrong path: %s", rec.path)
	}
	for _, want := range []string{"primary=created", "secondary=approved", "q=foo"} {
		if !strings.Contains(rec.query, want) {
			t.Errorf("query %q missing %q", rec.query, want)
		}
	}
}

func TestPrShow(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"localId":"abc123","title":"t"}`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "pr", "show", "abc123")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.method != http.MethodGet || rec.path != "/api/v1/prs/abc123" {
		t.Errorf("wrong request: %s %s", rec.method, rec.path)
	}
}

func TestPrDiffFile(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"binary":false,"content":"x"}`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "pr", "diff", "abc123", "--file", "src/a.go", "--side", "head")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.path != "/api/v1/prs/abc123/diff" {
		t.Errorf("wrong path: %s", rec.path)
	}
	for _, want := range []string{"path=src", "side=head"} {
		if !strings.Contains(rec.query, want) {
			t.Errorf("query %q missing %q", rec.query, want)
		}
	}
}

func TestAgentReviewPost(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"status":"succeeded"}`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "agent", "review", "abc123")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.method != http.MethodPost || rec.path != "/api/v1/prs/abc123/agent/review" {
		t.Errorf("wrong request: %s %s", rec.method, rec.path)
	}
}

func TestAgentInstructBody(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"status":"queued"}`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "agent", "instruct", "abc123", "describe", "extra", "ctx")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.method != http.MethodPost || rec.path != "/api/v1/prs/abc123/agent/instruct" {
		t.Errorf("wrong request: %s %s", rec.method, rec.path)
	}
	if !strings.Contains(rec.body, "describe") || !strings.Contains(rec.body, "extra ctx") {
		t.Errorf("body missing command/args: %q", rec.body)
	}
}

func TestAgentInstructWriteToolRejected(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `null`)
	defer srv.Close()

	_, err := runCmd(base(srv.URL, "agent", "instruct", "abc123", "approve")...)
	if err == nil {
		t.Fatal("expected write tool to be rejected")
	}
	if rec.called {
		t.Error("server must not be called for a rejected write tool")
	}
}

func TestAgentChatPost(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"queued":true}`)
	defer srv.Close()

	if _, err := runCmd(base(srv.URL, "agent", "chat", "abc123", "hello", "world")...); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.method != http.MethodPost || rec.path != "/api/v1/prs/abc123/agent/chat" {
		t.Errorf("wrong request: %s %s", rec.method, rec.path)
	}
	if !strings.Contains(rec.body, "hello world") {
		t.Errorf("body missing message: %q", rec.body)
	}
}

func TestAuthFailureExitCode(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 401, "")
	defer srv.Close()

	_, err := runCmd(base(srv.URL, "categories")...)
	if err == nil {
		t.Fatal("expected auth error")
	}
	if got := render.ExitCodeFor(err); got != render.ExitAuth {
		t.Errorf("auth failure exit code = %d, want %d", got, render.ExitAuth)
	}
}

func TestNotFoundExitCode(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 404, "")
	defer srv.Close()

	_, err := runCmd(base(srv.URL, "pr", "show", "missing")...)
	if err == nil {
		t.Fatal("expected not-found error")
	}
	if got := render.ExitCodeFor(err); got != render.ExitNotFound {
		t.Errorf("not-found exit code = %d, want %d", got, render.ExitNotFound)
	}
}

func TestOutputJSON(t *testing.T) {
	var rec capturedReq
	srv := mockServer(&rec, 200, `{"platform":"github"}`)
	defer srv.Close()

	out, err := runCmd(base(srv.URL, "--output", "json", "categories")...)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, `"platform": "github"`) {
		t.Errorf("json output not indented JSON: %q", out)
	}
}
