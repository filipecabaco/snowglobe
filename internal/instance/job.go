package instance

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Jobs on a running native instance, over its control socket: files in, a command run on the
// guest's serial root shell (whatever the app is), its output, exit status and out/ back. What
// `snowglobe sh`, `snowglobe cp` and `snowglobe mcp` are made of.

// JobRequest is a job: files written into its workspace, the command, its environment.
type JobRequest struct {
	Files   map[string][]byte `json:"files,omitempty"`
	Cmd     string            `json:"cmd"`
	Env     map[string]string `json:"env,omitempty"`
	Timeout float64           `json:"timeout"`
}

// JobResult is what a job left: its exit status (nil: out of time, or the instance stopped), output
// and out/. Out of time or stopped, Killed says the guest killed everything the command started.
type JobResult struct {
	Status    *int              `json:"status"`
	Output    []byte            `json:"output"`
	Out       map[string][]byte `json:"out"`
	TimedOut  bool              `json:"timed_out"`
	Cancelled bool              `json:"cancelled"`
	Killed    bool              `json:"killed"`
	Ms        int64             `json:"ms"`
	Error     string            `json:"error"`
}

// Job runs a job on the native instance called name.
func Job(name string, req JobRequest) (*JobResult, error) {
	return job(name, req, false)
}

// forkOnlySh is the error for what a --fork instance can't do: there is no machine that lasts
// from one command to the next to copy files into, join or keep an agent's work on.
func forkOnlySh(name string) error {
	return fmt.Errorf("%s runs each command in a fresh copy of its machine (--fork): snowglobe sh is all it takes", name)
}

// job runs a job on the native instance called name; on a --fork one only when fresh says each
// job standing alone is what the caller wants.
func job(name string, req JobRequest, fresh bool) (*JobResult, error) {
	st, _, ok := loadNative(name)
	if !ok {
		if inContainer(name) {
			return nil, fmt.Errorf("%s runs in a container: jobs, sh, cp and mcp need a native instance (--runtime native)", name)
		}
		return nil, fmt.Errorf("no instance called %s (snowglobe ps lists them)", name)
	}
	if st.Fork && !fresh {
		return nil, forkOnlySh(name)
	}
	if req.Timeout < 0 {
		return nil, fmt.Errorf("timeout %v: 0 or more seconds", req.Timeout)
	}
	if req.Timeout == 0 {
		req.Timeout = 300
	}
	conn, err := net.Dial("unix", st.Socket)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	defer conn.Close()
	body := map[string]any{"mode": "job", "cmd": req.Cmd, "env": req.Env, "timeout": req.Timeout, "files": req.Files}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	conn.SetReadDeadline(time.Now().Add(time.Duration(req.Timeout+30) * time.Second))
	line, err := bufio.NewReaderSize(conn, 1<<20).ReadBytes('\n')
	if errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s stopped while the job ran (its logs say why)", name)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: no answer: %w", name, err)
	}
	var res JobResult
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if res.Error != "" {
		return nil, errors.New(res.Error)
	}
	return &res, nil
}

// Shell runs a command on a native instance's shell and prints its output, ending with its exit
// status; as JSON ({"exit", "output"}) when asked.
func Shell(name, command string, asJSON bool, timeout float64) error {
	res, err := job(name, JobRequest{Cmd: command, Timeout: timeout}, true)
	if err != nil {
		return err
	}
	code := ExitMaxRuntime // out of time, as timeout(1) says it
	if res.Cancelled {
		code = ExitStopped
	}
	if res.Status != nil {
		code = *res.Status
	}
	if asJSON {
		out, _ := json.Marshal(map[string]any{"exit": code, "timed_out": res.TimedOut, "killed": res.Killed, "output": string(res.Output)})
		fmt.Println(string(out))
	} else {
		os.Stdout.Write(res.Output)
	}
	if code != 0 {
		return ExitError{Code: code}
	}
	return nil
}

// Copy copies between this machine and a native instance: "name:/guest/path" on one side.
// Files and directories, either way.
func Copy(src, dst string) error {
	srcName, srcPath, srcGuest := guestPath(src)
	dstName, dstPath, dstGuest := guestPath(dst)
	switch {
	case srcGuest == dstGuest:
		return errors.New("cp: one side is name:/path in an instance, the other a path here")
	case dstGuest:
		return put(dstName, src, dstPath)
	default:
		return get(srcName, srcPath, dst)
	}
}

// guestPath reads "name:/path" (an absolute path, so a local "C:..." or "./a:b" isn't one).
func guestPath(s string) (name, p string, ok bool) {
	name, p, found := strings.Cut(s, ":")
	if !found || name == "" || !strings.HasPrefix(p, "/") || strings.ContainsAny(name, "/\\") {
		return "", "", false
	}
	return name, p, true
}

func put(name, local, guest string) error {
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	q := shellQuote(guest)
	if !st.IsDir() {
		data, err := os.ReadFile(local)
		if err != nil {
			return err
		}
		// Into an existing directory, under its own name; else as that path
		cmd := fmt.Sprintf(`d=%s; [ -d "$d" ] && d="$d"/%s; mkdir -p "$(dirname "$d")" && cp payload "$d" && chmod %o "$d"`,
			q, shellQuote(filepath.Base(local)), st.Mode().Perm())
		return jobOK(name, JobRequest{Files: map[string][]byte{"payload": data}, Cmd: cmd})
	}
	var buf bytes.Buffer
	if err := tarDir(local, &buf); err != nil {
		return err
	}
	return jobOK(name, JobRequest{Files: map[string][]byte{"payload.tar": buf.Bytes()},
		Cmd: fmt.Sprintf(`mkdir -p %s && tar -xf payload.tar -C %s`, q, q)})
}

func get(name, guest, local string) error {
	q := shellQuote(guest)
	res, err := Job(name, JobRequest{Cmd: fmt.Sprintf(
		`if [ -d %s ]; then tar -cf out/dir.tar -C %s .; else cp %s out/file; fi`, q, q, q)})
	if err != nil {
		return err
	}
	if res.Status == nil || *res.Status != 0 {
		return fmt.Errorf("cp %s:%s: %s", name, guest, strings.TrimSpace(string(res.Output)))
	}
	if data, ok := res.Out["file"]; ok {
		if st, err := os.Stat(local); err == nil && st.IsDir() {
			local = filepath.Join(local, path.Base(guest))
		}
		return os.WriteFile(local, data, 0o644)
	}
	data, ok := res.Out["dir.tar"]
	if !ok {
		return fmt.Errorf("cp %s:%s: nothing came back", name, guest)
	}
	return untar(bytes.NewReader(data), local)
}

func jobOK(name string, req JobRequest) error {
	res, err := Job(name, req)
	if err != nil {
		return err
	}
	if res.Status == nil || *res.Status != 0 {
		return fmt.Errorf("%s: %s", name, strings.TrimSpace(string(res.Output)))
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func tarDir(dir string, w io.Writer) error {
	tw := tar.NewWriter(w)
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		}
		h, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// untar writes a tar into dir, refusing paths that would land outside it, symlinks included (the
// tar comes from the guest: a link to /etc followed by a file under it must not write there).
func untar(r io.Reader, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	// inside checks where p's parent resolves to, before any of it is made: the deepest directory
	// there is, as what MkdirAll makes below it can't be a symlink
	inside := func(p string) error {
		parent := filepath.Dir(p)
		for {
			if _, err := os.Lstat(parent); err == nil || filepath.Dir(parent) == parent {
				break
			}
			parent = filepath.Dir(parent)
		}
		parent, err := filepath.EvalSymlinks(parent)
		if err != nil {
			return err
		}
		if parent != root && !strings.HasPrefix(parent, root+string(filepath.Separator)) {
			return fmt.Errorf("%s would land outside %s", p, dir)
		}
		return nil
	}
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		rel := path.Clean("/" + h.Name)[1:]
		if rel == "" {
			continue
		}
		p := filepath.Join(dir, filepath.FromSlash(rel))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := inside(p); err != nil {
				return err
			}
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := inside(p); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if st, err := os.Lstat(p); err == nil && st.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s is a symlink: not writing through it", p)
			}
			f, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(h.Mode).Perm()|0o200)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := inside(p); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			os.Remove(p)
			if err := os.Symlink(h.Linkname, p); err != nil {
				return err
			}
		}
	}
}
