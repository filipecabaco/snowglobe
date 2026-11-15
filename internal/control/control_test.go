package control

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// listen serves sock with handle, one connection at a time: what it was asked, then what to do.
func listen(t *testing.T, handle func(req map[string]any, c net.Conn, r *bufio.Reader)) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "sgc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			r := bufio.NewReader(c)
			line, _ := r.ReadBytes('\n')
			var req map[string]any
			json.Unmarshal(line, &req)
			handle(req, c, r)
		}
	}()
	return sock
}

func answer(c net.Conn, s string) {
	io.WriteString(c, s+"\n")
	c.Close()
}

func TestAJobIsSentWithItsDefaultsAndItsResultRead(t *testing.T) {
	var got map[string]any
	sock := listen(t, func(req map[string]any, c net.Conn, _ *bufio.Reader) {
		got = req
		answer(c, `{"status":3,"output":"aGk=","out":{"r":"eA=="}}`)
	})
	res, err := Job(sock, "m", JobRequest{Cmd: "make", Env: map[string]string{"A": "1"}, Files: map[string][]byte{"in/x": []byte("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if *res.Status != 3 || string(res.Output) != "hi" || string(res.Out["r"]) != "x" {
		t.Errorf("result: %+v", res)
	}
	if got["mode"] != "job" || got["cmd"] != "make" || got["timeout"] != float64(DefaultTimeout) || got["files"].(map[string]any)["in/x"] != "aGk=" {
		t.Errorf("request: %v", got)
	}
}

func TestAJobFailsSayingWhy(t *testing.T) {
	if _, err := Job("/nonexistent/s.sock", "m", JobRequest{Cmd: "x"}); err == nil || !strings.HasPrefix(err.Error(), "m: ") {
		t.Errorf("no socket: %v", err)
	}
	if _, err := Job("/nonexistent/s.sock", "m", JobRequest{Cmd: "x", Timeout: -1}); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Errorf("a negative timeout: %v", err)
	}
	for reply, want := range map[string]string{
		"":                   "stopped while the job ran",
		"not json":           "m: ",
		`{"error":"no cmd"}`: "no cmd",
	} {
		sock := listen(t, func(_ map[string]any, c net.Conn, _ *bufio.Reader) {
			if reply == "" {
				c.Close()
				return
			}
			answer(c, reply)
		})
		if _, err := Job(sock, "m", JobRequest{Cmd: "x"}); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v", reply, err)
		}
	}
}

func TestSpawnAsksByNameAndChecksTheAnswer(t *testing.T) {
	var got map[string]any
	sock := listen(t, func(req map[string]any, c net.Conn, _ *bufio.Reader) {
		got = req
		answer(c, `{"pid":42,"socket":"/run/m.sock"}`)
	})
	s, err := Spawn(sock, "web", "")
	if err != nil || s.Pid != 42 || s.Socket != "/run/m.sock" || got["mode"] != "spawn" || got["name"] != "web" {
		t.Fatalf("%+v %v %v", s, err, got)
	}
	for reply, want := range map[string]string{
		`{"error":"10 machines are running"}`: "10 machines",
		`{}`:                                  "no machine in the answer",
		"":                                    "no answer",
	} {
		sock := listen(t, func(_ map[string]any, c net.Conn, _ *bufio.Reader) {
			if reply == "" {
				c.Close()
				return
			}
			answer(c, reply)
		})
		if _, err := Spawn(sock, "web", ""); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v", reply, err)
		}
	}
}

func TestConnectIsAStreamToTheGuestPort(t *testing.T) {
	// An echo after the answer; what the "guest" sends at once comes with the answer
	sock := listen(t, func(req map[string]any, c net.Conn, r *bufio.Reader) {
		io.WriteString(c, `{"connected":8000}`+"\nhello ")
		go func() { io.Copy(c, r); c.Close() }()
	})
	c, err := Connect(sock, 8000)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("ping"))
	CloseWrite(c)
	got, _ := io.ReadAll(c)
	c.Close()
	if string(got) != "hello ping" {
		t.Errorf("got %q", got)
	}

	refused := listen(t, func(_ map[string]any, c net.Conn, _ *bufio.Reader) { answer(c, `{"error":"connect: a port"}`) })
	if _, err := Connect(refused, 0); err == nil || !strings.Contains(err.Error(), "a port") {
		t.Errorf("refused: %v", err)
	}
	if _, err := Connect("/nonexistent/s.sock", 80); err == nil {
		t.Error("no socket: no error")
	}
}

func TestAlive(t *testing.T) {
	sock := listen(t, func(_ map[string]any, c net.Conn, _ *bufio.Reader) { c.Close() })
	if !Alive(sock) {
		t.Error("a listening socket isn't alive")
	}
	if Alive(filepath.Join(filepath.Dir(sock), "none.sock")) {
		t.Error("no socket is alive")
	}
}

func TestSaveAsksForAPathAndSaysWhatWasWritten(t *testing.T) {
	var got map[string]any
	sock := listen(t, func(req map[string]any, c net.Conn, _ *bufio.Reader) {
		got = req
		answer(c, `{"saved":"/j/s.zst","bytes":17,"ms":4}`)
	})
	s, err := Save(sock, "/j/s.zst")
	if err != nil || s.Bytes != 17 || s.Ms != 4 || got["mode"] != "save" || got["path"] != "/j/s.zst" {
		t.Fatalf("%+v %v %v", s, err, got)
	}
	refused := listen(t, func(_ map[string]any, c net.Conn, _ *bufio.Reader) { answer(c, `{"error":"read-only"}`) })
	if _, err := Save(refused, "/x"); err == nil || err.Error() != "read-only" {
		t.Errorf("refused: %v", err)
	}
	if _, err := Save("/nonexistent/s.sock", "/x"); err == nil || !strings.HasPrefix(err.Error(), "save: ") {
		t.Errorf("no socket: %v", err)
	}
	// A spawn with a state names it
	sock = listen(t, func(req map[string]any, c net.Conn, _ *bufio.Reader) {
		got = req
		answer(c, `{"pid":7,"socket":"/r/m.sock"}`)
	})
	if _, err := Spawn(sock, "m", "/j/s.zst"); err != nil || got["state"] != "/j/s.zst" {
		t.Errorf("spawn with a state: %v %v", got, err)
	}
}

// A job's output and out/ past what is kept are dropped as they are read, and counted
func TestAJobKeepsTheFirstOfItsOutput(t *testing.T) {
	big := strings.Repeat("x", 3<<20)
	sock := listen(t, func(req map[string]any, c net.Conn, r *bufio.Reader) {
		data, _ := json.Marshal(JobResult{Status: new(int), Output: []byte(big),
			Out: map[string][]byte{"a\"b.txt": []byte(big), "c.txt": []byte("small")}, Ms: 7})
		c.Write(append(data, '\n'))
		c.Close()
	})
	res, err := JobLimited(context.Background(), sock, "m", JobRequest{Cmd: "x"}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	near := func(a, b int64) bool { return a-b < 4 && b-a < 4 }
	if len(res.Output) > 1<<20 || !near(int64(len(res.Output))+res.OutputCut, 3<<20) || res.Ms != 7 || res.Status == nil {
		t.Errorf("output: %d kept, %d cut: %+v", len(res.Output), res.OutputCut, res.Status)
	}
	kept := 0
	for _, f := range res.Out {
		kept += len(f)
	}
	if len(res.Out) != 2 || kept > 1<<20 || !near(int64(kept)+res.OutCut, 3<<20+5) || res.Out["a\"b.txt"] == nil {
		t.Errorf("out: %d files, %d kept, %d cut", len(res.Out), kept, res.OutCut)
	}
	// Nothing to keep back: all of it
	res, err = Job(sock, "m", JobRequest{Cmd: "x"})
	if err != nil || len(res.Output) != 3<<20 || res.OutputCut != 0 || len(res.Out["c.txt"]) != 5 {
		t.Errorf("whole: %v %d %d", err, len(res.Output), res.OutputCut)
	}
}

// A job given up on (its caller gone) stops waiting
func TestAJobIsGivenUpWithItsContext(t *testing.T) {
	sock := listen(t, func(req map[string]any, c net.Conn, r *bufio.Reader) {
		// Never answers
		go func() { io.Copy(io.Discard, r); c.Close() }()
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	begun := time.Now()
	if _, err := JobLimited(ctx, sock, "m", JobRequest{Cmd: "x"}, 0); err == nil || !strings.Contains(err.Error(), "given up") {
		t.Errorf("given up: %v", err)
	}
	if time.Since(begun) > 5*time.Second {
		t.Error("waited on")
	}
}
