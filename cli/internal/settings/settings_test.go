package settings

import (
	"errors"
	"testing"
)

// isolateHome points HOME / USERPROFILE at an empty temp dir so os.UserHomeDir
// resolves there — keeping Resolve's CLI config lookup (~/.code-meeseeks/cli.yaml)
// from reading the developer's real file and making these tests non-hermetic.
func isolateHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
}

func TestResolveFlagsWinOverEnv(t *testing.T) {
	isolateHome(t)
	t.Setenv(EnvAPIURL, "http://env:1")
	t.Setenv(EnvToken, "env-token")

	got, err := Resolve(Overrides{APIURL: "http://flag:2", Token: "flag-token"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.APIURL != "http://flag:2" || got.Token != "flag-token" {
		t.Fatalf("flags should win, got %+v", got)
	}
}

func TestResolveDefaultsURLWhenOnlyTokenGiven(t *testing.T) {
	isolateHome(t)
	t.Setenv(EnvAPIURL, "")
	t.Setenv(EnvToken, "env-token")

	got, err := Resolve(Overrides{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Token != "env-token" {
		t.Fatalf("expected env token, got %q", got.Token)
	}
	if got.APIURL == "" {
		t.Fatalf("expected a default API URL")
	}
}

func TestResolveNoTokenErrors(t *testing.T) {
	isolateHome(t)
	t.Setenv(EnvAPIURL, "http://x:1")
	t.Setenv(EnvToken, "")

	if _, err := Resolve(Overrides{}); !errors.Is(err, ErrNoToken) {
		t.Fatalf("expected ErrNoToken, got %v", err)
	}
}
