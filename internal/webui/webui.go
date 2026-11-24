// Package webui embeds the browser client so deployment needs only the Go binary.
package webui

import (
	"bytes"
	"embed"
	"html/template"
	"net/http"
)

//go:embed dist
var files embed.FS

// Look holds the saved settings that the page applies before its first render.
type Look struct {
	Appearance   string
	SidebarWidth string
}

// Register serves the UI page and its assets. look reads the saved settings of each page.
// When it fails, the page uses System and the normal sidebar width.
func Register(mux *http.ServeMux, look func() (Look, error)) {
	index := template.Must(template.ParseFS(files, "dist/index.html"))
	page := func(w http.ResponseWriter, r *http.Request) {
		saved, err := look()
		if err != nil {
			saved = Look{Appearance: "system", SidebarWidth: "normal"}
		}
		var body bytes.Buffer
		if err := index.Execute(&body, saved); err != nil {
			http.Error(w, "Cannot render the UI page.", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(body.Bytes())
	}
	// The client selects the view from these paths.
	mux.HandleFunc("GET /{$}", page)
	mux.HandleFunc("GET /sessions/{id}", page)
	mux.HandleFunc("GET /settings", page)
	mux.HandleFunc("GET /assets/{path...}", func(w http.ResponseWriter, r *http.Request) {
		name := "dist/assets/" + r.PathValue("path")
		file, err := files.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		http.ServeFileFS(w, r, files, name)
	})
}
