//! The local terminal: raw mode and its size.

use std::os::fd::AsFd;
use std::sync::Mutex;

use crate::sys;

static SAVED: Mutex<Option<libc::termios>> = Mutex::new(None);

/// Put stdin in raw mode (restored by `restore`).
pub fn raw() {
    let stdin = std::io::stdin();
    let Some(mut t) = sys::termios(stdin.as_fd()) else { return };
    SAVED.lock().unwrap().get_or_insert(t);
    sys::make_raw(&mut t);
    sys::set_termios(stdin.as_fd(), &t);
}

pub fn restore() {
    if let Some(t) = SAVED.lock().unwrap().take() {
        sys::set_termios(std::io::stdin().as_fd(), &t);
    }
}

/// (columns, rows) of the terminal on stdout, if it is one.
pub fn size() -> Option<(u16, u16)> {
    sys::window_size(std::io::stdout().as_fd())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::IsTerminal;

    #[test]
    fn a_pipe_is_no_terminal_and_a_pty_is() {
        let (r, _w) = std::io::pipe().unwrap();
        assert!(!r.as_fd().is_terminal());
        let (master, slave) = sys::openpty().unwrap();
        assert!(slave.is_terminal());
        // A pty has settings; raw mode changes them, and they can be put back
        let before = sys::termios(slave.as_fd()).unwrap();
        let mut t = before;
        sys::make_raw(&mut t);
        sys::set_termios(slave.as_fd(), &t);
        assert_eq!(sys::termios(slave.as_fd()).unwrap().c_lflag & libc::ECHO, 0);
        sys::set_termios(slave.as_fd(), &before);
        assert_ne!(sys::termios(slave.as_fd()).unwrap().c_lflag & libc::ECHO, 0);
        assert!(sys::termios(r.as_fd()).is_none());
        // A new pty has no size yet
        assert_eq!(sys::window_size(slave.as_fd()), None);
        drop(master);
    }

    #[test]
    fn a_size_only_for_a_terminal() {
        assert!(size().is_none() || std::io::stdout().is_terminal());
    }

    #[test]
    fn restoring_what_was_never_raw_does_nothing() {
        // stdin is a terminal only when a person runs the tests: leave it alone then
        if !std::io::stdin().is_terminal() {
            raw();
            assert!(SAVED.lock().unwrap().is_none());
        }
        restore();
        assert!(SAVED.lock().unwrap().is_none());
    }
}
