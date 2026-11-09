// The owner's interactive PTY lives inside the guest, independently of the
// serial channel used by Builder jobs. This service is never a preview route.
package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

type configuration struct {
	Token string `json:"token"`
	Cwd   string `json:"cwd"`
}
type frame struct {
	Type    string `json:"type"`
	Token   string `json:"token,omitempty"`
	Data    []byte `json:"data,omitempty"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
	Message string `json:"message,omitempty"`
}

func ioctl(fd uintptr, op uintptr, value unsafe.Pointer) error {
	_, _, err := syscall.Syscall(syscall.SYS_IOCTL, fd, op, uintptr(value))
	if err != 0 {
		return err
	}
	return nil
}

func resize(pty *os.File, cols, rows uint16) error {
	if cols < 2 || cols > 500 || rows < 2 || rows > 300 {
		return fmt.Errorf("invalid terminal size")
	}
	size := [4]uint16{rows, cols, 0, 0}
	return ioctl(pty.Fd(), syscall.TIOCSWINSZ, unsafe.Pointer(&size))
}

func shell(config configuration, cols, rows uint16) (*os.File, *exec.Cmd, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (*os.File, *exec.Cmd, error) { master.Close(); return nil, nil, err }
	var unlocked, number uint32
	if err := ioctl(master.Fd(), syscall.TIOCSPTLCK, unsafe.Pointer(&unlocked)); err != nil {
		return fail(err)
	}
	if err := ioctl(master.Fd(), syscall.TIOCGPTN, unsafe.Pointer(&number)); err != nil {
		return fail(err)
	}
	slave, err := os.OpenFile("/dev/pts/"+strconv.FormatUint(uint64(number), 10), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return fail(err)
	}
	defer slave.Close()
	if err := resize(master, cols, rows); err != nil {
		return fail(err)
	}
	command := exec.Command("/bin/sh", "-i")
	command.Dir = config.Cwd
	command.Env = append(os.Environ(), "TERM=xterm-256color", "PS1=\\w $ ")
	command.Stdin, command.Stdout, command.Stderr = slave, slave, slave
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0, Pdeathsig: syscall.SIGKILL}
	if err := command.Start(); err != nil {
		return fail(err)
	}
	return master, command, nil
}

func session(conn net.Conn, filename string, active chan struct{}) {
	defer conn.Close()
	var mu sync.Mutex
	send := func(value frame) error {
		mu.Lock()
		defer mu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
		return json.NewEncoder(conn).Encode(value)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 128*1024)
	if !scanner.Scan() {
		return
	}
	var open frame
	var config configuration
	bytes, err := os.ReadFile(filename)
	if err != nil || json.Unmarshal(bytes, &config) != nil || len(config.Token) != 64 || json.Unmarshal(scanner.Bytes(), &open) != nil || open.Type != "open" || subtle.ConstantTimeCompare([]byte(open.Token), []byte(config.Token)) != 1 {
		send(frame{Type: "error", Message: "Console authorization failed"})
		return
	}
	select {
	case active <- struct{}{}:
		defer func() { <-active }()
	default:
		send(frame{Type: "error", Message: "Another console session is connected"})
		return
	}
	master, command, err := shell(config, open.Cols, open.Rows)
	if err != nil {
		send(frame{Type: "error", Message: "Could not open the guest terminal: " + err.Error()})
		return
	}
	defer master.Close()
	defer command.Process.Kill()
	conn.SetReadDeadline(time.Time{})
	if send(frame{Type: "ready"}) != nil {
		return
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait(); conn.Close() }()
	go func() {
		defer conn.Close()
		buffer := make([]byte, 16*1024)
		for {
			n, err := master.Read(buffer)
			if n > 0 && send(frame{Type: "output", Data: buffer[:n]}) != nil {
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for scanner.Scan() {
		var message frame
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			break
		}
		switch message.Type {
		case "input":
			if len(message.Data) > 32768 {
				return
			}
			if _, err := master.Write(message.Data); err != nil {
				return
			}
		case "resize":
			if resize(master, message.Cols, message.Rows) != nil {
				return
			}
		case "close":
			return
		default:
			return
		}
	}
	select {
	case <-done:
	default:
	}
}

func serve(listener net.Listener, filename string) error {
	active := make(chan struct{}, 1)
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go session(conn, filename, active)
	}
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: console-bridge configuration.json")
		os.Exit(2)
	}
	listener, err := net.Listen("tcp", "0.0.0.0:54323")
	if err == nil {
		err = serve(listener, os.Args[1])
	}
	if err != nil && err != io.EOF {
		fmt.Fprintln(os.Stderr, "console service stopped:", err)
		os.Exit(1)
	}
}
