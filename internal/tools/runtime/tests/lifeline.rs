//! snowglobe-vm ends when its lifeline breaks: a process given SNOWGLOBE_LIFELINE, whose write end
//! the test holds, exits once the test closes it, whatever it was waiting on.

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A pipe whose read end a child inherits and whose write end it doesn't.
fn lifeline() -> (libc::c_int, libc::c_int) {
    let mut fds = [0; 2];
    // SAFETY: pipe writes two descriptors into the array
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: fcntl sets a flag of a descriptor just made
    unsafe { libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC) };
    (fds[0], fds[1])
}

fn exited_within(child: &mut std::process::Child, d: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if let Some(s) = child.try_wait().unwrap() {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn a_process_whose_lifeline_breaks_exits() {
    let dir = std::env::temp_dir().join(format!("sgtest-lifeline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let sock = dir.join("s.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (r, w) = lifeline();

    // A job for a serving process that never answers: the client waits on it for minutes
    let mut child = Command::new(env!("CARGO_BIN_EXE_snowglobe-vm"))
        .args(["run", "--server", sock.to_str().unwrap(), "--workspace", dir.join("ws").to_str().unwrap(), "--cmd", "sleep 600"])
        .env("SNOWGLOBE_LIFELINE", r.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // SAFETY: this process's copy of the read end, no longer needed
    unsafe { libc::close(r) };
    let (conn, _) = listener.accept().unwrap();
    let mut line = String::new();
    BufReader::new(&conn).read_line(&mut line).unwrap();
    assert!(line.contains("sleep 600"), "{line}");

    // Held: it waits
    assert!(exited_within(&mut child, Duration::from_millis(300)).is_none(), "it ended with its lifeline held");
    // SAFETY: the only write end of the lifeline, closed once: as if this process had died
    unsafe { libc::close(w) };
    let status = exited_within(&mut child, Duration::from_secs(3)).expect("it outlived its lifeline");
    assert_eq!(status.code(), Some(128 + libc::SIGTERM));
    let mut said = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut said).unwrap();
    assert!(said.contains("is gone: stopping"), "{said}");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn without_a_lifeline_nothing_changes() {
    // An open descriptor that isn't a lifeline's number, or none: no watching, an ordinary run
    let out = Command::new(env!("CARGO_BIN_EXE_snowglobe-vm"))
        .args(["run", "--server", "/nonexistent/s.sock", "--workspace", "/", "--cmd", "x"])
        .env("SNOWGLOBE_LIFELINE", "4000")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("/nonexistent/s.sock"));
}
