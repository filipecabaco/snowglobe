//go:build !unix

package lifeline

import "os/exec"

// Env is the variable that names the inherited descriptor (on Linux and macOS).
const Env = "SNOWGLOBE_LIFELINE"

// Pass does nothing where there are no inherited pipes to rely on: a child isn't tied to this
// process.
func Pass(*exec.Cmd) error { return nil }

// Watch finds no lifeline.
func Watch(func()) bool { return false }

// Stop does nothing.
func Stop() {}
