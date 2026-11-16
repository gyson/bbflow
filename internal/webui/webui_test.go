package webui

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPagePaths(t *testing.T) {
	mux := http.NewServeMux()
	appearance := "dark"
	Register(mux, func() (string, error) { return appearance, nil })
	for path, want := range map[string]int{
		"/":                    http.StatusOK,
		"/sessions/31a54e53":   http.StatusOK,
		"/settings":            http.StatusOK,
		"/sessions":            http.StatusNotFound,
		"/sessions/":           http.StatusNotFound,
		"/sessions/31a54e53/x": http.StatusNotFound,
		"/settings/":           http.StatusNotFound,
		"/unknown":             http.StatusNotFound,
	} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != want {
			t.Errorf("GET %s: status %d, want %d", path, recorder.Code, want)
			continue
		}
		if want == http.StatusOK && (!strings.Contains(recorder.Body.String(), "<title>bbflow</title>") ||
			!strings.Contains(recorder.Body.String(), `data-appearance="dark"`)) {
			t.Errorf("GET %s did not serve the dark UI page", path)
		}
	}
	appearance = "light"
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(recorder.Body.String(), `data-appearance="light"`) {
		t.Fatal("UI did not use the updated appearance")
	}
}

func TestPageUsesSystemWhenAppearanceReadFails(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, func() (string, error) { return "", errors.New("cannot read settings") })
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `data-appearance="system"`) {
		t.Fatalf("cannot load the UI with System appearance: %d", recorder.Code)
	}
}
