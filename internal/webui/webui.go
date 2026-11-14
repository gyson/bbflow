// Package webui embeds the browser client so deployment needs only the Go binary.
package webui

import (
	"embed"
	"html/template"
	"net/http"
)

//go:embed dist
var files embed.FS

func Register(mux *http.ServeMux, appearance func() (string, error)) {
	index := template.Must(template.ParseFS(files, "dist/index.html"))
	page := func(w http.ResponseWriter, r *http.Request) {
		mode, err := appearance()
		if err != nil {
			http.Error(w, "Cannot read appearance settings.", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		index.Execute(w, mode)
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
