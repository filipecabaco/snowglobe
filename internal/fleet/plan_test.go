package fleet

import "testing"

func TestBriefShowsAScriptByItsFirstLine(t *testing.T) {
	for in, want := range map[string]string{
		"ls -l":                       "ls -l",
		"ls -l\n":                     "ls -l",
		"cat <<EOF\nhi\nthere\nEOF\n": "cat <<EOF … (+3 lines)",
		"\n  mkdir /a\nls\n":          "mkdir /a … (+1 lines)",
	} {
		if got := brief(in); got != want {
			t.Errorf("brief(%q) = %q, want %q", in, got, want)
		}
	}
}
