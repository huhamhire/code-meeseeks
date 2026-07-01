// Package settings resolves the API base URL and bearer token used by the CLI,
// following the precedence documented in docs/arch/04-integration/02-cli.md:
// flag > env > CLI config file > local auto-discovery of the app config.
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
	", or enable the service listener in the app")

// Resolve applies the documented precedence (lowest first, overwritten by
// higher sources) and returns the final connection settings.
func Resolve(ov Overrides) (Settings, error) {
	var s Settings

	// 4) lowest precedence: local auto-discovery from the app config.
	if disc, ok := discoverFromAppConfig(); ok {
		s = disc
	}
	// 3) CLI config file.
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
		s.APIURL = fmt.Sprintf("http://%s:%d", defaultHost, defaultPort)
	}
	if s.Token == "" {
		return Settings{}, ErrNoToken
	}
	return s, nil
}

// appConfig is the slice of the app's main config we care about.
type appConfig struct {
	Service struct {
		Enabled bool   `yaml:"enabled"`
		Host    string `yaml:"host"`
		Port    int    `yaml:"port"`
		Token   string `yaml:"token"`
	} `yaml:"service"`
}

// discoverFromAppConfig reads the app's main config at ~/.code-meeseeks/config.yaml
// and, when the service listener is enabled with a token, derives settings from
// it — giving same-machine, same-user integrations a zero-config experience.
// appHome returns the app's fixed data directory (~/.code-meeseeks), shared by the GUI
// and CLI. Both meebox configs live here (GUI: config.yaml, CLI: cli.yaml).
func appHome() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".code-meeseeks"), true
}

func discoverFromAppConfig() (Settings, bool) {
	home, ok := appHome()
	if !ok {
		return Settings{}, false
	}
	data, err := os.ReadFile(filepath.Join(home, "config.yaml"))
	if err != nil {
		return Settings{}, false
	}
	var cfg appConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Settings{}, false
	}
	svc := cfg.Service
	if !svc.Enabled || svc.Token == "" {
		return Settings{}, false
	}
	host := svc.Host
	if host == "" || host == "0.0.0.0" {
		// 0.0.0.0 is a bind address, not a dial target — assume loopback locally.
		host = defaultHost
	}
	port := svc.Port
	if port == 0 {
		port = defaultPort
	}
	return Settings{
		APIURL: fmt.Sprintf("http://%s:%d", host, port),
		Token:  svc.Token,
	}, true
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
