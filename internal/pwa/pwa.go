// Package pwa makes a built site an installable Progressive Web App: a manifest, icons, a service
// worker that keeps the site working offline once it has run, and the tags that tie them in.
package pwa

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
	"time"
)

//go:embed sw.js
var serviceWorker string

//go:embed head.html
var headBlock string

// Options for Run. Empty fields come from the site's run.json.
type Options struct {
	Site      string
	Name      string
	ShortName string
}

const (
	background = "#0b0b0c"
	marker     = "snowglobe:pwa"
)

// The files a run can't start without; everything else is cached as the page fetches it
var shell = []string{"./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png",
	"armless/armless.js", "armless/armless.wasm", "armless/armless-smp.wasm",
	"xterm/xterm.js", "xterm/xterm.css", "xterm/addon-fit.js", "sessions.js", "session-ui.js",
	// Only in a site built with --agent
	"agent.js", "agent-webmcp.js", "agent-panel.js"}

// Run writes the PWA files into the site and ties them into index.html. Running it again
// replaces what an earlier run wrote.
func Run(o Options) error {
	site := o.Site
	var run struct {
		Title   string    `json:"title"`
		BuiltAt time.Time `json:"built_at"`
		CPUs    int       `json:"cpus"`
	}
	data, err := os.ReadFile(filepath.Join(site, "run.json"))
	if err != nil {
		return fmt.Errorf("%s isn't a built snowglobe site (no run.json)", site)
	}
	if err := json.Unmarshal(data, &run); err != nil {
		return err
	}

	name := first(o.Name, run.Title)
	shortName := first(o.ShortName, ShortName(name))

	manifest, err := json.MarshalIndent(map[string]any{
		"name":             name,
		"short_name":       shortName,
		"description":      name + ": a real program on Linux, emulated in WebAssembly on this device. No server.",
		"start_url":        "./",
		"scope":            "./",
		"display":          "standalone",
		"background_color": background,
		"theme_color":      background,
		"icons": []map[string]string{
			{"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
			{"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
		},
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(site, "manifest.webmanifest"), manifest, 0o644); err != nil {
		return err
	}

	for _, size := range []int{192, 512} {
		if err := writeIcon(filepath.Join(site, fmt.Sprintf("icon-%d.png", size)), size); err != nil {
			return err
		}
	}

	// A new build is a new cache: the snapshot and the files it expects change together
	var present []string
	for _, f := range shell {
		if f == "./" {
			present = append(present, f)
		} else if _, err := os.Stat(filepath.Join(site, f)); err == nil {
			present = append(present, f)
		}
	}
	shellJSON, _ := json.Marshal(present)
	// A blob store on another origin (an absolute baseurl in the page) is cached as well
	blobsJSON := `""`
	if page, err := os.ReadFile(filepath.Join(site, "index.html")); err == nil {
		if m := baseurl.FindSubmatch(page); m != nil && (bytes.HasPrefix(m[1], []byte("https://")) || bytes.HasPrefix(m[1], []byte("http://"))) {
			b, _ := json.Marshal(string(m[1]))
			blobsJSON = string(b)
		}
	}
	sw := strings.NewReplacer(
		"__CACHE__", "snowglobe-"+run.BuiltAt.UTC().Format("20060102T150405"),
		"__SHELL__", string(shellJSON),
		// Several CPUs need a cross-origin isolated page (see internal/site/isolate.js)
		"__ISOLATE__", fmt.Sprint(run.CPUs > 1),
		"__BLOBS__", blobsJSON,
	).Replace(serviceWorker)
	if err := os.WriteFile(filepath.Join(site, "sw.js"), []byte(sw), 0o644); err != nil {
		return err
	}

	return injectHead(filepath.Join(site, "index.html"), name, shortName)
}

// ShortName drops the "in the browser" a demo title carries: on a home screen it's an app.
func ShortName(name string) string {
	return strings.TrimSpace(strings.TrimSuffix(name, " in the browser"))
}

var baseurl = regexp.MustCompile(`baseurl:\s*"([^"]+)"`)

var block = regexp.MustCompile(`(?s)\s*<!-- ` + marker + ` -->.*?<!-- /` + marker + ` -->`)

func injectHead(file, name, shortName string) error {
	page, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var b bytes.Buffer
	if err := template.Must(template.New("head").Parse(headBlock)).Execute(&b, map[string]string{
		"Name": name, "ShortName": shortName, "Theme": background,
	}); err != nil {
		return err
	}

	html := block.ReplaceAllString(string(page), "")
	if !strings.Contains(html, "</head>") {
		return fmt.Errorf("%s has no </head>", file)
	}
	html = strings.Replace(html, "</head>", strings.TrimRight(b.String(), "\n")+"\n</head>", 1)
	return os.WriteFile(file, []byte(html), 0o644)
}

// writeIcon draws the mark: the signal dot on ink, full-bleed so platforms can mask it, with the
// dot inside the central safe zone
func writeIcon(file string, size int) error {
	ink := color.RGBA{0x0d, 0x0d, 0x0d, 0xff}
	signal := color.RGBA{0xd6, 0x30, 0x0c, 0xff}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	center := float64(size) / 2
	radius := float64(size) * 0.2
	const samples = 4 // per axis, for smooth edges
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			inside := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					dx := float64(x) + (float64(sx)+0.5)/samples - center
					dy := float64(y) + (float64(sy)+0.5)/samples - center
					if math.Hypot(dx, dy) <= radius {
						inside++
					}
				}
			}
			t := float64(inside) / samples / samples
			mix := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*(1-t) + float64(b)*t)) }
			img.Set(x, y, color.RGBA{mix(ink.R, signal.R), mix(ink.G, signal.G), mix(ink.B, signal.B), 0xff})
		}
	}
	f, err := os.Create(file)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return err
	}
	return f.Close()
}

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
