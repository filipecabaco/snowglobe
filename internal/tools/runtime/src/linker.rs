//! A machine's links, opened by its daemon.
//!
//! A daemon hands each machine a Unix socket per link (`{"mode":"links"}`), but a machine it
//! confines may connect to no Unix socket (seccomp refuses socket(AF_UNIX), Seatbelt the connect):
//! nothing it runs may reach its server's control socket or another machine's. So the daemon
//! also opens a channel to the machine (`{"mode":"linker"}` on its control socket, answered with
//! `{"linker":true}`), and each connection the guest opens to a link is asked for on it:
//!
//! - the machine sends `{"open":ID,"url":"unix:///PATH"}`, the link's url as the daemon gave it;
//! - the daemon answers `{"id":ID}` with the connection as a descriptor (SCM_RIGHTS), or
//!   `{"id":ID,"error":"..."}` without one;
//! - the machine says `{"got":ID}` once it has the descriptor, and only then does the daemon close
//!   its own copy. A descriptor whose last copy outside is closed while it is on its way may be
//!   taken for garbage and flushed by the kernel (macOS does, when other Unix sockets close
//!   meanwhile): the guest would get a connection that ends at once.
//!
//! The machine connects to nothing: the descriptor is received over a connection it already has,
//! which neither sandbox stops. Without a channel (a machine no daemon runs) the host connects to
//! the link's address itself, as before.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};
use std::net::TcpStream;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use armless::native::Tunnel;
use serde_json::json;

/// How long a link's connection is waited for (the daemon answers at once: a service it wakes
/// takes the connection's bytes once it is up, not before the answer)
const OPEN_WAIT: Duration = Duration::from_secs(30);

type Answer = Result<OwnedFd, String>;

#[derive(Default)]
struct Linker {
    /// The daemon's channel, and which one it is (a daemon started again opens another)
    channel: Mutex<Option<(u64, UnixStream)>>,
    /// Connections asked for and not answered yet
    pending: Mutex<HashMap<u64, Sender<Answer>>>,
    next: AtomicU64,
}

static LINKER: LazyLock<Linker> = LazyLock::new(Linker::default);

/// The host's dialer: a link's connection asked of the daemon, when it has a channel open.
pub fn dialer() -> armless::native::LinkDialer {
    Arc::new(|t: &Tunnel| open(&LINKER, t))
}

fn open(linker: &Linker, t: &Tunnel) -> Option<io::Result<TcpStream>> {
    t.unix_path()?;
    let id = linker.next.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    {
        let mut channel = linker.channel.lock().unwrap();
        let (_, stream) = channel.as_mut()?;
        linker.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = stream.write_all(format!("{}\n", json!({ "open": id, "url": t.url })).as_bytes()) {
            linker.pending.lock().unwrap().remove(&id);
            return Some(Err(e));
        }
    }
    let answer = rx.recv_timeout(OPEN_WAIT);
    linker.pending.lock().unwrap().remove(&id);
    Some(match answer {
        Ok(Ok(fd)) => Ok(TcpStream::from(fd)),
        Ok(Err(e)) => Err(io::Error::new(io::ErrorKind::ConnectionRefused, e)),
        Err(RecvTimeoutError::Timeout) => Err(io::Error::new(io::ErrorKind::TimedOut, "the daemon gave no connection for the link")),
        Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(io::ErrorKind::ConnectionAborted, "the daemon's link channel closed")),
    })
}

/// Serve a daemon's channel (`stream`, its request read) until it closes: its answers go to the
/// connections that wait for them. A newer channel takes over from an older one.
pub fn serve(stream: UnixStream) {
    serve_on(&LINKER, stream)
}

fn serve_on(linker: &Linker, mut stream: UnixStream) {
    let Ok(writer) = stream.try_clone() else { return };
    if stream.write_all(format!("{}\n", json!({ "linker": true })).as_bytes()).is_err() {
        return;
    }
    let Ok(mut acks) = stream.try_clone() else { return };
    let me = linker.next.fetch_add(1, Ordering::SeqCst);
    *linker.channel.lock().unwrap() = Some((me, writer));
    let mut bytes = Vec::new();
    let mut fds = VecDeque::new();
    let mut buf = [0u8; 4096];
    loop {
        match crate::sys::recv_fds(stream.as_fd(), &mut buf, &mut fds) {
            Ok(0) | Err(_) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
        }
        // A descriptor arrives with its answer's first byte: by a whole line, it is here
        while let Some(end) = bytes.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = bytes.drain(..=end).collect();
            let answer: serde_json::Value = serde_json::from_slice(&line).unwrap_or_default();
            let Some(id) = answer["id"].as_u64() else { continue };
            let got = match answer["error"].as_str() {
                Some(e) => Err(e.to_string()),
                None => fds.pop_front().ok_or_else(|| "the daemon's answer came without a connection".to_string()),
            };
            if got.is_ok() {
                // The daemon may let go of its copy now. Written under the lock requests are,
                // so that lines on the channel don't interleave
                let _held = linker.channel.lock().unwrap();
                let _ = acks.write_all(format!("{}\n", json!({ "got": id })).as_bytes());
            }
            if let Some(tx) = linker.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(got);
            }
        }
    }
    let mut channel = linker.channel.lock().unwrap();
    if channel.as_ref().is_some_and(|(id, _)| *id == me) {
        *channel = None;
        // Nothing will answer what is still asked of this one
        linker.pending.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};

    /// Send `line` on `s`, with `fd` if any (as the daemon answers).
    fn send(s: &UnixStream, line: &str, fd: Option<&UnixStream>) {
        let n = crate::sys::send_fd(s.as_fd(), line.as_bytes(), fd.map(|f| f.as_fd())).unwrap();
        assert_eq!(n, line.len());
    }

    fn link(url: &str) -> Tunnel {
        Tunnel { host: Some("db".into()), port: 5432, url: url.into() }
    }

    #[test]
    fn a_link_is_opened_by_the_daemon_over_its_channel() {
        let linker: &'static Linker = Box::leak(Box::default());
        // No channel: the host connects itself, as before
        assert!(open(linker, &link("unix:///l.sock")).is_none());

        let (machine, daemon) = UnixStream::pair().unwrap();
        std::thread::spawn(move || serve_on(linker, machine));
        let mut from = BufReader::new(daemon.try_clone().unwrap());
        let mut line = String::new();
        from.read_line(&mut line).unwrap();
        assert_eq!(line, "{\"linker\":true}\n");

        // The daemon: a connection for l.sock (an echo of its own, a copy kept until the machine
        // says it got it), an error for anything else
        let got: &'static Mutex<Vec<u64>> = Box::leak(Box::default());
        let answered: &'static Mutex<Vec<u64>> = Box::leak(Box::default());
        std::thread::spawn(move || loop {
            let mut line = String::new();
            if from.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let ask: serde_json::Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = ask["got"].as_u64() {
                got.lock().unwrap().push(id);
                continue;
            }
            let id = ask["open"].as_u64().unwrap();
            if ask["url"] == "unix:///l.sock" {
                let (theirs, mut ours) = UnixStream::pair().unwrap();
                answered.lock().unwrap().push(id);
                std::mem::forget(theirs.try_clone().unwrap());
                std::thread::spawn(move || {
                    let mut b = [0u8; 4];
                    ours.read_exact(&mut b).unwrap();
                    ours.write_all(&b).unwrap();
                });
                send(&daemon, &format!("{{\"id\":{id}}}\n"), Some(&theirs));
            } else {
                send(&daemon, &format!("{{\"id\":{id},\"error\":\"not your link\"}}\n"), None);
            }
        });
        // Wait for the channel to be the linker's
        while linker.channel.lock().unwrap().is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        for _ in 0..3 {
            let mut c = open(linker, &link("unix:///l.sock")).unwrap().unwrap();
            c.write_all(b"ping").unwrap();
            let mut b = [0u8; 4];
            c.read_exact(&mut b).unwrap();
            assert_eq!(&b, b"ping");
        }
        let refused = open(linker, &link("unix:///other.sock")).unwrap().unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::ConnectionRefused);
        assert!(refused.to_string().contains("not your link"), "{refused}");
        // A tcp:// link isn't the daemon's to open
        assert!(open(linker, &link("tcp://127.0.0.1:1")).is_none());
        // Each connection received was acknowledged, an error not
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while got.lock().unwrap().len() < 3 && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(*got.lock().unwrap(), *answered.lock().unwrap());
    }

    /// A daemon's channel to `linker`, once the linker holds it: what the daemon reads, and its
    /// end to answer on.
    fn channel(linker: &'static Linker) -> (BufReader<UnixStream>, UnixStream) {
        let held = || linker.channel.lock().unwrap().as_ref().map(|(id, _)| *id);
        let before = held();
        let (machine, daemon) = UnixStream::pair().unwrap();
        std::thread::spawn(move || serve_on(linker, machine));
        let mut from = BufReader::new(daemon.try_clone().unwrap());
        from.get_ref().set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut line = String::new();
        from.read_line(&mut line).unwrap();
        assert_eq!(line, "{\"linker\":true}\n");
        while held() == before {
            std::thread::sleep(Duration::from_millis(5));
        }
        (from, daemon)
    }

    /// The next request on the channel: its id and url.
    /// The next request on the channel: its id and url (past the machine's "got"s).
    fn asked(from: &mut BufReader<UnixStream>) -> (u64, String) {
        loop {
            let mut line = String::new();
            from.read_line(&mut line).expect("a request on the channel");
            let ask: serde_json::Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = ask["open"].as_u64() {
                return (id, ask["url"].as_str().unwrap().to_string());
            }
        }
    }

    /// A connection that says `what` to whoever gets its other end.
    fn saying(what: &'static str) -> UnixStream {
        let (theirs, mut ours) = UnixStream::pair().unwrap();
        // As the daemon does until the machine has it: a copy kept (here, for the test's run)
        std::mem::forget(theirs.try_clone().unwrap());
        std::thread::spawn(move || {
            ours.write_all(what.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_secs(1));
        });
        theirs
    }

    fn said(mut c: TcpStream, n: usize) -> String {
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut b = vec![0u8; n];
        c.read_exact(&mut b).unwrap();
        String::from_utf8(b).unwrap()
    }

    #[test]
    fn a_channel_that_closes_fails_what_waits_on_it_and_the_host_connects_itself_after() {
        let linker: &'static Linker = Box::leak(Box::default());
        let (mut from, daemon) = channel(linker);
        let waiting = std::thread::spawn(move || {
            let begun = std::time::Instant::now();
            (open(linker, &link("unix:///l.sock")), begun.elapsed())
        });
        asked(&mut from);
        // The daemon goes before it answers
        drop(daemon);
        drop(from);
        let (got, took) = waiting.join().unwrap();
        let e = got.unwrap().unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::ConnectionAborted, "{e}");
        assert!(took < OPEN_WAIT / 2, "failed at once, not at the timeout: {took:?}");
        while linker.channel.lock().unwrap().is_some() {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(open(linker, &link("unix:///l.sock")).is_none(), "no channel: the host's own connect");
        assert!(linker.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn a_newer_channel_takes_over_and_the_older_closing_leaves_it() {
        let linker: &'static Linker = Box::leak(Box::default());
        let (old_from, old) = channel(linker);
        let (mut from, daemon) = channel(linker);
        let ask = |from: &mut BufReader<UnixStream>, daemon: &UnixStream, what: &'static str| {
            let waiting = std::thread::spawn(move || open(linker, &link("unix:///l.sock")).unwrap().unwrap());
            let (id, _) = asked(from);
            send(daemon, &format!("{{\"id\":{id}}}\n"), Some(&saying(what)));
            said(waiting.join().unwrap(), what.len())
        };
        assert_eq!(ask(&mut from, &daemon, "newer"), "newer");
        // The older channel's daemon goes (a daemon started again): the newer stays
        drop(old);
        drop(old_from);
        std::thread::sleep(Duration::from_millis(100));
        assert!(linker.channel.lock().unwrap().is_some());
        assert_eq!(ask(&mut from, &daemon, "still"), "still");
    }

    #[test]
    fn answers_find_their_requests_in_any_order_even_read_together() {
        let linker: &'static Linker = Box::leak(Box::default());
        let (mut from, daemon) = channel(linker);
        let a = std::thread::spawn(move || said(open(linker, &link("unix:///a.sock")).unwrap().unwrap(), 1));
        let b = std::thread::spawn(move || said(open(linker, &link("unix:///b.sock")).unwrap().unwrap(), 1));
        let mut ids = HashMap::new();
        for _ in 0..2 {
            let (id, url) = asked(&mut from);
            ids.insert(url, id);
        }
        // b's answer first, a's right behind it: one read may take both, each with its descriptor
        let (ia, ib) = (ids["unix:///a.sock"], ids["unix:///b.sock"]);
        send(&daemon, &format!("{{\"id\":{ib}}}\n"), Some(&saying("b")));
        send(&daemon, &format!("{{\"id\":{ia}}}\n"), Some(&saying("a")));
        assert_eq!(a.join().unwrap(), "a");
        assert_eq!(b.join().unwrap(), "b");
    }

    #[test]
    fn an_answer_without_its_connection_is_an_error_and_the_next_one_still_works() {
        let linker: &'static Linker = Box::leak(Box::default());
        let (mut from, daemon) = channel(linker);
        let waiting = std::thread::spawn(move || open(linker, &link("unix:///l.sock")).unwrap());
        let (id, _) = asked(&mut from);
        send(&daemon, &format!("{{\"id\":{id}}}\n"), None);
        let e = waiting.join().unwrap().unwrap_err();
        assert!(e.to_string().contains("without a connection"), "{e}");
        // Noise on the channel (an unknown id, a line that isn't JSON) is passed over
        send(&daemon, "{\"id\":999999}\n", None);
        send(&daemon, "not json\n", None);
        let waiting = std::thread::spawn(move || open(linker, &link("unix:///l.sock")).unwrap().unwrap());
        let (id, _) = asked(&mut from);
        send(&daemon, &format!("{{\"id\":{id}}}\n"), Some(&saying("ok")));
        assert_eq!(said(waiting.join().unwrap(), 2), "ok");
    }
}

