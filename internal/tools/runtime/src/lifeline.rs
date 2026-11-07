//! A lifeline: the read end of a pipe whose only write end is held by whoever this process must
//! not outlive, which never writes to it. When that process ends, however it ends (a crash,
//! `kill -9`, the OOM killer), the kernel closes the write end and this end reads end-of-file: the
//! cue to stop, as a stop would stop this process. Linux and macOS alike, which a parent-death
//! signal is not.
//!
//! The snowglobe daemon hands one to every snowglobe-vm it starts, as an inherited descriptor
//! named by `SNOWGLOBE_LIFELINE` (`snowglobe build` hands its snapshot one the same way). A
//! process that serves forks (`--serve`) watches its own from its accept loop (it never starts a
//! thread) and makes another for its children, so that they end with it.

use std::io::Read;
use std::os::fd::{AsFd, OwnedFd};
use std::sync::Mutex;

use crate::sys;

/// The variable naming the inherited descriptor
pub const ENV: &str = "SNOWGLOBE_LIFELINE";

static TAKEN: Mutex<Option<OwnedFd>> = Mutex::new(None);

/// At start, before any thread: take the lifeline this process was given, if any, and unset
/// `ENV` so that nothing it starts takes another descriptor of that number for one.
pub fn take_inherited() {
    let Some(v) = std::env::var_os(ENV) else { return };
    std::env::remove_var(ENV);
    if let Some(fd) = v.to_str().and_then(|s| s.parse().ok()).and_then(sys::inherited) {
        *TAKEN.lock().unwrap() = Some(fd);
    }
}

/// The lifeline this process was given, once.
pub fn inherited() -> Option<OwnedFd> {
    TAKEN.lock().unwrap().take()
}

/// Whether a lifeline that polled readable has broken: what was read was end-of-file (or an
/// error). Data (nobody writes any) is read and ignored.
pub fn broken(fd: &OwnedFd) -> bool {
    let mut buf = [0u8; 64];
    match std::fs::File::from(fd.try_clone().expect("a descriptor")).read(&mut buf) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::Interrupted,
    }
}

/// Watch `fd` from a thread of its own and call `gone` when it breaks. For a process that may
/// start threads (a run, a snapshot, a fork of a serving process once its sandbox is whole).
pub fn watch(fd: OwnedFd, gone: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        let mut f = std::fs::File::from(fd);
        let mut buf = [0u8; 64];
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        gone();
    });
}

/// What a broken lifeline does to a process with nothing of its own to tidy: says why and ends
/// it, as the SIGTERM of a stop would (and with that exit status).
pub fn stop(what: &str) -> ! {
    eprintln!("snowglobe-vm: {what} is gone: stopping");
    sys::exit_now(128 + libc::SIGTERM)
}

/// Wait on a listener and, if there is one, a lifeline: true when the listener has a connection
/// to accept, false when the lifeline broke.
pub fn accept_or_gone(listener: &impl AsFd, line: Option<&OwnedFd>) -> std::io::Result<bool> {
    let Some(line) = line else { return Ok(true) };
    loop {
        let ready = sys::readable(&[listener.as_fd(), line.as_fd()])?;
        if ready[1] && broken(line) {
            return Ok(false);
        }
        if ready[0] {
            return Ok(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_watched_line_breaks_when_its_write_end_closes() {
        let (r, w) = sys::pipe().unwrap();
        let (tx, rx) = mpsc::channel();
        watch(r, move || tx.send(()).unwrap());
        // Held: nothing
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        drop(w);
        rx.recv_timeout(Duration::from_secs(2)).expect("gone once the write end closed");
    }

    #[test]
    fn data_on_a_line_is_not_its_end() {
        use std::io::Write;
        let (r, w) = sys::pipe().unwrap();
        std::fs::File::from(w.try_clone().unwrap()).write_all(b"x").unwrap();
        assert!(!broken(&r));
        drop(w);
        assert!(broken(&r));
    }

    #[test]
    fn a_serving_loop_wakes_for_a_connection_or_a_broken_line() {
        let dir = crate::testing::tmp("lifeline-accept");
        let sock = dir.join("s.sock");
        let l = UnixListener::bind(&sock).unwrap();
        // No line: accept as before
        assert!(accept_or_gone(&l, None).unwrap());
        let (r, w) = sys::pipe().unwrap();
        let _c = std::os::unix::net::UnixStream::connect(&sock).unwrap();
        assert!(accept_or_gone(&l, Some(&r)).unwrap(), "a connection waits");
        l.accept().unwrap();
        // Nothing to accept, the line breaks a moment later
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(w);
        });
        assert!(!accept_or_gone(&l, Some(&r)).unwrap(), "the line broke");
        t.join().unwrap();
    }

    #[test]
    fn an_inherited_line_must_be_an_open_descriptor_past_stdio() {
        assert!(sys::inherited(0).is_none());
        assert!(sys::inherited(2).is_none());
        // A number nothing has open
        assert!(sys::inherited(4000).is_none());
        let (r, _w) = sys::pipe().unwrap();
        let fd = std::os::fd::IntoRawFd::into_raw_fd(r);
        let owned = sys::inherited(fd).expect("an open one");
        assert_eq!(std::os::fd::AsRawFd::as_raw_fd(&owned), fd);
    }
}
