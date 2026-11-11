package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func consoleClient(t *testing.T, token string) (net.Conn, *json.Decoder) {
	t.Helper()
	directory := t.TempDir()
	config := filepath.Join(directory, "console.json")
	data, _ := json.Marshal(configuration{Token: strings.Repeat("a", 64), Cwd: directory})
	if err := os.WriteFile(config, data, 0600); err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	go session(server, config, make(chan struct{}, 1))
	t.Cleanup(func() { client.Close() })
	client.SetDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(client).Encode(frame{Type: "open", Token: token, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	return client, json.NewDecoder(client)
}

func TestConsoleRejectsUnapprovedConnection(t *testing.T) {
	_, decoder := consoleClient(t, strings.Repeat("b", 64))
	var response frame
	if err := decoder.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "error" || response.Message != "Console authorization failed" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestInteractiveTerminalSizeInputAndInterrupt(t *testing.T) {
	client, decoder := consoleClient(t, strings.Repeat("a", 64))
	var response frame
	if err := decoder.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "ready" {
		t.Fatalf("terminal did not start: %+v", response)
	}
	encoder := json.NewEncoder(client)
	readUntil := func(want string) {
		t.Helper()
		output := ""
		for !strings.Contains(output, want) {
			var next frame
			if err := decoder.Decode(&next); err != nil {
				t.Fatalf("waiting for %q: %v; output %q", want, err, output)
			}
			output += string(next.Data)
		}
	}
	if err := encoder.Encode(frame{Type: "input", Data: []byte("stty -echo; printf '__READY__\\n'; stty size\n")}); err != nil {
		t.Fatal(err)
	}
	readUntil("24 80\r\n")
	if err := encoder.Encode(frame{Type: "resize", Cols: 100, Rows: 35}); err != nil {
		t.Fatal(err)
	}
	encoder.Encode(frame{Type: "input", Data: []byte("stty size; printf '__SLEEP__\\n'; sleep 30\n")})
	readUntil("__SLEEP__\r\n")
	time.Sleep(30 * time.Millisecond)
	encoder.Encode(frame{Type: "input", Data: []byte{3}})
	time.Sleep(30 * time.Millisecond)
	encoder.Encode(frame{Type: "input", Data: []byte("printf '__INTERRUPTED__\\n'; stty size\n")})
	readUntil("35 100\r\n")
	encoder.Encode(frame{Type: "close"})
}
