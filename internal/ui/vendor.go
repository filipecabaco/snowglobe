//go:build ignore

// vendor keeps the page's JavaScript libraries (vendor.json) as npm published them: each
// package's tarball at its pinned version, checked against its integrity, the files the page
// serves taken out of it (source map comments dropped, the rewrites vendor.json lists applied)
// and their sha256 kept in vendor.json, which the UI's tests check offline.
//
//	go run vendor.go            check static/vendor against the pinned tarballs
//	go run vendor.go -latest    also say which packages have a newer release
//	go run vendor.go -update P  move package P (or "all") to its latest release, then
//	                            go generate ./internal/ui
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type pkg struct {
	Name      string                `json:"name"`
	Version   string                `json:"version"`
	Integrity string                `json:"integrity"`
	Files     map[string]string     `json:"files"`
	Rewrite   map[string][][]string `json:"rewrite,omitempty"`
	SHA256    map[string]string     `json:"sha256,omitempty"`
}

type manifest struct {
	Packages []*pkg `json:"packages"`
}

var client = &http.Client{Timeout: 2 * time.Minute}

func main() {
	latest := flag.Bool("latest", false, "say which packages have a newer release")
	update := flag.String("update", "", "move this package (or all) to its latest release")
	flag.Parse()
	data, err := os.ReadFile("vendor.json")
	if err != nil {
		fail(err)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		fail(err)
	}
	bad := false
	for _, p := range m.Packages {
		if *latest || *update != "" {
			meta, err := registry(p.Name + "/latest")
			if err != nil {
				fail(err)
			}
			if meta.Version != p.Version {
				if *update == p.Name || *update == "all" {
					fmt.Printf("%s: %s -> %s\n", p.Name, p.Version, meta.Version)
					p.Version, p.Integrity = meta.Version, meta.Dist.Integrity
				} else {
					// A GitHub annotation in CI, a line elsewhere
					fmt.Printf("::warning title=%s %s::a newer release is out (go run vendor.go -update %s in internal/ui)\n", p.Name, meta.Version, p.Name)
				}
			}
		}
		files, err := fetch(p)
		if err != nil {
			fail(fmt.Errorf("%s %s: %w", p.Name, p.Version, err))
		}
		sums := map[string]string{}
		for to, want := range files {
			sum := sha256.Sum256(want)
			sums[to] = hex.EncodeToString(sum[:])
			path := filepath.Join("static", to)
			if *update == p.Name || *update == "all" {
				os.MkdirAll(filepath.Dir(path), 0o755)
				if err := os.WriteFile(path, want, 0o644); err != nil {
					fail(err)
				}
				continue
			}
			have, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(have, want) {
				fmt.Printf("::error title=%s::static/%s isn't %s %s's (go run vendor.go -update %s in internal/ui)\n", to, to, p.Name, p.Version, p.Name)
				bad = true
			}
		}
		p.SHA256 = sums
	}
	if *update != "" {
		out, _ := json.MarshalIndent(m, "", "  ")
		if err := os.WriteFile("vendor.json", append(out, '\n'), 0o644); err != nil {
			fail(err)
		}
		fmt.Println("now: go generate ./internal/ui, and look at the page")
	}
	if bad {
		os.Exit(1)
	}
}

type meta struct {
	Version string `json:"version"`
	Dist    struct {
		Tarball   string `json:"tarball"`
		Integrity string `json:"integrity"`
	} `json:"dist"`
}

func registry(path string) (*meta, error) {
	resp, err := client.Get("https://registry.npmjs.org/" + path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("registry %s: %s", path, resp.Status)
	}
	var m meta
	return &m, json.NewDecoder(resp.Body).Decode(&m)
}

var sourceMap = regexp.MustCompile(`(?m)\n?//# sourceMappingURL=\S+\s*$`)

// fetch is a package's served files, by where they go, out of its checked tarball.
func fetch(p *pkg) (map[string][]byte, error) {
	m, err := registry(p.Name + "/" + p.Version)
	if err != nil {
		return nil, err
	}
	resp, err := client.Get(m.Dist.Tarball)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	tgz, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	sum := sha512.Sum512(tgz)
	if got := "sha512-" + base64.StdEncoding.EncodeToString(sum[:]); got != p.Integrity {
		return nil, fmt.Errorf("integrity: the tarball is %s, vendor.json pins %s", got, p.Integrity)
	}
	zr, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		to, ok := p.Files[strings.TrimPrefix(h.Name, "package/")]
		if !ok {
			continue
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(to, "js") {
			data = sourceMap.ReplaceAll(data, nil)
		}
		for _, rw := range p.Rewrite[to] {
			if !bytes.Contains(data, []byte(rw[0])) {
				return nil, fmt.Errorf("%s: no %q to rewrite", to, rw[0])
			}
			data = bytes.ReplaceAll(data, []byte(rw[0]), []byte(rw[1]))
		}
		out[to] = data
	}
	for from, to := range p.Files {
		if _, ok := out[to]; !ok {
			return nil, fmt.Errorf("no %s in the tarball", from)
		}
	}
	return out, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "vendor:", err)
	os.Exit(1)
}
