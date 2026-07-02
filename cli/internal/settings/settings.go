// Package settings resolves the API base URL and bearer token used by the CLI,
// following the precedence documented in docs/arch/04-integration/02-cli.md:
// flag > env > CLI config file (~/.code-meeseeks/cli.yaml).
//
// The CLI deliberately does NOT read the GUI's config.yaml: that file holds
// connection-layer secrets (platform tokens etc.), and silently sourcing the
// service token from it would let the CLI reach into credentials it has no
// business touching. Connection details must be provided explicitly.
package settings

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Environment variable names for connection settings.
const (
	EnvAPIURL = "MEEBOX_API_URL"
	EnvToken  = "MEEBOX_TOKEN"
)

const (
	defaultHost = "127.0.0.1"
	defaultPort = 18765
)

// Overrides carries the highest-precedence values, typically from CLI flags.
type Overrides struct {
	APIURL string
	Token  string
}

// Settings is the resolved connection configuration.
type Settings struct {
	APIURL string
	Token  string
}

// ErrNoToken indicates no bearer token could be resolved from any source.
var ErrNoToken = errors.New("no API token: pass --token, set " + EnvToken +
	", or add `token` to ~/.code-meeseeks/cli.yaml")

// Resolve applies the documented precedence (lowest first, overwritten by
// higher sources) and returns the final connection settings.
func Resolve(ov Overrides) (Settings, error) {
	var s Settings

	// 3) lowest precedence: CLI config file.
	if cfg, ok := loadCLIConfig(); ok {
		if cfg.APIURL != "" {
			s.APIURL = cfg.APIURL
		}
		if cfg.Token != "" {
			s.Token = cfg.Token
		}
	}
	// 2) environment.
	if v := os.Getenv(EnvAPIURL); v != "" {
		s.APIURL = v
	}
	if v := os.Getenv(EnvToken); v != "" {
		s.Token = v
	}
	// 1) highest precedence: flags.
	if ov.APIURL != "" {
		s.APIURL = ov.APIURL
	}
	if ov.Token != "" {
		s.Token = ov.Token
	}

	if s.APIURL == "" {
		s.APIURL = DefaultAPIURL()
	}
	if s.Token == "" {
		return Settings{}, ErrNoToken
	}
	return s, nil
}

// DefaultAPIURL is the loopback API base URL used when none is provided.
func DefaultAPIURL() string {
	return fmt.Sprintf("http://%s:%d", defaultHost, defaultPort)
}

// Save writes the connection settings to ~/.code-meeseeks/cli.yaml (creating the directory
// if needed) with owner-only file permissions, since the token is a secret. It overwrites
// any existing CLI config. Returns the path written. This is the write counterpart to the
// cli.yaml read in Resolve — the CLI's `login` command uses it to persist credentials.
func Save(s Settings) (string, error) {
	home, ok := appHome()
	if !ok {
		return "", errors.New("cannot resolve home directory")
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(home, "cli.yaml")
	data, err := yaml.Marshal(cliConfig{APIURL: s.APIURL, Token: s.Token})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// appHome returns the app's fixed data directory (~/.code-meeseeks), shared by the GUI
// and CLI. The CLI's own config (cli.yaml) lives here; the GUI's config.yaml also lives
// here but the CLI never reads it (see package doc).
func appHome() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".code-meeseeks"), true
}

// cliConfig is the CLI's own optional config file.
type cliConfig struct {
	APIURL string `yaml:"api_url"`
	Token  string `yaml:"token"`
}

// loadCLIConfig reads the CLI config at ~/.code-meeseeks/cli.yaml — co-located with the
// GUI config but a separate file, isolating CLI settings from the GUI's config.yaml.
func loadCLIConfig() (cliConfig, bool) {
	home, ok := appHome()
	if !ok {
		return cliConfig{}, false
	}
	data, err := os.ReadFile(filepath.Join(home, "cli.yaml"))
	if err != nil {
		return cliConfig{}, false
	}
	var cfg cliConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cliConfig{}, false
	}
	return cfg, true
}
