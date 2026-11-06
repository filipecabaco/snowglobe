//go:build ignore

// pack writes static/ into packed/ as the binary embeds it: text gzipped at the best level
// (FILE.gz), what is compressed already (fonts) as it is. `go generate ./internal/ui` after
// changing static/; a test says when packed/ is stale.
package main

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if err := os.RemoveAll("packed"); err != nil {
		log.Fatal(err)
	}
	err := filepath.WalkDir("static", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out := filepath.Join("packed", strings.TrimPrefix(path, "static"+string(filepath.Separator)))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		if strings.HasSuffix(path, ".woff2") {
			return os.WriteFile(out, data, 0o644)
		}
		var b bytes.Buffer
		w, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
		w.Write(data)
		w.Close()
		return os.WriteFile(out+".gz", b.Bytes(), 0o644)
	})
	if err != nil {
		log.Fatal(err)
	}
}
