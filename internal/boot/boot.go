// Package boot adds the layer that makes an image bootable in armless: kernel, 9p initramfs and
// consoles, plus the script that runs the app on the browser terminal.
package boot

import (
	"fmt"
	"strings"
)

// Console describes what the browser terminal runs.
type Console struct {
	Env     []string // KEY=value
	Workdir string
	Command string // a shell command line
}

// Script is the shell script run on the browser terminal: the image's environment, working
// directory and command. The guest's init doesn't know about Docker's ENV, so it's exported here.
func Script(c Console) string {
	var b strings.Builder
	b.WriteString("#!/bin/sh\n")
	for _, kv := range c.Env {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || key == "" {
			continue
		}
		fmt.Fprintf(&b, "export %s=%s\n", key, Quote(value))
	}
	if c.Workdir != "" {
		fmt.Fprintf(&b, "cd %s\n", Quote(c.Workdir))
	}
	b.WriteString("clear\n")
	fmt.Fprintf(&b, "exec %s\n", c.Command)
	return b.String()
}

// Quote single-quotes a value for /bin/sh.
func Quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Join turns an argv into a shell command line.
func Join(argv []string) string {
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = Quote(a)
	}
	return strings.Join(quoted, " ")
}
