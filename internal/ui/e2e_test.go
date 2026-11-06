//go:build e2e

// End-to-end: the real page (packed, as the binary serves it) in a headless Chrome driven over
// the DevTools protocol (chromedp: Go, no Node), against a fake daemon API. It needs Chrome:
//
//	go test -tags e2e ./internal/ui
package ui

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
)

// A daemon with one fleet in two instances, as the UI sees it
type fakeDaemon struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path+" "+string(body))
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	now := time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339)
	machine := func(name, tpl, svc, inst string) string {
		return fmt.Sprintf(`{"name":%q,"template":%q,"created":%q,"labels":{"snowglobe.service":%q,"snowglobe.fleet":"todo","snowglobe.instance":%q}}`, name, tpl, now, svc, inst)
	}
	switch {
	case r.URL.Path == "/v1/events":
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		<-r.Context().Done()
	case r.URL.Path == "/v1/stats":
		io.WriteString(w, `{"machines":4,"memory_used":104857600,"memory_budget":0,"memory":{}}`)
	case r.URL.Path == "/v1/metrics":
		fmt.Fprintf(w, `{"samples":[],"totals":{"started":%q},"every_ms":5000}`, now)
	case r.URL.Path == "/v1/templates":
		fmt.Fprintf(w, `[{"name":"app","site":"/sites/app","egress":"internet","started":%q},{"name":"db","site":"/sites/db","egress":"none","started":%q}]`, now, now)
	case r.URL.Path == "/v1/machines":
		io.WriteString(w, "["+strings.Join([]string{machine("app-r1", "app", "app", "main"), machine("db-r1", "db", "db", "main"),
			machine("app-2-r1", "app", "app-2", "2"), machine("db-2-r1", "db", "db-2", "2")}, ",")+"]")
	case r.URL.Path == "/v1/services":
		fmt.Fprintf(w, `[{"name":"db","template":"db","min":1,"max":1,"idle":"5m0s","state":"discard","ports":[{"ip":"127.0.0.1","host":15432,"guest":5432}],"labels":{"snowglobe.fleet":"todo","snowglobe.instance":"main"},"replicas":[{"machine":"db-r1"}],"created":%q}]`, now)
	case r.URL.Path == "/v1/graph":
		io.WriteString(w, `{"nodes":[
			{"id":"template:app","kind":"template","name":"app","state":"live"},
			{"id":"template:db","kind":"template","name":"db","state":"live"},
			{"id":"service:db","kind":"service","name":"db","state":"live","template":"db","detail":"1 of 1–1 replicas","fleet":"todo","instance":"main"},
			{"id":"machine:app-r1","kind":"machine","name":"app-r1","state":"live","template":"app","fleet":"todo","instance":"main"},
			{"id":"machine:db-r1","kind":"machine","name":"db-r1","state":"live","template":"db","labels":{"snowglobe.service":"db"}},
			{"id":"machine:app-2-r1","kind":"machine","name":"app-2-r1","state":"live","template":"app","fleet":"todo","instance":"2"},
			{"id":"machine:db-2-r1","kind":"machine","name":"db-2-r1","state":"live","template":"db","fleet":"todo","instance":"2"},
			{"id":"port:127.0.0.1:15432","kind":"port","name":"127.0.0.1:15432","state":"live","detail":"to service db:5432"}],
		"edges":[
			{"from":"service:db","to":"machine:db-r1","kind":"replica"},
			{"from":"port:127.0.0.1:15432","to":"service:db","kind":"port","label":"15432→5432"},
			{"from":"template:app","to":"service:db","kind":"link","label":"db.internal:5432","link":"app-db"},
			{"from":"machine:app-r1","to":"service:db","kind":"reach","label":"db.internal:5432","link":"app-db"},
			{"from":"machine:app-2-r1","to":"machine:db-2-r1","kind":"reach","label":"db.internal:5432","link":"app-db-2"}]}`)
	case r.URL.Path == "/v1/links":
		if r.Method == "POST" {
			io.WriteString(w, `{"name":"app-r1-db-r1-6379","from":"app-r1","to":"db-r1","port":6379,"as":"db-r1","as_port":6379}`)
			return
		}
		io.WriteString(w, `[{"name":"app-db","from":"app","from_kind":"template","to":"db","to_kind":"service","port":5432,"as":"db.internal","as_port":5432,"instance":"main"}]`)
	case r.URL.Path == "/v1/fleets":
		io.WriteString(w, `[{"name":"todo","file":"/fleets/todo/snowglobe.toml","objects":8,"pending":1,"instances":["main","2"]}]`)
	case r.URL.Path == "/v1/fleets/todo":
		io.WriteString(w, `{"name":"todo","file":"/fleets/todo/snowglobe.toml","instances":["main","2"],"text":"name = \"todo\"\n",
			"plan":{"fleet":"todo","instance":"main","file":"/fleets/todo/snowglobe.toml","unchanged":4,
			"steps":[{"action":"create","kind":"machine","name":"worker","key":"machine/worker","deps":["template/app"],"ready":true,"per_instance":true,"detail":"app × 1"}]}}`)
	case r.URL.Path == "/v1/fleets/todo/apply":
		io.WriteString(w, `{"log":["+ machine worker (12ms)"],"plan":{"fleet":"todo","instance":"main","steps":[],"unchanged":5}}`)
	default:
		io.WriteString(w, `[]`)
	}
}

func (f *fakeDaemon) called(prefix string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return c
		}
	}
	return ""
}

func TestThePageInChrome(t *testing.T) {
	api := &fakeDaemon{}
	s := &Server{API: api, Token: NewToken()}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	// localhost, as snowglobe ui serves it (the handler refuses other hosts)
	base := strings.Replace(ts.URL, "127.0.0.1", "localhost", 1)

	opts := append(chromedp.DefaultExecAllocatorOptions[:], chromedp.WindowSize(1440, 1000))
	// Ubuntu 24.04's AppArmor refuses Chrome the user namespaces its sandbox needs, and Chrome
	// aborts at start: on CI (a throwaway runner, a page of our own) it runs without one
	if os.Getenv("CI") != "" {
		opts = append(opts, chromedp.NoSandbox)
	}
	actx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()
	ctx, cancel := chromedp.NewContext(actx)
	defer cancel()
	go func() {
		<-time.After(90 * time.Second)
		cancel()
	}()
	do := func(what string, steps ...chromedp.Action[chromedp.Void]) {
		t.Helper()
		if err := chromedp.Do(ctx, steps...); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	eval := func(expr string) int {
		t.Helper()
		v, err := chromedp.Run(ctx, chromedp.Evaluate[int](expr))
		if err != nil {
			t.Fatalf("%s: %v", expr, err)
		}
		return v
	}
	text := func(sel string) string {
		t.Helper()
		v, err := chromedp.Run(ctx, chromedp.Text(chromedp.CSS(sel)))
		if err != nil {
			t.Fatalf("text of %s: %v", sel, err)
		}
		return v
	}
	css := func(sel string) chromedp.CSS { return chromedp.CSS(sel) }

	// The browser starts; from then on every exception, console error and browser-log error
	// (a refused script or style under the page's CSP among them) is kept
	do("start", chromedp.Navigate("about:blank"))
	var mu sync.Mutex
	var errs []string
	messages := chromedp.Console(ctx)
	go func() {
		for m, err := range messages {
			if err != nil {
				return
			}
			if m.IsException() || m.Type == chromedp.ConsoleError {
				mu.Lock()
				errs = append(errs, m.String()+" "+m.URL)
				mu.Unlock()
			}
		}
	}()

	do("open the link", chromedp.Navigate(base+"/?token="+s.Token), chromedp.WaitVisible(css("#overview-title")))

	// Network: the plan's rule, each instance's group, real reaches, the port on what it opens
	do("network", chromedp.Navigate(base+"/#network"), chromedp.WaitVisible(css(`[data-node="machine:app-2-r1"]`)))
	nodes, reaches, rules := eval(`document.querySelectorAll(".graph .node").length`), eval(`document.querySelectorAll(".edge.reach").length`), eval(`document.querySelectorAll(".edge.rule").length`)
	if nodes != 7 || reaches != 2 || rules != 1 {
		t.Errorf("graph: %d nodes, %d reaches, %d rules", nodes, reaches, rules)
	}
	graph := text(".graph")
	for _, want := range []string{"instance main", "instance 2", ":15432", "db.internal:5432"} {
		if !strings.Contains(graph, want) {
			t.Errorf("the graph doesn't say %q: %q", want, graph)
		}
	}
	// Only one view shows
	if n := eval(`[...document.querySelectorAll("[data-view]")].filter(s => !s.hidden).length`); n != 1 {
		t.Errorf("%d views show", n)
	}

	// Select a machine; link it from the inspector
	do("select and link",
		chromedp.Click(css(`[data-node="machine:app-r1"] .node-body`)),
		chromedp.WaitVisible(css(`.link-form`)),
		chromedp.SetValue(css(`.link-form select`), "machine:db-r1"),
		chromedp.Evaluate[chromedp.Void](`document.querySelector(".link-form select").dispatchEvent(new Event("change", {bubbles: true}))`),
		chromedp.SendKeys(css(`.link-form input[type=number]`), "6379"),
		chromedp.Click(css(`.link-form button[type=submit]`)),
		chromedp.WaitVisible(css(`#inspect-graph .said`)),
	)
	if c := api.called("POST /v1/links"); !strings.Contains(c, `"from":"app-r1"`) || !strings.Contains(c, `"to":"db-r1"`) || !strings.Contains(c, `"port":6379`) {
		t.Errorf("the link asked for: %q", c)
	}

	// Fleets: the fleet's instances and its one step, applied on its own
	do("fleets", chromedp.Navigate(base+"/#fleets"), chromedp.WaitVisible(css(`.steps li`)))
	fleet := text(".fleet")
	for _, want := range []string{"main", "2", "machine worker", "Start another instance"} {
		if !strings.Contains(fleet, want) {
			t.Errorf("the fleet doesn't say %q: %q", want, fleet)
		}
	}
	do("apply a step", chromedp.Click(css(`.steps li .btn`)), chromedp.WaitVisible(css(`.plan-log`)))
	if c := api.called("POST /v1/fleets/todo/apply"); !strings.Contains(c, `"step":"machine/worker"`) || !strings.Contains(c, `"instance":"main"`) {
		t.Errorf("the step applied: %q", c)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, e := range errs {
		t.Errorf("the page: %s", e)
	}
}
