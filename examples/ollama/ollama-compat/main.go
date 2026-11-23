// ollama-compat: models from Ollama's library, served with Ollama's API by llama.cpp's server.
//
// It is not Ollama. It pulls models the way Ollama does (registry.ollama.ai, into Ollama's own
// layout under $OLLAMA_MODELS), answers the parts of Ollama's REST API clients use (/api/tags,
// /api/show, /api/ps, /api/generate, /api/chat, /api/version, and OpenAI's /v1/... as Ollama also
// does), and runs the model with llama-server, started when a request first needs it. In a
// snowglobe site that llama-server is built with armless's WebGPU backend, so the model runs on
// the visitor's GPU.
//
//	ollama-compat pull NAME            fetch NAME (smollm2:135m, library/qwen3:0.6b…) from the registry
//	ollama-compat serve                the API on $OLLAMA_HOST (default 127.0.0.1:11434)
//	ollama-compat run NAME [PROMPT]    chat in the terminal (serving the API too, if nothing else is)
//	ollama-compat list                 the models pulled
//
// Environment: OLLAMA_HOST, OLLAMA_MODELS (default ~/.ollama/models), LLAMA_SERVER (default
// llama-server), LLAMA_ARGS (its flags beyond the model and port; default "-ngl 99", every layer
// on the GPU, and "-t 1" when armless's GPU answers), OLLAMA_CONTEXT_LENGTH (default 2048),
// ARMLESS_GPU (where the GPU is; default gpu.internal:7070).
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const version = "0.1.0-snowglobe"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "pull":
		if len(os.Args) != 3 {
			usage()
		}
		err = pull(os.Args[2], os.Stdout)
	case "serve":
		err = serve(hostAddr(), nil)
	case "run":
		if len(os.Args) < 3 {
			usage()
		}
		err = run(os.Args[2], strings.Join(os.Args[3:], " "))
	case "list", "ls":
		err = list()
	case "-v", "--version", "version":
		fmt.Println("ollama-compat", version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ollama-compat:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: ollama-compat pull NAME | serve | run NAME [PROMPT] | list
Ollama's library models, served with Ollama's API by llama.cpp's server (not Ollama itself).`)
	os.Exit(2)
}

// ------------------------------------------------------------------------------ models

func modelsDir() string {
	if d := os.Getenv("OLLAMA_MODELS"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ollama", "models")
}

func hostAddr() string {
	h := os.Getenv("OLLAMA_HOST")
	if h == "" {
		return "127.0.0.1:11434"
	}
	h = strings.TrimPrefix(strings.TrimPrefix(h, "http://"), "https://")
	if !strings.Contains(h, ":") {
		h += ":11434"
	}
	return h
}

// ref is a model's name split as Ollama splits it: [host/][namespace/]model[:tag].
type ref struct{ host, namespace, model, tag string }

func parseRef(name string) ref {
	r := ref{host: "registry.ollama.ai", namespace: "library", tag: "latest"}
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		r.tag = name[i+1:]
		name = name[:i]
	}
	parts := strings.Split(name, "/")
	switch len(parts) {
	case 1:
		r.model = parts[0]
	case 2:
		r.namespace, r.model = parts[0], parts[1]
	default:
		r.host, r.namespace, r.model = parts[0], parts[1], strings.Join(parts[2:], "/")
	}
	return r
}

// short is how Ollama shows a name: library models without their namespace, :latest kept.
func (r ref) short() string {
	n := r.model
	if r.namespace != "library" {
		n = r.namespace + "/" + n
	}
	if r.host != "registry.ollama.ai" {
		n = r.host + "/" + n
	}
	return n + ":" + r.tag
}

func (r ref) manifestPath() string {
	return filepath.Join(modelsDir(), "manifests", r.host, r.namespace, r.model, r.tag)
}

type layer struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
}

type manifest struct {
	SchemaVersion int     `json:"schemaVersion"`
	MediaType     string  `json:"mediaType"`
	Config        layer   `json:"config"`
	Layers        []layer `json:"layers"`
}

func blobPath(digest string) string {
	return filepath.Join(modelsDir(), "blobs", strings.Replace(digest, ":", "-", 1))
}

// model is a pulled model, as the API describes it.
type model struct {
	ref      ref
	manifest manifest
	modified time.Time
	gguf     string // the model layer's file
	template string
	system   string
	params   map[string]any
	license  string
	size     int64
	digest   string // the manifest's
}

func loadModel(name string) (*model, error) {
	r := parseRef(name)
	data, err := os.ReadFile(r.manifestPath())
	if err != nil {
		return nil, fmt.Errorf("model %q not found, try pulling it first", name)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", r.manifestPath(), err)
	}
	st, _ := os.Stat(r.manifestPath())
	sum := sha256.Sum256(data)
	md := &model{ref: r, manifest: m, modified: st.ModTime(), digest: hex.EncodeToString(sum[:])}
	for _, l := range m.Layers {
		md.size += l.Size
		read := func() string {
			b, _ := os.ReadFile(blobPath(l.Digest))
			return string(b)
		}
		switch l.MediaType {
		case "application/vnd.ollama.image.model":
			md.gguf = blobPath(l.Digest)
		case "application/vnd.ollama.image.template":
			md.template = read()
		case "application/vnd.ollama.image.system":
			md.system = read()
		case "application/vnd.ollama.image.license":
			md.license = read()
		case "application/vnd.ollama.image.params":
			_ = json.Unmarshal([]byte(read()), &md.params)
		}
	}
	if md.gguf == "" {
		return nil, fmt.Errorf("%s has no model layer", name)
	}
	return md, nil
}

func allModels() []*model {
	root := filepath.Join(modelsDir(), "manifests")
	var out []*model
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 4 {
			return nil
		}
		r := ref{host: parts[0], namespace: parts[1], model: strings.Join(parts[2:len(parts)-1], "/"), tag: parts[len(parts)-1]}
		if m, err := loadModel(r.host + "/" + r.namespace + "/" + r.model + ":" + r.tag); err == nil {
			out = append(out, m)
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].ref.short() < out[j].ref.short() })
	return out
}

// pull fetches a model from its registry into Ollama's layout, checking every blob's digest.
func pull(name string, w io.Writer) error {
	r := parseRef(name)
	base := "https://" + r.host + "/v2/" + r.namespace + "/" + r.model
	req, _ := http.NewRequest("GET", base+"/manifests/"+r.tag, nil)
	req.Header.Set("Accept", "application/vnd.docker.distribution.manifest.v2+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("pulling %s: %s", name, resp.Status)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	for _, l := range append([]layer{m.Config}, m.Layers...) {
		if l.Digest == "" {
			continue
		}
		dst := blobPath(l.Digest)
		if st, err := os.Stat(dst); err == nil && st.Size() == l.Size {
			continue
		}
		fmt.Fprintf(w, "pulling %s (%s, %s)\n", strings.TrimPrefix(l.Digest, "sha256:")[:12], l.MediaType, humanSize(l.Size))
		if err := fetchBlob(base+"/blobs/"+l.Digest, l, dst); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(r.manifestPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(r.manifestPath(), data, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(w, "pulled %s\n", r.short())
	return nil
}

func fetchBlob(u string, l layer, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	resp, err := http.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: %s", u, resp.Status)
	}
	tmp := dst + ".partial"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != l.Digest {
		os.Remove(tmp)
		return fmt.Errorf("%s: digest %s, want %s", u, got, l.Digest)
	}
	return os.Rename(tmp, dst)
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/1e9)
	case n >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(n)/1e6)
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/1e3)
	}
	return fmt.Sprintf("%d B", n)
}

// ---------------------------------------------------------------------------- the backend

// backend is the llama-server running the loaded model (one at a time, as on a small machine).
type backend struct {
	mu       sync.Mutex
	cmd      *exec.Cmd
	model    *model
	ctx      int
	port     int
	loadedAt time.Time
	done     chan struct{}
	log      *tailBuffer
}

var llama = &backend{port: 11435}

// ensure starts llama-server for m (stopping another model's) and waits until it answers.
func (b *backend) ensure(ctx context.Context, m *model, numCtx int) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if numCtx <= 0 {
		numCtx = 2048
		if v, err := strconv.Atoi(os.Getenv("OLLAMA_CONTEXT_LENGTH")); err == nil && v > 0 {
			numCtx = v
		}
	}
	if b.cmd != nil && b.model.gguf == m.gguf && b.ctx == numCtx {
		select {
		case <-b.done:
		default:
			return nil
		}
	}
	b.stopLocked()
	bin := os.Getenv("LLAMA_SERVER")
	if bin == "" {
		bin = "llama-server"
	}
	extra := strings.Fields(os.Getenv("LLAMA_ARGS"))
	if os.Getenv("LLAMA_ARGS") == "" {
		extra = defaultArgs()
	}
	args := append([]string{"-m", m.gguf, "--host", "127.0.0.1", "--port", strconv.Itoa(b.port),
		"-c", strconv.Itoa(numCtx), "--no-webui", "-np", "1"}, extra...)
	cmd := exec.Command(bin, args...)
	b.log = &tailBuffer{max: 16 << 10}
	cmd.Stdout, cmd.Stderr = b.log, b.log
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting %s: %w", bin, err)
	}
	b.cmd, b.model, b.ctx, b.done = cmd, m, numCtx, make(chan struct{})
	done := b.done
	go func() { _ = cmd.Wait(); close(done) }()
	// Loading a model can take a while (in a browser its file comes over the network first)
	for {
		select {
		case <-done:
			b.cmd = nil
			return fmt.Errorf("llama-server exited while loading %s:\n%s", m.ref.short(), b.log.String())
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
		resp, err := http.Get(b.url("/health"))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				b.loadedAt = time.Now()
				return nil
			}
		}
	}
}

// defaultArgs puts every layer on the GPU. Where a GPU llama.cpp can use answers (armless's
// gpu.internal), one CPU thread: the rest would only spin waiting for it, taking the CPUs from
// everything else (on an emulated CPU that cost 100 times the speed). Without one, llama.cpp's own
// choice of threads.
func defaultArgs() []string {
	args := []string{"-ngl", "99"}
	if gpuUsable(gpuAddr()) {
		args = append(args, "-t", "1")
	}
	return args
}

// gpuUsable asks armless's GPU what it has (armless-gpu's Hello) and says whether llama.cpp's
// WebGPU backend can use it: it needs shader-f16.
func gpuUsable(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	// A frame: u32 length, op 1 (Hello), u32 version 2
	if _, err := c.Write([]byte{5, 0, 0, 0, 1, 2, 0, 0, 0}); err != nil {
		return false
	}
	var head [4]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return false
	}
	n := int(head[0]) | int(head[1])<<8 | int(head[2])<<16 | int(head[3])<<24
	if n > 1<<20 {
		return false
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(c, body); err != nil || n < 1 || body[0] != 0 {
		return false
	}
	// OK, u32 version, str adapter, str backend, u64, u64, u32, then u32 features (bit 0: f16)
	p := body[1:]
	skip := func(k int) bool {
		if len(p) < k {
			return false
		}
		p = p[k:]
		return true
	}
	str := func() bool {
		if len(p) < 4 {
			return false
		}
		k := int(p[0]) | int(p[1])<<8 | int(p[2])<<16 | int(p[3])<<24
		return skip(4) && skip(k)
	}
	if !skip(4) || !str() || !str() || !skip(8+8+4) || len(p) < 4 {
		return false
	}
	return p[0]&1 != 0
}

func gpuAddr() string {
	if a := os.Getenv("ARMLESS_GPU"); a != "" {
		return a
	}
	return "gpu.internal:7070"
}

func (b *backend) stopLocked() {
	if b.cmd != nil && b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
		<-b.done
	}
	b.cmd, b.model = nil, nil
}

func (b *backend) url(path string) string {
	return "http://127.0.0.1:" + strconv.Itoa(b.port) + path
}

func (b *backend) loaded() (*model, time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cmd == nil {
		return nil, time.Time{}
	}
	return b.model, b.loadedAt
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// ------------------------------------------------------------------------------- the API

type options struct {
	Temperature   *float64 `json:"temperature,omitempty"`
	TopP          *float64 `json:"top_p,omitempty"`
	TopK          *int     `json:"top_k,omitempty"`
	MinP          *float64 `json:"min_p,omitempty"`
	NumPredict    *int     `json:"num_predict,omitempty"`
	NumCtx        int      `json:"num_ctx,omitempty"`
	Seed          *int     `json:"seed,omitempty"`
	Stop          []string `json:"stop,omitempty"`
	RepeatPenalty *float64 `json:"repeat_penalty,omitempty"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
	Stream   *bool     `json:"stream,omitempty"`
	Options  options   `json:"options"`
	Format   any       `json:"format,omitempty"`
}

type generateRequest struct {
	Model   string  `json:"model"`
	Prompt  string  `json:"prompt"`
	System  string  `json:"system,omitempty"`
	Raw     bool    `json:"raw,omitempty"`
	Stream  *bool   `json:"stream,omitempty"`
	Options options `json:"options"`
}

func serve(addr string, ready chan<- error) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, "Ollama is running")
	})
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"version": version})
	})
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		var models []map[string]any
		for _, m := range allModels() {
			models = append(models, describe(m))
		}
		writeJSON(w, 200, map[string]any{"models": models})
	})
	mux.HandleFunc("/api/ps", func(w http.ResponseWriter, r *http.Request) {
		models := []map[string]any{}
		if m, _ := llama.loaded(); m != nil {
			d := describe(m)
			d["size_vram"] = m.size
			d["expires_at"] = time.Now().Add(24 * time.Hour).Format(time.RFC3339)
			models = append(models, d)
		}
		writeJSON(w, 200, map[string]any{"models": models})
	})
	mux.HandleFunc("/api/show", handleShow)
	mux.HandleFunc("/api/pull", handlePull)
	mux.HandleFunc("/api/generate", handleGenerate)
	mux.HandleFunc("/api/chat", handleChat)
	mux.HandleFunc("/v1/", handleOpenAI)
	ln, err := net.Listen("tcp", addr)
	if ready != nil {
		ready <- err
	}
	if err != nil {
		return err
	}
	return http.Serve(ln, mux)
}

func describe(m *model) map[string]any {
	family, _ := m.params["family"].(string)
	return map[string]any{
		"name":        m.ref.short(),
		"model":       m.ref.short(),
		"modified_at": m.modified.Format(time.RFC3339Nano),
		"size":        m.size,
		"digest":      m.digest,
		"details":     map[string]any{"format": "gguf", "family": family, "parent_model": ""},
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func handleShow(w http.ResponseWriter, r *http.Request) {
	var req struct{ Model, Name string }
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := req.Model
	if name == "" {
		name = req.Name
	}
	m, err := loadModel(name)
	if err != nil {
		apiError(w, 404, err)
		return
	}
	var params []string
	for k, v := range m.params {
		params = append(params, fmt.Sprintf("%s %v", k, v))
	}
	sort.Strings(params)
	modelfile := fmt.Sprintf("FROM %s\nTEMPLATE %q\n", m.gguf, m.template)
	if m.system != "" {
		modelfile += fmt.Sprintf("SYSTEM %q\n", m.system)
	}
	for _, p := range params {
		modelfile += "PARAMETER " + p + "\n"
	}
	d := describe(m)
	writeJSON(w, 200, map[string]any{
		"modelfile": modelfile, "parameters": strings.Join(params, "\n"), "template": m.template,
		"system": m.system, "license": m.license, "details": d["details"], "modified_at": d["modified_at"],
		"model_info": map[string]any{}, "capabilities": []string{"completion"},
	})
}

// handlePull answers for models already here; pulling at run time would need the registry
// reachable from the guest (it is pulled at build time instead).
func handlePull(w http.ResponseWriter, r *http.Request) {
	var req struct{ Model, Name string }
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := req.Model
	if name == "" {
		name = req.Name
	}
	if _, err := loadModel(name); err == nil {
		writeJSON(w, 200, map[string]string{"status": "success"})
		return
	}
	if err := pull(name, io.Discard); err != nil {
		apiError(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "success"})
}

// llamaParams is what llama-server's chat and completion endpoints take for Ollama's options.
func llamaParams(o options, m *model) map[string]any {
	p := map[string]any{}
	// The model's own defaults (its Modelfile's PARAMETERs), then the request's
	for k, v := range m.params {
		switch k {
		case "temperature", "top_p", "top_k", "min_p", "seed", "repeat_penalty":
			p[k] = v
		case "stop":
			p["stop"] = v
		}
	}
	set := func(k string, v any) { p[k] = v }
	if o.Temperature != nil {
		set("temperature", *o.Temperature)
	}
	if o.TopP != nil {
		set("top_p", *o.TopP)
	}
	if o.TopK != nil {
		set("top_k", *o.TopK)
	}
	if o.MinP != nil {
		set("min_p", *o.MinP)
	}
	if o.Seed != nil {
		set("seed", *o.Seed)
	}
	if o.RepeatPenalty != nil {
		set("repeat_penalty", *o.RepeatPenalty)
	}
	if len(o.Stop) > 0 {
		set("stop", o.Stop)
	}
	if o.NumPredict != nil {
		set("n_predict", *o.NumPredict)
		set("max_tokens", *o.NumPredict)
	}
	return p
}

// stream sends a request to llama-server and calls each for every server-sent event's JSON.
func stream(ctx context.Context, path string, body map[string]any, each func(map[string]any) error) error {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", llama.url(path), bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("llama-server: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if line == "[DONE]" {
			return nil
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		if e, ok := ev["error"]; ok {
			return fmt.Errorf("llama-server: %v", e)
		}
		if err := each(ev); err != nil {
			return err
		}
	}
	return sc.Err()
}

// ndjson writes Ollama's streamed responses: one JSON object a line, flushed as it goes (or,
// with stream false, only the last, with the text accumulated).
type ndjson struct {
	w       http.ResponseWriter
	stream  bool
	started bool
}

func (n *ndjson) send(v map[string]any) {
	if !n.started {
		ct := "application/json; charset=utf-8"
		if n.stream {
			ct = "application/x-ndjson"
		}
		n.w.Header().Set("Content-Type", ct)
		n.w.WriteHeader(200)
		n.started = true
	}
	_ = json.NewEncoder(n.w).Encode(v)
	if f, ok := n.w.(http.Flusher); ok {
		f.Flush()
	}
}

func timings(start, loaded time.Time, ev map[string]any, promptN, evalN int) map[string]any {
	out := map[string]any{
		"total_duration": time.Since(start).Nanoseconds(),
		"load_duration":  loaded.Sub(start).Nanoseconds(),
	}
	if t, ok := ev["timings"].(map[string]any); ok {
		if v, ok := t["prompt_n"].(float64); ok {
			promptN = int(v)
		}
		if v, ok := t["predicted_n"].(float64); ok {
			evalN = int(v)
		}
		if v, ok := t["prompt_ms"].(float64); ok {
			out["prompt_eval_duration"] = int64(v * 1e6)
		}
		if v, ok := t["predicted_ms"].(float64); ok {
			out["eval_duration"] = int64(v * 1e6)
		}
	}
	out["prompt_eval_count"] = promptN
	out["eval_count"] = evalN
	return out
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apiError(w, 400, err)
		return
	}
	chat(w, r, req)
}

func chat(w http.ResponseWriter, r *http.Request, req chatRequest) {
	start := time.Now()
	m, err := loadModel(req.Model)
	if err != nil {
		apiError(w, 404, err)
		return
	}
	if err := llama.ensure(r.Context(), m, req.Options.NumCtx); err != nil {
		apiError(w, 500, err)
		return
	}
	loaded := time.Now()
	out := &ndjson{w: w, stream: req.Stream == nil || *req.Stream}
	if len(req.Messages) == 0 {
		// Ollama loads the model for an empty chat and says it is done
		out.send(map[string]any{"model": m.ref.short(), "created_at": now(), "message": message{Role: "assistant"}, "done_reason": "load", "done": true})
		return
	}
	msgs := req.Messages
	if m.system != "" && msgs[0].Role != "system" {
		msgs = append([]message{{Role: "system", Content: m.system}}, msgs...)
	}
	body := llamaParams(req.Options, m)
	body["messages"] = msgs
	body["stream"] = true
	body["timings_per_token"] = false
	body["stream_options"] = map[string]any{"include_usage": true}
	var text strings.Builder
	reason := "stop"
	var last map[string]any
	err = stream(r.Context(), "/v1/chat/completions", body, func(ev map[string]any) error {
		last = ev
		choices, _ := ev["choices"].([]any)
		if len(choices) == 0 {
			return nil
		}
		c, _ := choices[0].(map[string]any)
		if fr, ok := c["finish_reason"].(string); ok && fr != "" {
			reason = fr
		}
		delta, _ := c["delta"].(map[string]any)
		piece, _ := delta["content"].(string)
		if piece == "" {
			return nil
		}
		text.WriteString(piece)
		if out.stream {
			out.send(map[string]any{"model": m.ref.short(), "created_at": now(), "message": message{Role: "assistant", Content: piece}, "done": false})
		}
		return nil
	})
	if err != nil {
		if !out.started {
			apiError(w, 500, err)
		}
		return
	}
	final := map[string]any{"model": m.ref.short(), "created_at": now(), "message": message{Role: "assistant"}, "done": true, "done_reason": ollamaReason(reason)}
	if !out.stream {
		final["message"] = message{Role: "assistant", Content: text.String()}
	}
	for k, v := range timings(start, loaded, last, 0, 0) {
		final[k] = v
	}
	if u, ok := last["usage"].(map[string]any); ok {
		if v, ok := u["prompt_tokens"].(float64); ok {
			final["prompt_eval_count"] = int(v)
		}
		if v, ok := u["completion_tokens"].(float64); ok {
			final["eval_count"] = int(v)
		}
	}
	out.send(final)
}

func ollamaReason(r string) string {
	if r == "length" {
		return "length"
	}
	return "stop"
}

func handleGenerate(w http.ResponseWriter, r *http.Request) {
	var req generateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apiError(w, 400, err)
		return
	}
	start := time.Now()
	m, err := loadModel(req.Model)
	if err != nil {
		apiError(w, 404, err)
		return
	}
	if !req.Raw {
		// Through the model's chat template, as Ollama's template does for a prompt
		if req.Prompt == "" {
			if err := llama.ensure(r.Context(), m, req.Options.NumCtx); err != nil {
				apiError(w, 500, err)
				return
			}
			writeJSON(w, 200, map[string]any{"model": m.ref.short(), "created_at": now(), "response": "", "done": true, "done_reason": "load"})
			return
		}
		var msgs []message
		if req.System != "" {
			msgs = append(msgs, message{Role: "system", Content: req.System})
		}
		msgs = append(msgs, message{Role: "user", Content: req.Prompt})
		gw := &generateWriter{ResponseWriter: w}
		chat(gw, r, chatRequest{Model: req.Model, Messages: msgs, Stream: req.Stream, Options: req.Options})
		return
	}
	if err := llama.ensure(r.Context(), m, req.Options.NumCtx); err != nil {
		apiError(w, 500, err)
		return
	}
	loaded := time.Now()
	out := &ndjson{w: w, stream: req.Stream == nil || *req.Stream}
	body := llamaParams(req.Options, m)
	body["prompt"] = req.Prompt
	body["stream"] = true
	var text strings.Builder
	var last map[string]any
	reason := "stop"
	err = stream(r.Context(), "/completion", body, func(ev map[string]any) error {
		last = ev
		piece, _ := ev["content"].(string)
		if stop, _ := ev["stop"].(bool); stop {
			if t, _ := ev["stop_type"].(string); t == "limit" {
				reason = "length"
			}
		}
		if piece == "" {
			return nil
		}
		text.WriteString(piece)
		if out.stream {
			out.send(map[string]any{"model": m.ref.short(), "created_at": now(), "response": piece, "done": false})
		}
		return nil
	})
	if err != nil {
		if !out.started {
			apiError(w, 500, err)
		}
		return
	}
	final := map[string]any{"model": m.ref.short(), "created_at": now(), "response": "", "done": true, "done_reason": reason}
	if !out.stream {
		final["response"] = text.String()
	}
	for k, v := range timings(start, loaded, last, 0, 0) {
		final[k] = v
	}
	out.send(final)
}

// generateWriter turns /api/chat's responses into /api/generate's: message.content becomes
// response.
type generateWriter struct {
	http.ResponseWriter
	buf []byte
}

func (g *generateWriter) Write(p []byte) (int, error) {
	g.buf = append(g.buf, p...)
	for {
		i := bytes.IndexByte(g.buf, '\n')
		if i < 0 {
			return len(p), nil
		}
		line := g.buf[:i]
		g.buf = g.buf[i+1:]
		var v map[string]any
		if err := json.Unmarshal(line, &v); err == nil {
			if msg, ok := v["message"].(map[string]any); ok {
				v["response"], _ = msg["content"].(string)
				delete(v, "message")
			}
			line, _ = json.Marshal(v)
		}
		if _, err := g.ResponseWriter.Write(append(line, '\n')); err != nil {
			return 0, err
		}
	}
}

func (g *generateWriter) Flush() {
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// handleOpenAI passes OpenAI's API (which Ollama serves too) to llama-server, after loading the
// model the request names.
func handleOpenAI(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var req struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(body, &req)
	name := req.Model
	if name == "" {
		if m, _ := llama.loaded(); m != nil {
			name = m.ref.short()
		} else if ms := allModels(); len(ms) > 0 {
			name = ms[0].ref.short()
		}
	}
	if r.URL.Path == "/v1/models" {
		var data []map[string]any
		for _, m := range allModels() {
			data = append(data, map[string]any{"id": m.ref.short(), "object": "model", "created": m.modified.Unix(), "owned_by": m.ref.namespace})
		}
		writeJSON(w, 200, map[string]any{"object": "list", "data": data})
		return
	}
	m, err := loadModel(name)
	if err != nil {
		apiError(w, 404, err)
		return
	}
	if err := llama.ensure(r.Context(), m, 0); err != nil {
		apiError(w, 500, err)
		return
	}
	target, _ := url.Parse(llama.url(""))
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	proxy.ServeHTTP(w, r)
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// ------------------------------------------------------------------------------- the CLI

func list() error {
	ms := allModels()
	fmt.Printf("%-32s %-14s %-9s %s\n", "NAME", "ID", "SIZE", "MODIFIED")
	for _, m := range ms {
		fmt.Printf("%-32s %-14s %-9s %s\n", m.ref.short(), m.digest[:12], humanSize(m.size), m.modified.Format("2006-01-02 15:04"))
	}
	return nil
}

// run is a chat in the terminal, as `ollama run` has. It serves the API itself when nothing
// answers at OLLAMA_HOST, and loads the model only with the first message, so a snapshot taken at
// its prompt holds no GPU state.
func run(name, prompt string) error {
	if _, err := loadModel(name); err != nil {
		return err
	}
	addr := hostAddr()
	if c, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		c.Close()
	} else {
		ready := make(chan error, 1)
		go func() { _ = serve(addr, ready) }()
		if err := <-ready; err != nil {
			return err
		}
	}
	base := "http://" + addr
	var history []message
	say := func(text string) error {
		history = append(history, message{Role: "user", Content: text})
		if m, _ := llama.loaded(); m == nil {
			fmt.Printf("(loading %s on the GPU…)\n", name)
		}
		body, _ := json.Marshal(chatRequest{Model: name, Messages: history})
		resp, err := http.Post(base+"/api/chat", "application/json", bytes.NewReader(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			b, _ := io.ReadAll(resp.Body)
			var e struct{ Error string }
			_ = json.Unmarshal(b, &e)
			history = history[:len(history)-1]
			return errors.New(e.Error)
		}
		var reply strings.Builder
		dec := json.NewDecoder(resp.Body)
		for {
			var ev struct {
				Message      message `json:"message"`
				Done         bool    `json:"done"`
				EvalCount    int     `json:"eval_count"`
				EvalDuration int64   `json:"eval_duration"`
			}
			if err := dec.Decode(&ev); err != nil {
				if err == io.EOF {
					break
				}
				return err
			}
			fmt.Print(ev.Message.Content)
			reply.WriteString(ev.Message.Content)
			if ev.Done {
				fmt.Println()
				if ev.EvalDuration > 0 && os.Getenv("OLLAMA_VERBOSE") != "" {
					fmt.Printf("eval rate: %.2f tokens/s\n", float64(ev.EvalCount)/(float64(ev.EvalDuration)/1e9))
				}
				break
			}
		}
		history = append(history, message{Role: "assistant", Content: reply.String()})
		return nil
	}
	if prompt != "" {
		return say(prompt)
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<20)
	for {
		fmt.Print(">>> ")
		if !in.Scan() {
			fmt.Println()
			return nil
		}
		line := strings.TrimSpace(in.Text())
		switch {
		case line == "":
			continue
		case line == "/bye" || line == "/exit":
			return nil
		case line == "/clear":
			history = nil
			fmt.Println("Cleared session context")
			continue
		case line == "/?" || line == "/help":
			fmt.Println("  /clear   forget the conversation\n  /bye     exit")
			continue
		}
		if err := say(line); err != nil {
			fmt.Println("Error:", err)
		}
	}
}
