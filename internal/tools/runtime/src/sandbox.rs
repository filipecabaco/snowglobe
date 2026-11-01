//! The process sandboxes itself: what a container (or a microVM) did around it, from inside,
//! with no privileges, so a run is confined on a laptop or inside someone else's container alike.
//!
//! The guest can't reach the host anyway: it is an emulated machine whose only ways out are the
//! 9p filesystem (read from the site, written to memory), the console and the network relay.
//! This is defence in depth for the emulator itself, applied before any thread starts so that
//! every thread (vCPUs, JIT compilers, the host loop) is under it:
//!
//! - Linux: no_new_privs; Landlock, so the filesystem is reduced to what a run reads (the site's
//!   directory, or nothing for a bundle, which is mapped already) and writes (the JIT profile
//!   cache, the control socket), TCP to the ports it forwards (and nothing at all without a
//!   network), and no signals or abstract sockets out of the process (as far as the kernel's
//!   Landlock goes); a seccomp filter refusing new processes and programs (execve, fork), ptrace,
//!   mounts and namespaces, BPF, perf, io_uring, keyrings and kernel modules.
//! - macOS: a Seatbelt profile (sandbox_init): no programs or processes, no writes but the cache
//!   and the socket, no reads of the home directory but those, and no network without one.
//!
//! SNOWGLOBE_SANDBOX=off leaves the process as it is; =strict fails when any part can't be had.

use std::path::{Path, PathBuf};

pub struct Policy {
    /// Directories and files read
    pub read: Vec<PathBuf>,
    /// Directories written (created first)
    pub write: Vec<PathBuf>,
    /// Where the control socket is made (and an old one removed)
    pub socket_dir: Option<PathBuf>,
    /// TCP ports listened on (-p)
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub bind: Vec<u16>,
    /// Whether the guest has a network: TCP out, DNS, TLS roots
    pub network: bool,
}

/// Apply the policy. Returns what is in force, for the run's banner.
pub fn apply(p: &Policy) -> Result<String, String> {
    let mode = std::env::var("SNOWGLOBE_SANDBOX").unwrap_or_default();
    if mode == "off" {
        return Ok("not sandboxed (SNOWGLOBE_SANDBOX=off)".into());
    }
    for d in &p.write {
        let _ = std::fs::create_dir_all(d);
    }
    let (applied, missing) = imp::apply(p);
    if mode == "strict" && !missing.is_empty() {
        return Err(format!("sandbox: {} unavailable (SNOWGLOBE_SANDBOX=strict)", missing.join(", ")));
    }
    let mut s = format!("sandboxed: {}", if applied.is_empty() { "nothing".into() } else { applied.join(", ") });
    if !missing.is_empty() {
        s += &format!(" (unavailable: {})", missing.join(", "));
    }
    Ok(s)
}

/// What a run with a network reads besides the site: DNS configuration and TLS roots.
fn network_reads() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/gai.conf",
        "/etc/host.conf",
        "/etc/ssl",
        "/etc/pki",
        "/etc/ca-certificates",
        "/usr/share/ca-certificates",
        "/usr/lib/ssl",
        "/usr/local/etc/openssl",
        "/opt/homebrew/etc/openssl@3",
        "/run/systemd/resolve",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    for var in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
        if let Some(p) = std::env::var_os(var) {
            v.push(p.into());
        }
    }
    v
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    pub fn apply(p: &Policy) -> (Vec<String>, Vec<String>) {
        let mut applied = Vec::new();
        let mut missing = Vec::new();
        // SAFETY: plain prctl; needed for both Landlock and seccomp without privileges
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0 {
            applied.push("no_new_privs".to_string());
        } else {
            missing.push("no_new_privs".to_string());
        }
        match landlock(p) {
            Ok(what) => applied.push(what),
            Err(e) => missing.push(format!("landlock ({e})")),
        }
        match seccomp() {
            Ok(()) => applied.push("seccomp".to_string()),
            Err(e) => missing.push(format!("seccomp ({e})")),
        }
        rlimits();
        (applied, missing)
    }

    fn rlimits() {
        // No core dumps (guest memory, the site's secrets), and a bound on open files
        let set = |r, v| {
            let l = libc::rlimit { rlim_cur: v, rlim_max: v };
            // SAFETY: setrlimit with a valid struct; lowering only
            unsafe { libc::setrlimit(r, &l) };
        };
        set(libc::RLIMIT_CORE, 0);
        let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: getrlimit into a valid struct
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut cur) } == 0 && cur.rlim_max > 4096 {
            set(libc::RLIMIT_NOFILE, 4096);
        }
    }

    // Landlock (linux/landlock.h); the syscall numbers are the same on every architecture
    const SYS_CREATE_RULESET: libc::c_long = 444;
    const SYS_ADD_RULE: libc::c_long = 445;
    const SYS_RESTRICT_SELF: libc::c_long = 446;
    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: u32 = 1;
    const RULE_NET_PORT: u32 = 2;

    const FS_EXECUTE: u64 = 1 << 0;
    const FS_WRITE_FILE: u64 = 1 << 1;
    const FS_READ_FILE: u64 = 1 << 2;
    const FS_READ_DIR: u64 = 1 << 3;
    const FS_REMOVE_DIR: u64 = 1 << 4;
    const FS_REMOVE_FILE: u64 = 1 << 5;
    const FS_MAKE_DIR: u64 = 1 << 7;
    const FS_MAKE_REG: u64 = 1 << 8;
    const FS_MAKE_SOCK: u64 = 1 << 9;
    const FS_TRUNCATE: u64 = 1 << 14;
    /// Rights a rule on a file (not a directory) may carry
    const FS_FILE: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | (1 << 15);
    const NET_BIND_TCP: u64 = 1 << 0;
    const NET_CONNECT_TCP: u64 = 1 << 1;
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    const SCOPE_SIGNAL: u64 = 1 << 1;

    #[repr(C)]
    struct RulesetAttr {
        fs: u64,
        net: u64,
        scoped: u64,
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

    fn landlock(p: &Policy) -> Result<String, String> {
        // SAFETY: the version query takes no attributes
        let abi = unsafe {
            libc::syscall(SYS_CREATE_RULESET, std::ptr::null::<RulesetAttr>(), 0usize, CREATE_RULESET_VERSION)
        };
        if abi < 1 {
            return Err("not in this kernel".into());
        }
        // Every right this kernel knows, handled (denied unless a rule grants it)
        let mut fs = (1u64 << 13) - 1;
        if abi >= 2 {
            fs |= 1 << 13; // REFER
        }
        if abi >= 3 {
            fs |= FS_TRUNCATE;
        }
        if abi >= 5 {
            fs |= 1 << 15; // IOCTL_DEV
        }
        let net = if abi >= 4 {
            // Listening only on the forwarded ports; connecting only with a network
            NET_BIND_TCP | if p.network { 0 } else { NET_CONNECT_TCP }
        } else {
            0
        };
        let scoped = if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 };
        let attr = RulesetAttr { fs, net, scoped };
        let size = match abi {
            1..=3 => 8,
            4 | 5 => 16,
            _ => 24,
        };
        // SAFETY: attr is valid for `size` bytes
        let fd = unsafe { libc::syscall(SYS_CREATE_RULESET, &attr as *const RulesetAttr, size, 0u32) } as i32;
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let read = FS_READ_FILE | FS_READ_DIR;
        let mut rules: Vec<(PathBuf, u64)> = p.read.iter().map(|d| (d.clone(), read)).collect();
        rules.push(("/dev/urandom".into(), FS_READ_FILE));
        rules.push(("/dev/null".into(), FS_READ_FILE | FS_WRITE_FILE));
        for d in &p.write {
            rules.push((d.clone(), read | FS_WRITE_FILE | FS_TRUNCATE | FS_MAKE_REG | FS_MAKE_DIR | FS_REMOVE_FILE | FS_REMOVE_DIR | (1 << 13)));
        }
        if let Some(d) = &p.socket_dir {
            rules.push((d.clone(), FS_MAKE_SOCK | FS_REMOVE_FILE));
        }
        if p.network {
            rules.extend(network_reads().into_iter().map(|d| (d, read)));
        }
        for (path, allowed) in rules {
            let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { continue };
            // SAFETY: open with O_PATH of a NUL-terminated path
            let pfd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if pfd < 0 {
                continue; // not on this system
            }
            let allowed = if path.is_dir() { allowed } else { allowed & FS_FILE } & fs;
            let rule = PathBeneath { allowed, parent_fd: pfd };
            // SAFETY: rule is a valid path-beneath attribute
            unsafe {
                libc::syscall(SYS_ADD_RULE, fd, RULE_PATH_BENEATH, &rule as *const PathBeneath, 0u32);
                libc::close(pfd);
            }
        }
        if net != 0 {
            for &port in &p.bind {
                let rule = NetPort { allowed: NET_BIND_TCP, port: port as u64 };
                // SAFETY: rule is a valid net-port attribute
                unsafe { libc::syscall(SYS_ADD_RULE, fd, RULE_NET_PORT, &rule as *const NetPort, 0u32) };
            }
        }
        // SAFETY: fd is the ruleset made above
        let r = unsafe { libc::syscall(SYS_RESTRICT_SELF, fd, 0u32) };
        unsafe { libc::close(fd) };
        if r != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut what = vec!["fs"];
        if net != 0 {
            what.push(if p.network { "tcp listen" } else { "tcp" });
        }
        if scoped != 0 {
            what.push("signals");
        }
        Ok(format!("landlock v{abi} ({})", what.join(", ")))
    }

    // seccomp-bpf
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Insn {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }
    #[repr(C)]
    struct Prog {
        len: u16,
        filter: *const Insn,
    }

    const LD_W_ABS: u16 = 0x20;
    const JEQ: u16 = 0x15;
    const JSET: u16 = 0x45;
    const JGE: u16 = 0x35;
    const RET: u16 = 0x06;
    const ALLOW: u32 = 0x7fff_0000;
    const KILL_PROCESS: u32 = 0x8000_0000;
    const fn errno(e: i32) -> u32 {
        0x0005_0000 | (e as u32 & 0xffff)
    }

    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc000_00b7;

    /// Calls a run never makes, refused (EPERM) rather than fatal, so a library probing for
    /// one carries on
    fn denied() -> Vec<libc::c_long> {
        let mut v = vec![
            libc::SYS_execve,
            libc::SYS_execveat,
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_chroot,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_bpf,
            libc::SYS_perf_event_open,
            libc::SYS_kexec_load,
            libc::SYS_init_module,
            libc::SYS_finit_module,
            libc::SYS_delete_module,
            libc::SYS_keyctl,
            libc::SYS_add_key,
            libc::SYS_request_key,
            libc::SYS_userfaultfd,
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
            libc::SYS_open_by_handle_at,
            libc::SYS_name_to_handle_at,
            libc::SYS_swapon,
            libc::SYS_swapoff,
            libc::SYS_reboot,
            libc::SYS_acct,
            libc::SYS_quotactl,
            libc::SYS_syslog,
            libc::SYS_fsopen,
            libc::SYS_fsmount,
            libc::SYS_move_mount,
            libc::SYS_open_tree,
            libc::SYS_fsconfig,
            libc::SYS_fspick,
            libc::SYS_pidfd_getfd,
        ];
        #[cfg(target_arch = "x86_64")]
        v.extend([
            libc::SYS_fork,
            libc::SYS_vfork,
            libc::SYS_uselib,
            libc::SYS_iopl,
            libc::SYS_ioperm,
            libc::SYS_modify_ldt,
        ]);
        v
    }

    fn seccomp() -> Result<(), String> {
        const NR: u32 = 0;
        const ARCH_OFF: u32 = 4;
        const ARG0: u32 = 16;
        let namespaces = (libc::CLONE_NEWNS
            | libc::CLONE_NEWUSER
            | libc::CLONE_NEWPID
            | libc::CLONE_NEWNET
            | libc::CLONE_NEWIPC
            | libc::CLONE_NEWUTS
            | libc::CLONE_NEWCGROUP) as u32;

        // Assembled with labels: a jump names where it goes, resolved at the end
        enum J {
            Next,
            To(&'static str),
        }
        let mut code: Vec<(u16, u32, J, J, Option<&'static str>)> = Vec::new();
        let mut at = |label: Option<&'static str>, op: u16, k: u32, t: J, f: J| code.push((op, k, t, f, label));
        at(None, LD_W_ABS, ARCH_OFF, J::Next, J::Next);
        at(None, JEQ, ARCH, J::Next, J::To("kill"));
        at(None, LD_W_ABS, NR, J::Next, J::Next);
        #[cfg(target_arch = "x86_64")]
        at(None, JGE, 0x4000_0000, J::To("deny"), J::Next); // the x32 ABI
        #[cfg(not(target_arch = "x86_64"))]
        let _ = JGE;
        for nr in denied() {
            at(None, JEQ, nr as u32, J::To("deny"), J::Next);
        }
        at(None, JEQ, libc::SYS_clone as u32, J::To("clone"), J::Next);
        // clone3's flags are behind a pointer: have the C library fall back to clone
        at(None, JEQ, libc::SYS_clone3 as u32, J::To("nosys"), J::Next);
        at(None, RET, ALLOW, J::Next, J::Next);
        // Threads only: no new processes, no namespaces
        at(Some("clone"), LD_W_ABS, ARG0, J::Next, J::Next);
        at(None, JSET, namespaces, J::To("deny"), J::Next);
        at(None, JSET, libc::CLONE_THREAD as u32, J::To("allow"), J::To("deny"));
        at(Some("allow"), RET, ALLOW, J::Next, J::Next);
        at(Some("deny"), RET, errno(libc::EPERM), J::Next, J::Next);
        at(Some("nosys"), RET, errno(libc::ENOSYS), J::Next, J::Next);
        at(Some("kill"), RET, KILL_PROCESS, J::Next, J::Next);

        let index = |l: &str| code.iter().position(|c| c.4 == Some(l)).unwrap();
        let mut prog = Vec::new();
        for (i, (op, k, t, f, _)) in code.iter().enumerate() {
            let rel = |j: &J| -> Result<u8, String> {
                match j {
                    J::Next => Ok(0),
                    J::To(l) => u8::try_from(index(l) - i - 1).map_err(|_| "filter too long".to_string()),
                }
            };
            let (jt, jf) = if *op == RET || *op == LD_W_ABS { (0, 0) } else { (rel(t)?, rel(f)?) };
            prog.push(Insn { code: *op, jt, jf, k: *k });
        }
        let fprog = Prog { len: prog.len() as u16, filter: prog.as_ptr() };
        // SAFETY: a valid filter program; no_new_privs is set
        let r = unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog as *const Prog, 0, 0) };
        if r != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::{CStr, CString};

    extern "C" {
        fn sandbox_init(profile: *const libc::c_char, flags: u64, errorbuf: *mut *mut libc::c_char) -> libc::c_int;
        fn sandbox_free_error(errorbuf: *mut libc::c_char);
    }

    fn quoted(p: &Path) -> String {
        let p = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        format!("\"{}\"", p.display().to_string().replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn apply(p: &Policy) -> (Vec<String>, Vec<String>) {
        let subpaths = |v: &[PathBuf]| v.iter().map(|d| format!("(subpath {})", quoted(d))).collect::<Vec<_>>().join(" ");
        let mut writable = p.write.clone();
        writable.extend(p.socket_dir.iter().cloned());
        let mut readable = p.read.clone();
        readable.extend(writable.iter().cloned());
        if p.network {
            readable.extend(network_reads());
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // Later rules take precedence over earlier ones
        let mut profile = String::from("(version 1)\n(allow default)\n(deny process-exec*)\n(deny process-fork)\n");
        profile += &format!(
            "(deny file-write*)\n(allow file-write* (subpath \"/dev\") {})\n",
            subpaths(&writable)
        );
        if let Some(home) = &home {
            profile += &format!("(deny file-read* (subpath {}))\n", quoted(home));
            if !readable.is_empty() {
                profile += &format!("(allow file-read* {})\n", subpaths(&readable));
            }
            // The home directory itself (not what is in it), which path lookups stat
            profile += &format!("(allow file-read-metadata (literal {}))\n", quoted(home));
        }
        if !p.network {
            profile += "(deny network-outbound (remote ip))\n";
        }
        let Ok(c) = CString::new(profile) else {
            return (vec![], vec!["seatbelt".into()]);
        };
        let mut err = std::ptr::null_mut();
        // SAFETY: a NUL-terminated profile; flags 0 means it is SBPL text
        if unsafe { sandbox_init(c.as_ptr(), 0, &mut err) } == 0 {
            let mut what = vec!["exec", "writes"];
            if home.is_some() {
                what.push("home reads");
            }
            if !p.network {
                what.push("network");
            }
            (vec![format!("seatbelt ({})", what.join(", "))], vec![])
        } else {
            let msg = if err.is_null() {
                "refused".to_string()
            } else {
                // SAFETY: the error sandbox_init returned, freed after copying
                let m = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
                unsafe { sandbox_free_error(err) };
                m
            };
            (vec![], vec![format!("seatbelt ({})", msg.trim())])
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::*;
    pub fn apply(_: &Policy) -> (Vec<String>, Vec<String>) {
        (vec![], vec!["a sandbox for this system".into()])
    }
}

/// The directory a path is in, for a socket made there.
pub fn parent_of(p: &Path) -> Option<PathBuf> {
    p.parent().map(|d| if d.as_os_str().is_empty() { PathBuf::from(".") } else { d.to_path_buf() })
}

/// `snowglobe-vm sandbox-check`: sandbox this process as a run without a network would be, then
/// try what it must not be able to do. Exits non-zero if any of it worked.
pub fn check() -> Result<u8, String> {
    let scratch = std::env::temp_dir().join(format!("snowglobe-sandbox-check-{}", std::process::id()));
    let allowed = scratch.join("cache");
    let state = apply(&Policy {
        read: vec![],
        write: vec![allowed.clone()],
        socket_dir: None,
        bind: vec![],
        network: false,
    })?;
    println!("{state}");
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/root".into());
    let mut escaped = 0;
    let mut try_it = |what: &str, worked: bool| {
        println!("  {} {what}", if worked { "ALLOWED" } else { "refused" });
        escaped += worked as u8;
    };
    try_it(&format!("list {}", home.display()), std::fs::read_dir(&home).is_ok());
    // macOS: system files stay readable (the profile denies the home directory, not everything)
    if cfg!(target_os = "linux") {
        try_it("read /etc/passwd", std::fs::read("/etc/passwd").is_ok());
    }
    try_it(&format!("write {}", scratch.join("outside").display()), std::fs::write(scratch.join("outside"), b"x").is_ok());
    try_it("run /bin/sh", std::process::Command::new("/bin/sh").arg("-c").arg("true").status().is_ok());
    try_it("connect to 1.1.1.1:443", std::net::TcpStream::connect_timeout(&"1.1.1.1:443".parse().unwrap(), std::time::Duration::from_secs(2)).is_ok());
    let ok = std::fs::write(allowed.join("profile"), b"x").is_ok();
    println!("  {} write the cache (must work)", if ok { "ok" } else { "FAILED" });
    let threads = std::thread::spawn(|| 1).join().is_ok();
    println!("  {} start a thread (must work)", if threads { "ok" } else { "FAILED" });
    Ok(if escaped == 0 && ok && threads { 0 } else { 1 })
}
