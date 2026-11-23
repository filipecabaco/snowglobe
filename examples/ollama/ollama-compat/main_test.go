package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The test binary stands in for llama-server when started with FAKE_LLAMA=1: /health, and the
// two streaming endpoints, each saying "Hello" and " world".
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_LLAMA") == "1" {
		fakeLlama()
		return
	}
	os.Exit(m.Run())
}

func fakeLlama() {
	port := "11435"
	for i, a := range os.Args {
		if a == "--port" {
			port = os.Args[i+1]
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"status":"ok"}`) })
	sse := func(w http.ResponseWriter, events ...string) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range events {
			fmt.Fprintf(w, "data: %s\n\n", e)
		}
	}
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		msgs, _ := body["messages"].([]any)
		sse(w,
			`{"choices":[{"delta":{"content":"Hello"}}]}`,
			fmt.Sprintf(`{"choices":[{"delta":{"content":" world (%d)"}}]}`, len(msgs)),
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2},"timings":{"prompt_n":7,"predicted_n":2,"prompt_ms":10,"predicted_ms":20}}`,
			`[DONE]`)
	})
	mux.HandleFunc("/completion", func(w http.ResponseWriter, r *http.Request) {
		sse(w, `{"content":"raw","stop":false}`, `{"content":"","stop":true,"stop_type":"eos","timings":{"prompt_n":3,"predicted_n":1}}`)
	})
	_ = http.ListenAndServe("127.0.0.1:"+port, mux)
}

// A model in Ollama's layout under a temporary OLLAMA_MODELS, and the API serving it.
func setup(t *testing.T) string {
	dir := t.TempDir()
	t.Setenv("OLLAMA_MODELS", dir)
	t.Setenv("LLAMA_SERVER", os.Args[0])
	t.Setenv("FAKE_LLAMA", "1")
	blob := func(data, media string) layer {
		d := fmt.Sprintf("sha256:%064x", len(data)+len(media))
		os.MkdirAll(filepath.Join(dir, "blobs"), 0o755)
		os.WriteFile(blobPath(d), []byte(data), 0o644)
		return layer{MediaType: media, Digest: d, Size: int64(len(data))}
	}
	m := manifest{SchemaVersion: 2, Layers: []layer{
		blob("GGUF....", "application/vnd.ollama.image.model"),
		blob("{{ .Prompt }}", "application/vnd.ollama.image.template"),
		blob(`{"temperature":0.2,"stop":["<end>"]}`, "application/vnd.ollama.image.params"),
	}}
	data, _ := json.Marshal(m)
	r := parseRef("tiny:1b")
	os.MkdirAll(filepath.Dir(r.manifestPath()), 0o755)
	os.WriteFile(r.manifestPath(), data, 0o644)

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	llama.port = freePort(t)
	ready := make(chan error, 1)
	go serve(addr, ready)
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { llama.mu.Lock(); llama.stopLocked(); llama.mu.Unlock() })
	return "http://" + addr
}

func freePort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func lines(t *testing.T, resp *http.Response) []map[string]any {
	t.Helper()
	defer resp.Body.Close()
	var out []map[string]any
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var v map[string]any
		if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
			t.Fatalf("not NDJSON: %q", sc.Text())
		}
		out = append(out, v)
	}
	return out
}

func TestRefsAreParsedAsOllamaDoes(t *testing.T) {
	for in, want := range map[string]string{
		"smollm2:135m":          "registry.ollama.ai/library/smollm2:135m",
		"qwen3":                 "registry.ollama.ai/library/qwen3:latest",
		"someone/model:q4":      "registry.ollama.ai/someone/model:q4",
		"hf.co/org/repo:Q4_K_M": "hf.co/org/repo:Q4_K_M",
	} {
		r := parseRef(in)
		if got := r.host + "/" + r.namespace + "/" + r.model + ":" + r.tag; got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
	if s := parseRef("smollm2:135m").short(); s != "smollm2:135m" {
		t.Errorf("short: %s", s)
	}
}

func TestTagsListThePulledModels(t *testing.T) {
	base := setup(t)
	resp, err := http.Get(base + "/api/tags")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Models []struct{ Name string } }
	json.NewDecoder(resp.Body).Decode(&v)
	if len(v.Models) != 1 || v.Models[0].Name != "tiny:1b" {
		t.Fatalf("%+v", v)
	}
}

func TestChatStreamsNDJSONAndEndsWithCounts(t *testing.T) {
	base := setup(t)
	resp, err := http.Post(base+"/api/chat", "application/json",
		strings.NewReader(`{"model":"tiny:1b","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-ndjson" {
		t.Errorf("content type %q", ct)
	}
	ls := lines(t, resp)
	var text strings.Builder
	for _, l := range ls[:len(ls)-1] {
		text.WriteString(l["message"].(map[string]any)["content"].(string))
	}
	last := ls[len(ls)-1]
	if text.String() != "Hello world (1)" || last["done"] != true || last["eval_count"] != 2.0 || last["prompt_eval_count"] != 7.0 {
		t.Fatalf("text %q, last %v", text.String(), last)
	}
}

func TestChatWithoutStreamingIsOneObject(t *testing.T) {
	base := setup(t)
	resp, _ := http.Post(base+"/api/chat", "application/json",
		strings.NewReader(`{"model":"tiny:1b","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	ls := lines(t, resp)
	if len(ls) != 1 || ls[0]["message"].(map[string]any)["content"] != "Hello world (1)" {
		t.Fatalf("%v", ls)
	}
}

func TestGenerateGoesThroughTheChatTemplateUnlessRaw(t *testing.T) {
	base := setup(t)
	resp, _ := http.Post(base+"/api/generate", "application/json", strings.NewReader(`{"model":"tiny:1b","prompt":"hi","system":"be brief","stream":false}`))
	ls := lines(t, resp)
	if len(ls) != 1 || ls[0]["response"] != "Hello world (2)" {
		t.Fatalf("chat path: %v", ls)
	}
	resp, _ = http.Post(base+"/api/generate", "application/json", strings.NewReader(`{"model":"tiny:1b","prompt":"hi","raw":true}`))
	ls = lines(t, resp)
	if ls[0]["response"] != "raw" || ls[len(ls)-1]["done"] != true {
		t.Fatalf("raw path: %v", ls)
	}
}

func TestAnUnknownModelIsA404(t *testing.T) {
	base := setup(t)
	resp, _ := http.Post(base+"/api/chat", "application/json", strings.NewReader(`{"model":"nope","messages":[{"role":"user","content":"hi"}]}`))
	if resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestPsShowsTheLoadedModel(t *testing.T) {
	base := setup(t)
	http.Post(base+"/api/generate", "application/json", strings.NewReader(`{"model":"tiny:1b"}`))
	resp, _ := http.Get(base + "/api/ps")
	var v struct{ Models []struct{ Name string } }
	json.NewDecoder(resp.Body).Decode(&v)
	if len(v.Models) != 1 || v.Models[0].Name != "tiny:1b" {
		t.Fatalf("%+v", v)
	}
}

// A stand-in for armless's GPU: answers Hello with the given feature bits.
func fakeGPU(t *testing.T, features uint32) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			buf := make([]byte, 9)
			if _, err := io.ReadFull(c, buf); err != nil {
				c.Close()
				continue
			}
			le32 := func(v uint32) []byte { return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)} }
			str := func(s string) []byte { return append(le32(uint32(len(s))), s...) }
			body := []byte{0}
			body = append(body, le32(2)...)
			body = append(body, str("fake adapter")...)
			body = append(body, str("WebGPU")...)
			body = append(body, make([]byte, 8+8+4)...)
			body = append(body, le32(features)...)
			c.Write(append(le32(uint32(len(body))), body...))
			c.Close()
		}
	}()
	return ln.Addr().String()
}

func TestTheGPUIsUsedOnlyWithShaderF16(t *testing.T) {
	if !gpuUsable(fakeGPU(t, 1|2)) {
		t.Error("f16 and subgroups: not usable")
	}
	if gpuUsable(fakeGPU(t, 2)) {
		t.Error("no f16: usable")
	}
	if gpuUsable("127.0.0.1:1") {
		t.Error("nothing listening: usable")
	}
}
