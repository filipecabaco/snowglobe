package rootfs

import (
	"archive/tar"
	"bytes"
	"strings"
	"testing"
)

func tarWith(t *testing.T, headers ...*tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range headers {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		tw.Write(make([]byte, h.Size))
	}
	tw.Close()
	return buf.Bytes()
}

// A member that climbs out of the root is refused, not folded into the guest's filesystem (over
// /etc/passwd, say) nor kept as a directory called "..".
func TestConvertRefusesPathsOutOfTheRoot(t *testing.T) {
	for name, h := range map[string]*tar.Header{
		"a parent":          {Name: "../etc/passwd", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
		"deeper":            {Name: "./usr/../../x", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1},
		"the parent itself": {Name: "..", Typeflag: tar.TypeDir, Mode: 0o755},
		"a hard link out":   {Name: "etc/l", Typeflag: tar.TypeLink, Linkname: "../../etc/shadow"},
	} {
		_, err := Convert(bytes.NewReader(tarWith(t, h)), t.TempDir(), Options{})
		if err == nil || !strings.Contains(err.Error(), "escapes the root") {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

// Paths that stay inside are cleaned: a/../b is b, //etc/./motd is etc/motd.
func TestConvertCleansPathsThatStayInside(t *testing.T) {
	res, err := Convert(bytes.NewReader(tarWith(t,
		&tar.Header{Name: "usr/../b", Typeflag: tar.TypeReg, Mode: 0o644, Size: 2},
		&tar.Header{Name: "//etc/./motd", Typeflag: tar.TypeReg, Mode: 0o644, Size: 3},
		&tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755},
	)), t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range res.Files {
		paths = append(paths, f.Path)
	}
	if strings.Join(paths, ",") != "/b,/etc/motd" {
		t.Errorf("got %v", paths)
	}
}
