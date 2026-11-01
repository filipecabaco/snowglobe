package mcp

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestProtocol(t *testing.T) {
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"nope"}`,
		`not json`,
		`{"jsonrpc":"2.0","id":"x","method":"ping"}`,
	}, "\n") + "\n"
	var out bytes.Buffer
	if err := (&Server{Name: "none", Title: "t", Version: "v"}).Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var replies []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		replies = append(replies, m)
	}
	// The notification gets no answer; the bad line a parse error
	if len(replies) != 5 {
		t.Fatalf("%d replies: %v", len(replies), replies)
	}
	if v := replies[0]["result"].(map[string]any)["protocolVersion"]; v != "2025-03-26" {
		t.Fatalf("protocol version %v", v)
	}
	names := []string{}
	for _, tool := range replies[1]["result"].(map[string]any)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "run_command,write_file,read_file" {
		t.Fatalf("tools %v", names)
	}
	if replies[2]["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatal("unknown method")
	}
	if replies[3]["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatal("parse error")
	}
	if replies[4]["id"] != "x" {
		t.Fatal("string ids")
	}
}
