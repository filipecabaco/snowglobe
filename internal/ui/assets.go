package ui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// The page's files, packed (pack.go): text gzipped, fonts as they are. Browsers take the gzip as
// it is; anything else gets it unpacked.
//
//go:generate go run pack.go
//go:embed all:packed
var packed embed.FS

// assets serves packed/ at /.
func assets() http.Handler {
	files, _ := fs.Sub(packed, "packed")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		h := w.Header()
		h.Set("Content-Type", contentType(name))
		if data, err := fs.ReadFile(files, name); err == nil {
			h.Set("Content-Length", itoa(len(data)))
			if r.Method == http.MethodGet {
				w.Write(data)
			}
			return
		}
		data, err := fs.ReadFile(files, name+".gz")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		h.Set("Vary", "Accept-Encoding")
		if acceptsGzip(r) {
			h.Set("Content-Encoding", "gzip")
			h.Set("Content-Length", itoa(len(data)))
			if r.Method == http.MethodGet {
				w.Write(data)
			}
			return
		}
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if r.Method == http.MethodGet {
			io.Copy(w, zr)
		}
	})
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".woff2":
		return "font/woff2"
	case ".txt", "":
		return "text/plain; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, q, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") && strings.TrimSpace(q) != "q=0" {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	var b [20]byte
	i := len(b)
	for {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
		if n == 0 {
			return string(b[i:])
		}
	}
}
