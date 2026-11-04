package mcp

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// toolset is what an MCP server serves: its instructions, its tools and what calling one does
// (the text to answer, and whether it is an error).
type toolset interface {
	instructions() string
	list() []map[string]any
	call(name string, args map[string]any) (string, bool)
}

// serveRPC answers MCP's JSON-RPC 2.0 requests from r on w, one per line, until r ends.
func serveRPC(r io.Reader, w io.Writer, version string, t toolset) error {
	in := bufio.NewReaderSize(r, 1<<20)
	enc := json.NewEncoder(w)
	for {
		line, err := in.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var m message
			if jerr := json.Unmarshal(line, &m); jerr != nil {
				enc.Encode(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "parse error"}})
			} else if len(m.ID) > 0 {
				result, rpcErr := handle(m, version, t)
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

func handle(m message, version string, t toolset) (any, map[string]any) {
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(m.Params, &p)
		proto := p.ProtocolVersion
		if proto == "" {
			proto = "2025-06-18"
		}
		return map[string]any{
			"protocolVersion": proto,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "snowglobe", "version": version},
			"instructions":    t.instructions(),
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": t.list()}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, map[string]any{"code": -32602, "message": err.Error()}
		}
		text, isErr := t.call(p.Name, p.Arguments)
		return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}, nil
	default:
		return nil, map[string]any{"code": -32601, "message": "method not found: " + m.Method}
	}
}
