//! Every call into the system that Rust can't check, each in a small safe function whose SAFETY
//! comment says why it is sound. The rest of the crate holds no `unsafe` (`#![deny(unsafe_code)]`
//! in main.rs): the terminal's modes and size, fork and its exits, the mapping of a bundle, and
//! the sandbox's system calls (prctl, rlimits, Landlock, seccomp; Seatbelt on macOS).

use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};

// ---------------------------------------------------------------- the user

/// The effective user id of this process.
pub fn euid() -> u32 {
    // SAFETY: geteuid takes nothing and cannot fail
    unsafe { libc::geteuid() }
}

// ---------------------------------------------------------------- the terminal

/// The terminal settings of `fd`, if it is a terminal.
pub fn termios(fd: BorrowedFd) -> Option<libc::termios> {
    // SAFETY: termios is plain C data (integers and arrays of them): all zeroes is a valid value
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: fd is open (borrowed for the call); tcgetattr only writes into `t`
    (unsafe { libc::tcgetattr(fd.as_raw_fd(), &mut t) } == 0).then_some(t)
}

/// `t` as raw mode: no echo, no line editing, no signals from keys.
pub fn make_raw(t: &mut libc::termios) {
    // SAFETY: cfmakeraw only changes the fields of the struct it is given
    unsafe { libc::cfmakeraw(t) }
}

pub fn set_termios(fd: BorrowedFd, t: &libc::termios) {
    // SAFETY: fd is open (borrowed for the call); tcsetattr only reads `t`
    unsafe { libc::tcsetattr(fd.as_raw_fd(), libc::TCSANOW, t) };
}

/// (columns, rows) of the terminal `fd`, if it is one and has a size.
pub fn window_size(fd: BorrowedFd) -> Option<(u16, u16)> {
    let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: fd is open (borrowed for the call); TIOCGWINSZ writes one winsize into `ws`
    let ok = unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCGWINSZ, &mut ws) } == 0;
    (ok && ws.ws_col > 0 && ws.ws_row > 0).then_some((ws.ws_col, ws.ws_row))
}

// ---------------------------------------------------------------- processes

pub enum Forked {
    Child,
    Parent(libc::pid_t),
}

/// fork(2), for a process that has a single thread (`serve::main` before it starts any, and
/// `sandbox::check`): the child is a copy of that one thread.
pub fn fork() -> io::Result<Forked> {
    // SAFETY: fork itself touches no memory of ours. Running Rust on in the child is sound when
    // the process has one thread, as at both callers: no lock or allocator state can be held by
    // another thread that the child doesn't have
    match unsafe { libc::fork() } {
        -1 => Err(io::Error::last_os_error()),
        0 => Ok(Forked::Child),
        pid => Ok(Forked::Parent(pid)),
    }
}

/// End this process now, running nothing of it (no destructors, no atexit): how a forked child
/// leaves without unwinding into its parent's code.
pub fn exit_now(code: i32) -> ! {
    // SAFETY: _exit only ends the process; it has no preconditions
    unsafe { libc::_exit(code) }
}

/// Wait for a child of ours (`pid`, or -1 for any) to end; with `block` false, only look. Its
/// pid and exit code (None: ended by a signal), or None if none has ended or there are none.
pub fn wait(pid: libc::pid_t, block: bool) -> Option<(libc::pid_t, Option<i32>)> {
    let mut status = 0;
    // SAFETY: `status` is an int waitpid may write to; waitpid reads nothing of ours
    let r = unsafe { libc::waitpid(pid, &mut status, if block { 0 } else { libc::WNOHANG }) };
    (r > 0).then(|| (r, libc::WIFEXITED(status).then(|| libc::WEXITSTATUS(status))))
}

// ---------------------------------------------------------------- a mapped file

/// A read-only mapping of a whole file.
pub struct Mmap {
    ptr: *const u8,
    len: usize,
}

// SAFETY: the mapping is read-only and stays mapped until drop: any thread may read it
unsafe impl Send for Mmap {}
// SAFETY: as above; nothing about it changes through a shared reference
unsafe impl Sync for Mmap {}

impl Mmap {
    pub fn of(file: &std::fs::File) -> Option<Mmap> {
        let len = file.metadata().ok()?.len() as usize;
        if len == 0 {
            return None;
        }
        // SAFETY: a new private read-only mapping of an open file, at an address the kernel
        // picks; a bundle is not written while it runs (replacing it makes a new file)
        let ptr = unsafe {
            libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_PRIVATE, file.as_raw_fd(), 0)
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        Some(Mmap { ptr: ptr as *const u8, len })
    }
}

impl std::ops::Deref for Mmap {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        // SAFETY: `len` bytes are mapped readable at `ptr` until drop, and never written
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for Mmap {
    fn drop(&mut self) {
        // SAFETY: the mapping made in `of`, unmapped once; no slice of it outlives `self`
        unsafe { libc::munmap(self.ptr as *mut _, self.len) };
    }
}

// ---------------------------------------------------------------- the sandbox: Linux

#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::os::fd::{FromRawFd, OwnedFd};

    /// No new privileges for this process and its children (setuid programs, file capabilities):
    /// what Landlock and seccomp need without privileges of their own.
    pub fn no_new_privs() -> bool {
        // SAFETY: a prctl with integer arguments only
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 }
    }

    pub fn no_core_dumps() {
        let l = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: setrlimit reads one valid rlimit
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &l) };
    }

    /// At most `max` open files, if the limit is higher.
    pub fn cap_open_files(max: u64) {
        let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: getrlimit writes one rlimit into `cur`
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut cur) } == 0 && cur.rlim_max > max {
            let l = libc::rlimit { rlim_cur: max, rlim_max: max };
            // SAFETY: setrlimit reads one valid rlimit
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &l) };
        }
    }

    // Landlock (linux/landlock.h); the syscall numbers are the same on every architecture
    const SYS_CREATE_RULESET: libc::c_long = 444;
    const SYS_ADD_RULE: libc::c_long = 445;
    const SYS_RESTRICT_SELF: libc::c_long = 446;
    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: u32 = 1;
    const RULE_NET_PORT: u32 = 2;

    /// What a ruleset handles: the rights it denies unless a rule grants them.
    #[repr(C)]
    pub struct RulesetAttr {
        pub fs: u64,
        pub net: u64,
        pub scoped: u64,
    }

    #[repr(C, packed)]
    struct PathBeneath {
        allowed: u64,
        parent_fd: i32,
    }

    #[repr(C)]
    struct NetPort {
        allowed: u64,
        port: u64,
    }

    /// The Landlock ABI this kernel has (below 1: none).
    pub fn landlock_abi() -> i64 {
        // SAFETY: the version query passes no attributes (a null pointer, size 0)
        unsafe { libc::syscall(SYS_CREATE_RULESET, std::ptr::null::<RulesetAttr>(), 0usize, CREATE_RULESET_VERSION) }
    }

    /// A ruleset of `attr`'s first `size` bytes (older ABIs know fewer fields).
    pub fn landlock_ruleset(attr: &RulesetAttr, size: usize) -> io::Result<OwnedFd> {
        let size = size.min(std::mem::size_of::<RulesetAttr>());
        // SAFETY: `attr` is valid for `size` bytes (at most its own size), read during the call
        let fd = unsafe { libc::syscall(SYS_CREATE_RULESET, attr as *const RulesetAttr, size, 0u32) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a new descriptor the kernel just returned, owned by nothing else
        Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
    }

    /// Grant `allowed` beneath the open file or directory `parent`.
    pub fn landlock_allow_path(ruleset: BorrowedFd, parent: BorrowedFd, allowed: u64) {
        let rule = PathBeneath { allowed, parent_fd: parent.as_raw_fd() };
        // SAFETY: both descriptors are open (borrowed); `rule` is a valid path-beneath attribute
        unsafe { libc::syscall(SYS_ADD_RULE, ruleset.as_raw_fd(), RULE_PATH_BENEATH, &rule as *const PathBeneath, 0u32) };
    }

    /// Grant `allowed` on TCP port `port`.
    pub fn landlock_allow_port(ruleset: BorrowedFd, port: u16, allowed: u64) {
        let rule = NetPort { allowed, port: port as u64 };
        // SAFETY: the descriptor is open (borrowed); `rule` is a valid net-port attribute
        unsafe { libc::syscall(SYS_ADD_RULE, ruleset.as_raw_fd(), RULE_NET_PORT, &rule as *const NetPort, 0u32) };
    }

    /// Confine this thread (and the threads it starts) to the ruleset.
    pub fn landlock_restrict(ruleset: BorrowedFd) -> io::Result<()> {
        // SAFETY: the descriptor is open (borrowed); integer arguments only
        if unsafe { libc::syscall(SYS_RESTRICT_SELF, ruleset.as_raw_fd(), 0u32) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// One seccomp-bpf instruction.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Insn {
        pub code: u16,
        pub jt: u8,
        pub jf: u8,
        pub k: u32,
    }

    #[repr(C)]
    struct Prog {
        len: u16,
        filter: *const Insn,
    }

    /// Filter this thread's (and its future threads') system calls through `prog`; needs
    /// no_new_privs.
    pub fn seccomp(prog: &[Insn]) -> io::Result<()> {
        let len = u16::try_from(prog.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let fprog = Prog { len, filter: prog.as_ptr() };
        // SAFETY: `fprog` points at `len` instructions alive for the call; the kernel copies them
        // (and checks the program: a bad one is refused, not run)
        let r = unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog as *const Prog, 0, 0) };
        if r != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- the sandbox: macOS

#[cfg(target_os = "macos")]
extern "C" {
    fn sandbox_init(profile: *const libc::c_char, flags: u64, errorbuf: *mut *mut libc::c_char) -> libc::c_int;
    fn sandbox_free_error(errorbuf: *mut libc::c_char);
}

/// Confine this process to a Seatbelt profile (SBPL text); the error is the system's message.
#[cfg(target_os = "macos")]
pub fn seatbelt(profile: &std::ffi::CStr) -> Result<(), String> {
    let mut err = std::ptr::null_mut();
    // SAFETY: a NUL-terminated profile read during the call; flags 0 means it is SBPL text;
    // `err` is a pointer sandbox_init may set to a message it allocated
    if unsafe { sandbox_init(profile.as_ptr(), 0, &mut err) } == 0 {
        return Ok(());
    }
    if err.is_null() {
        return Err("refused".into());
    }
    // SAFETY: a NUL-terminated message sandbox_init allocated, read before it is freed
    let msg = unsafe { std::ffi::CStr::from_ptr(err) }.to_string_lossy().into_owned();
    // SAFETY: freed once, as sandbox_init's caller must; not read after
    unsafe { sandbox_free_error(err) };
    Err(msg)
}

// ---------------------------------------------------------------- tests' terminals

/// A pseudo-terminal: (master, slave).
#[cfg(test)]
pub fn openpty() -> io::Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
    use std::os::fd::FromRawFd;
    let (mut m, mut s) = (0, 0);
    // SAFETY: openpty writes two descriptors into `m` and `s`; no name, settings or size passed
    let r = unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: two new descriptors openpty just returned, owned by nothing else
    Ok(unsafe { (std::os::fd::OwnedFd::from_raw_fd(m), std::os::fd::OwnedFd::from_raw_fd(s)) })
}

/// Start `cmd` in a session of its own with `tty` as its controlling terminal and stdio, as getty
/// gives a shell. `tty` must stay open until the command is spawned.
#[cfg(all(test, target_os = "linux"))]
pub fn on_terminal(cmd: &mut std::process::Command, tty: BorrowedFd) {
    use std::os::unix::process::CommandExt;
    let fd = tty.as_raw_fd();
    // SAFETY: the hook runs between fork and exec and calls only async-signal-safe functions
    // (setsid, ioctl, dup2) on a descriptor the caller keeps open until spawn returns
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 || libc::ioctl(fd, libc::TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            for to in 0..3 {
                libc::dup2(fd, to);
            }
            Ok(())
        });
    }
}
