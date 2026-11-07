package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/filipecabaco/snowglobe/internal/instance"
)

type jobRequest struct {
	Cmd     string            `json:"cmd"`
	Timeout float64           `json:"timeout"`
	Files   map[string][]byte `json:"files"`
	Home    bool              `json:"home"`
}

// fakeInstance is a running native instance called name whose control socket answers every job
// with answer's result. It is this process, as far as its state says: never stop it.
func fakeInstance(t *testing.T, name string, answer func(jobRequest) instance.JobResult) *[]jobRequest {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cache, "snowglobe", "instances", name)
	os.MkdirAll(dir, 0o700)
	short, err := os.MkdirTemp("", "sgm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(short) })
	sock := filepath.Join(short, "sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	var reqs []jobRequest
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadBytes('\n')
			var req jobRequest
			json.Unmarshal(line, &req)
			reqs = append(reqs, req)
			data, _ := json.Marshal(answer(req))
			c.Write(append(data, '\n'))
			c.Close()
		}
	}()
	state, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "socket": sock})
	if err := os.WriteFile(filepath.Join(dir, "state.json"), state, 0o600); err != nil {
		t.Fatal(err)
	}
	return &reqs
}

func status(n int) *int { return &n }

// callTool calls a tool over the protocol: its text and whether it is an error.
func callTool(t *testing.T, name string, args map[string]any) (string, bool) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"name": name, "arguments": args})
	in := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":` + string(params) + "}\n"
	var out bytes.Buffer
	if err := (&Server{Name: "box"}).Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result struct {
			Content []struct{ Text string }
			IsError bool
		}
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || len(reply.Result.Content) != 1 {
		t.Fatalf("%s: %v", out.String(), err)
	}
	return reply.Result.Content[0].Text, reply.Result.IsError
}

func TestRunCommand(t *testing.T) {
	for _, tc := range []struct {
		name    string
		result  instance.JobResult
		want    string
		isError bool
	}{
		{"success", instance.JobResult{Status: status(0), Output: []byte("hi\n\n")}, "hi\n[exit 0]", false},
		{"failure", instance.JobResult{Status: status(2), Output: []byte("no\n")}, "no\n[exit 2]", true},
		{"out of time", instance.JobResult{Output: []byte("partial"), TimedOut: true, Killed: true},
			"partial\n[timed out; everything it started was killed]", true},
		{"stopped", instance.JobResult{Output: []byte("partial"), Cancelled: true}, "partial\n[stopped]", true},
		{"refused", instance.JobResult{Error: "a job is running"}, "a job is running", true},
	} {
		reqs := fakeInstance(t, "box", func(jobRequest) instance.JobResult { return tc.result })
		text, isError := callTool(t, "run_command", map[string]any{"command": "echo hi", "timeout_seconds": 7})
		if text != tc.want || isError != tc.isError {
			t.Errorf("%s: got %q (error %v), want %q (error %v)", tc.name, text, isError, tc.want, tc.isError)
		}
		// In the home directory, as in the machine's terminal and the agent page
		if r := (*reqs)[0]; r.Cmd != "echo hi" || r.Timeout != 7 || !r.Home {
			t.Errorf("%s: sent %+v", tc.name, r)
		}
	}
}

func TestWriteFile(t *testing.T) {
	reqs := fakeInstance(t, "box", func(jobRequest) instance.JobResult { return instance.JobResult{Status: status(0)} })
	text, isError := callTool(t, "write_file", map[string]any{"path": "/root/it's here.txt", "content": "hello"})
	if isError || text != "wrote 5 bytes to /root/it's here.txt" {
		t.Errorf("got %q, %v", text, isError)
	}
	r := (*reqs)[0]
	if r.Home {
		t.Error("write_file starts in the home directory, away from its payload")
	}
	if string(r.Files["payload"]) != "hello" || r.Cmd != `mkdir -p "$(dirname '/root/it'\''s here.txt')" && cp payload '/root/it'\''s here.txt'` {
		t.Errorf("sent %+v", r)
	}

	if text, isError := callTool(t, "write_file", map[string]any{"path": "relative.txt", "content": "x"}); !isError || !strings.Contains(text, "absolute") {
		t.Errorf("a relative path: %q", text)
	}
	fakeInstance(t, "box", func(jobRequest) instance.JobResult {
		return instance.JobResult{Status: status(1), Output: []byte("read-only file system\n")}
	})
	if text, isError := callTool(t, "write_file", map[string]any{"path": "/ro/x", "content": "x"}); !isError || text != "read-only file system" {
		t.Errorf("a failed write: %q", text)
	}
}

func TestReadFile(t *testing.T) {
	for _, tc := range []struct {
		name    string
		result  instance.JobResult
		want    string
		isError bool
	}{
		{"text", instance.JobResult{Status: status(0), Out: map[string][]byte{"file": []byte("contents")}}, "contents", false},
		{"binary", instance.JobResult{Status: status(0), Out: map[string][]byte{"file": {0xff, 0xfe, 0}}}, "/etc/f is binary (3 bytes)", true},
		{"missing", instance.JobResult{Status: status(1), Output: []byte("cp: no such file\n")}, "cp: no such file", true},
		{"nothing back", instance.JobResult{Status: status(0)}, "", true},
	} {
		reqs := fakeInstance(t, "box", func(jobRequest) instance.JobResult { return tc.result })
		text, isError := callTool(t, "read_file", map[string]any{"path": "/etc/f"})
		if text != tc.want || isError != tc.isError {
			t.Errorf("%s: got %q (error %v)", tc.name, text, isError)
		}
		if r := (*reqs)[0]; r.Cmd != "cp '/etc/f' out/file" {
			t.Errorf("%s: sent %q", tc.name, r.Cmd)
		}
	}
}

func TestToolsNeedARunningInstance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	for _, tool := range []string{"run_command", "write_file", "read_file"} {
		if text, isError := callTool(t, tool, map[string]any{"command": "true", "path": "/x"}); !isError || !strings.Contains(text, "no instance called box") {
			t.Errorf("%s: %q", tool, text)
		}
	}
	if text, isError := callTool(t, "format_disk", nil); !isError || text != "unknown tool: format_disk" {
		t.Errorf("an unknown tool: %q", text)
	}
}

func TestBadToolCallParams(t *testing.T) {
	in := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":["not","an","object"]}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"initialize"}` + "\n"
	var out bytes.Buffer
	if err := (&Server{Name: "box", Title: "Demo", Version: "v1"}).Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"code":-32602`) {
		t.Fatalf("got %q", lines)
	}
	// Without a version asked for, the one it knows; the title in its instructions
	if !strings.Contains(lines[1], `"protocolVersion":"2025-06-18"`) || !strings.Contains(lines[1], "(Demo)") {
		t.Errorf("initialize: %s", lines[1])
	}
}
