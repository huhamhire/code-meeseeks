package apiclient

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSendsCLIVersionHeader(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(CLIVersionHeader)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"data":null}`)
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "tk", "1.2.3").Get("/api/v1/whoami", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "1.2.3" {
		t.Errorf("%s header = %q, want %q", CLIVersionHeader, got, "1.2.3")
	}
}

func TestNoVersionHeaderWhenEmpty(t *testing.T) {
	seen := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, seen = r.Header[http.CanonicalHeaderKey(CLIVersionHeader)]
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"data":null}`)
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "tk", "").Get("/api/v1/whoami", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seen {
		t.Errorf("version header should be omitted when version is empty")
	}
}

func TestClientTooOldMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired) // 426
		_, _ = io.WriteString(w, `{"ok":false,"error":{"code":"ESV0005","meta":{"minVersion":"0.9.0","clientVersion":"0.1.0"}}}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL, "tk", "0.1.0").Get("/api/v1/whoami", nil)
	if err == nil {
		t.Fatal("expected an error for a too-old client")
	}
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != CodeClientTooOld {
		t.Fatalf("expected APIError with code %s, got %v", CodeClientTooOld, err)
	}
	msg := err.Error()
	// The message must name both versions and steer the user to upgrade.
	if !strings.Contains(msg, "0.9.0") || !strings.Contains(msg, "0.1.0") ||
		!strings.Contains(strings.ToLower(msg), "upgrade") {
		t.Errorf("compat message lacks versions/guidance: %q", msg)
	}
}
