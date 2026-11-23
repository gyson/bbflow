package webui

import (
	"errors"
	"fmt"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
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

// iOS shows transparent pixels of a home screen icon as black, and it ignores SVG icons.
func TestPageLinksOpaqueAppleTouchIcon(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, func() (string, error) { return "system", nil })
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(recorder.Body.String(), `<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">`) {
		t.Fatal("the page does not link the apple-touch-icon")
	}
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/assets/apple-touch-icon.png", nil))
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("apple-touch-icon: status %d, type %q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	icon, err := png.Decode(recorder.Body)
	if err != nil {
		t.Fatal(err)
	}
	if size := icon.Bounds().Size(); size.X != 180 || size.Y != 180 {
		t.Fatalf("apple-touch-icon is %v, want 180x180", size)
	}
	at := func(x, y int) color.NRGBA { return color.NRGBAModel.Convert(icon.At(x, y)).(color.NRGBA) }
	for y := range 180 {
		for x := range 180 {
			if at(x, y).A != 0xff {
				t.Fatalf("apple-touch-icon pixel (%d, %d) is not opaque", x, y)
			}
		}
	}
	// The tile is a neutral mid gray, so it stays visible on light and dark wallpapers.
	for _, pixel := range []color.NRGBA{at(0, 0), at(0, 179)} {
		if pixel.R < 0x28 || pixel.R > 0x58 || pixel.B < pixel.R || pixel.B-pixel.R > 0x10 {
			t.Fatalf("apple-touch-icon tile color %v is not a neutral mid gray", pixel)
		}
	}
	// The stem of the first letter shows each band in its dark-appearance color.
	// Each grid unit is 9 pixels, and the 2-unit margin moves the logo by 18 pixels.
	logo, err := os.ReadFile("../../web/src/bbflow.svg")
	if err != nil {
		t.Fatal(err)
	}
	fills := regexp.MustCompile(`\.band\d \{ fill: #([0-9a-f]{6}) \}`).FindAllStringSubmatch(string(logo), -1)
	if len(fills) != 6 {
		t.Fatalf("found %d dark band colors in the logo, want 6", len(fills))
	}
	for i, fill := range fills {
		pixel := at(22, 40+18*i)
		got := fmt.Sprintf("%02x%02x%02x", pixel.R, pixel.G, pixel.B)
		if got != fill[1] {
			t.Errorf("apple-touch-icon band %d is #%s, want #%s", i+1, got, fill[1])
		}
	}
}
