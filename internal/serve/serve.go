// Package serve previews a built site the way a static host would.
package serve

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// Run serves dir on localhost:port until interrupted.
func Run(dir string, port int) error {
	h, err := Handler(dir)
	if err != nil {
		return err
	}
	addr := fmt.Sprintf("localhost:%d", port)
	fmt.Printf("Serving %s at http://%s\n", dir, addr)
	return http.ListenAndServe(addr, h)
}

// Handler serves the built site in dir as files.
func Handler(dir string) (http.Handler, error) {
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return nil, fmt.Errorf("%s/index.html not found; run snowglobe build first", dir)
	}
	return http.FileServer(http.Dir(dir)), nil
}
