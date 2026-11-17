package boot

import (
	"strings"
	"testing"
)

func TestFilesBootWithBusyBox(t *testing.T) {
	byName := func(network string) map[string]string {
		m := map[string]string{}
		for _, f := range Files(Console{Command: "'python3'", Workdir: "/root", Env: []string{"LANG=C.UTF-8"}}, network, []byte("CA")) {
			m[f.Name] = string(f.Data)
		}
		return m
	}
	off := byName("none")
	if !strings.Contains(off["etc/inittab"], "::sysinit:/usr/local/sbin/snowglobe-init") ||
		!strings.Contains(off["etc/inittab"], "hvc0::respawn:") || !strings.Contains(off["etc/inittab"], "ttyS0::respawn:") {
		t.Fatalf("inittab: %q", off["etc/inittab"])
	}
	// The serial shell jobs are typed into: no echo (no line editor, which sleeps 20 ms after a
	// line when the terminal hasn't answered its cursor query) and no history file
	if !strings.Contains(off["etc/inittab"], "ttyS0::respawn:/sbin/getty -n -i -l /usr/local/sbin/snowglobe-shell ") {
		t.Fatalf("ttyS0's shell: %q", off["etc/inittab"])
	}
	if sh := off["usr/local/sbin/snowglobe-shell"]; !strings.Contains(sh, "stty -echo") || !strings.Contains(sh, "HISTFILE=/dev/null") || !strings.HasSuffix(sh, "exec /bin/sh\n") {
		t.Fatalf("snowglobe-shell: %q", sh)
	}
	if !strings.Contains(off["usr/local/bin/snowglobe-console"], "exec 'python3'") {
		t.Fatalf("console: %q", off["usr/local/bin/snowglobe-console"])
	}
	if off["etc/snowglobe/env"] != "export LANG='C.UTF-8'\n" {
		t.Fatalf("env: %q", off["etc/snowglobe/env"])
	}
	if strings.Contains(off["usr/local/sbin/snowglobe-init"], "udhcpc") || off["usr/local/share/ca-certificates/snowglobe-sandbox.crt"] != "" {
		t.Fatal("a site without a network gets one")
	}
	on := byName("fetch")
	if !strings.Contains(on["usr/local/sbin/snowglobe-init"], "udhcpc -i eth0") || on["usr/local/share/ca-certificates/snowglobe-sandbox.crt"] != "CA" {
		t.Fatal("a site with a network lacks DHCP or its CA")
	}
	if !strings.Contains(on["etc/profile.d/snowglobe-ca.sh"], "NODE_EXTRA_CA_CERTS") {
		t.Fatal("the runtimes that keep their own CAs aren't told")
	}
}
