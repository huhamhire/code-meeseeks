// Package apiclient is a thin HTTP client for the Code Meeseeks local API.
// It speaks the response envelope documented in
// docs/arch/04-integration/01-service-api.md: { ok, data } on success and
// { ok:false, error:{ code, meta } } on failure.
package apiclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client talks to the local API with a bearer token.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New builds a client for the given base URL and bearer token.
func New(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

// APIError is the structured error decoded from a { ok:false, error } envelope
// (or a bare non-2xx status when the body is not an envelope).
type APIError struct {
	Status int
	Code   string
	Meta   map[string]any
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("API error %s (HTTP %d)", e.Code, e.Status)
	}
	return fmt.Sprintf("API error (HTTP %d)", e.Status)
}

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code string         `json:"code"`
		Meta map[string]any `json:"meta"`
	} `json:"error"`
}

// Get issues an authenticated GET and returns the raw data payload.
func (c *Client) Get(path string, query url.Values) (json.RawMessage, error) {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	return c.do(req)
}

// Post issues an authenticated POST with a JSON body and returns the raw data
// payload. A nil body sends no request entity.
func (c *Client) Post(path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req)
}

func (c *Client) do(req *http.Request) (json.RawMessage, error) {
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var env envelope
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &env); err != nil {
			// Body is not an API envelope (e.g. a proxy error page) — surface status.
			return nil, &APIError{Status: resp.StatusCode}
		}
	}
	if resp.StatusCode >= 400 || !env.OK {
		ae := &APIError{Status: resp.StatusCode}
		if env.Error != nil {
			ae.Code = env.Error.Code
			ae.Meta = env.Error.Meta
		}
		return nil, ae
	}
	return env.Data, nil
}
