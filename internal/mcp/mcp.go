// Package mcp serves a running snowglobe instance to an agent as an MCP server (JSON-RPC 2.0 over
// stdio): an isolated Linux machine with tools to run commands and read and write files. It needs
// no Docker, KVM or privileges, so an agent in a container or CI job can use one.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/filipecabaco/snowglobe/internal/instance"
)

// Server answers MCP requests against the native instance called Name.
type Server struct {
	Name    string
	Title   string
	Version string
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

var tools = []map[string]any{
	{
		"name":        "run_command",
		"description": "Run a shell command (/bin/sh) in the sandboxed Linux machine and return its output and exit status. Each command starts in a fresh working directory; files elsewhere (/root, /tmp, ...) persist between commands.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":         map[string]any{"type": "string", "description": "The command line"},
				"timeout_seconds": map[string]any{"type": "number", "description": "Kill it, and everything it started, after this long (default 300)"},
			},
			"required": []string{"command"},
		},
	},
	{
		"name":        "write_file",
		"description": "Write a text file in the sandboxed machine (an absolute path; directories are made).",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "Absolute path in the machine"},
				"content": map[string]any{"type": "string"},
			},
			"required": []string{"path", "content"},
		},
	},
	{
		"name":        "read_file",
		"description": "Read a file from the sandboxed machine (an absolute path).",
		"inputSchema": map[string]any{
			"type":       "object",
			"properties": map[string]any{"path": map[string]any{"type": "string", "description": "Absolute path in the machine"}},
			"required":   []string{"path"},
		},
	},
}

// Serve answers requests from r on w until r ends.
func (s *Server) Serve(r io.Reader, w io.Writer) error {
	in := bufio.NewReaderSize(r, 1<<20)
	enc := json.NewEncoder(w)
	for {
		line, err := in.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var m message
			if jerr := json.Unmarshal(line, &m); jerr != nil {
				enc.Encode(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "parse error"}})
			} else if len(m.ID) > 0 {
				result, rpcErr := s.handle(m)
				reply := map[string]any{"jsonrpc": "2.0", "id": m.ID}
				if rpcErr != nil {
					reply["error"] = rpcErr
				} else {
					reply["result"] = result
				}
				if err := enc.Encode(reply); err != nil {
					return err
				}
			}
			// Notifications (no id) need no answer
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (s *Server) handle(m message) (any, map[string]any) {
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(m.Params, &p)
		version := p.ProtocolVersion
		if version == "" {
			version = "2025-06-18"
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "snowglobe", "version": s.Version},
			"instructions": fmt.Sprintf("An isolated arm64 Linux machine (%s), emulated, with no access to this host. "+
				"Use run_command to run shell commands in it, and write_file / read_file for files.", s.Title),
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, map[string]any{"code": -32602, "message": err.Error()}
		}
		text, isErr := s.call(p.Name, p.Arguments)
		return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}, nil
	default:
		return nil, map[string]any{"code": -32601, "message": "method not found: " + m.Method}
	}
}

func (s *Server) call(name string, args map[string]any) (string, bool) {
	str := func(k string) string { v, _ := args[k].(string); return v }
	switch name {
	case "run_command":
		timeout, _ := args["timeout_seconds"].(float64)
		res, err := instance.Job(s.Name, instance.JobRequest{Cmd: str("command"), Timeout: timeout})
		if err != nil {
			return err.Error(), true
		}
		if res.Status == nil {
			// The agent can run its next command: what this one started is gone
			how := "timed out"
			if res.Cancelled {
				how = "stopped"
			}
			if res.Killed {
				how += "; everything it started was killed"
			}
			return string(res.Output) + "\n[" + how + "]", true
		}
		return fmt.Sprintf("%s\n[exit %d]", strings.TrimRight(string(res.Output), "\n"), *res.Status), *res.Status != 0
	case "write_file":
		p := str("path")
		if !strings.HasPrefix(p, "/") {
			return "path must be absolute", true
		}
		res, err := instance.Job(s.Name, instance.JobRequest{
			Files: map[string][]byte{"payload": []byte(str("content"))},
			Cmd:   fmt.Sprintf(`mkdir -p "$(dirname %s)" && cp payload %s`, quote(p), quote(p)),
		})
		if err != nil {
			return err.Error(), true
		}
		if res.Status == nil || *res.Status != 0 {
			return strings.TrimSpace(string(res.Output)), true
		}
		return fmt.Sprintf("wrote %d bytes to %s", len(str("content")), p), false
	case "read_file":
		p := str("path")
		res, err := instance.Job(s.Name, instance.JobRequest{Cmd: fmt.Sprintf(`cp %s out/file`, quote(p))})
		if err != nil {
			return err.Error(), true
		}
		data, ok := res.Out["file"]
		if res.Status == nil || *res.Status != 0 || !ok {
			return strings.TrimSpace(string(res.Output)), true
		}
		if !utf8.Valid(data) {
			return fmt.Sprintf("%s is binary (%d bytes)", p, len(data)), true
		}
		return string(data), false
	default:
		return "unknown tool: " + name, true
	}
}

func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Stdio serves on this process's stdin and stdout.
func (s *Server) Stdio() error {
	return s.Serve(os.Stdin, os.Stdout)
}
