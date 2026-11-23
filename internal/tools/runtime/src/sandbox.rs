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

#[derive(Clone)]
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
    /// Directories nothing may be read from but what `read` and `write` grant: what Landlock
    /// denies anyway (everything not granted), and Seatbelt, which otherwise denies reads only
    /// of the home directory, must be told (a serving process's jobs root, for each job)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub hidden: Vec<PathBuf>,
}

/// Which part of the sandbox to apply: all of it (a run), or split around fork (`serve`): the
/// parent takes what its children inherit and still lets it fork (no_new_privs, Landlock); each
/// child adds what forbids new processes (seccomp, Seatbelt) before it starts a thread. A child
/// that runs one job (`Job`) also narrows the filesystem to that job's own (a Landlock ruleset of
/// its own on top of its server's, or its Seatbelt profile): its workspace, not the rest of the
/// jobs root, where other jobs' workspaces and secrets are.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Whole,
    Parent,
    Child,
    Job,
}

/// Apply the policy. Returns what is in force, for the run's banner.
pub fn apply(p: &Policy) -> Result<String, String> {
    apply_stage(p, Stage::Whole)
}

pub fn apply_stage(p: &Policy, stage: Stage) -> Result<String, String> {
    let mode = std::env::var("SNOWGLOBE_SANDBOX").unwrap_or_default();
    if mode == "off" {
        return Ok("not sandboxed (SNOWGLOBE_SANDBOX=off)".into());
    }
    let mut p = p.clone();
    p.write.extend(scratch());
    for d in &p.write {
        let _ = std::fs::create_dir_all(d);
    }
    let (applied, missing) = imp::apply(&p, stage);
    report(&applied, &missing, mode == "strict")
}

/// A directory of the user's for the runtime's temporary files, writable in the sandbox, and the
/// temporary directory from now on (TMPDIR): armless keeps the files of the machine's filesystem
/// it decompressed in a file of its own there (unlinked as soon as it is made, so one directory
/// serves every run), in the page cache rather than the process's memory, where the sandbox let
/// it make none. None if it can't be made private.
fn scratch() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        // SAFETY: getuid has no preconditions.
        #[allow(unsafe_code)]
        let uid = unsafe { libc::getuid() };
        let dir = std::env::temp_dir().join(format!("snowglobe-scratch-{uid}"));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        // Only a directory of this user's, private to it: another user's (made first, in a shared
        // /tmp) would see the files
        let m = std::fs::symlink_metadata(&dir).ok()?;
        if !m.is_dir() || m.uid() != uid || m.permissions().mode() & 0o077 != 0 {
            return None;
        }
        std::env::set_var("TMPDIR", &dir);
        Some(dir)
    }
    #[cfg(not(unix))]
    None
}

/// What is in force, for the run's banner; with `strict`, an error if any part is missing.
fn report(applied: &[String], missing: &[String], strict: bool) -> Result<String, String> {
    if strict && !missing.is_empty() {
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
    use crate::sys::{self, Insn, RulesetAttr};
    use std::os::fd::AsFd;
    use std::os::unix::fs::OpenOptionsExt;

    pub fn apply(p: &Policy, stage: Stage) -> (Vec<String>, Vec<String>) {
        let mut applied = Vec::new();
        let mut missing = Vec::new();
        if stage == Stage::Whole || stage == Stage::Parent {
            // Needed for both Landlock and seccomp without privileges
            if sys::no_new_privs() {
                applied.push("no_new_privs".to_string());
            } else {
                missing.push("no_new_privs".to_string());
            }
            match landlock(p) {
                Ok(what) => applied.push(what),
                Err(e) => missing.push(format!("landlock ({e})")),
            }
            rlimits();
        }
        if stage == Stage::Job {
            match landlock(p) {
                Ok(what) => applied.push(format!("{what} for this job")),
                Err(e) => missing.push(format!("landlock for this job ({e})")),
            }
        }
        if stage != Stage::Parent {
            // A job (or a machine) confined to its own: no new Unix socket either, so nothing it
            // runs can connect to its server's, or another machine's, control socket
            match seccomp(stage == Stage::Job) {
                Ok(()) => applied.push("seccomp".to_string()),
                Err(e) => missing.push(format!("seccomp ({e})")),
            }
        }
        (applied, missing)
    }

    fn rlimits() {
        // No core dumps (guest memory, the site's secrets), and a bound on open files
        sys::no_core_dumps();
        sys::cap_open_files(4096);
    }

    // Landlock's rights (linux/landlock.h)

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
    const FS_IOCTL_DEV: u64 = 1 << 15;
    /// Rights a rule on a file (not a directory) may carry
    const FS_FILE: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;
    const NET_BIND_TCP: u64 = 1 << 0;
    const NET_CONNECT_TCP: u64 = 1 << 1;
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    const SCOPE_SIGNAL: u64 = 1 << 1;

    fn landlock(p: &Policy) -> Result<String, String> {
        let abi = sys::landlock_abi();
        if abi < 1 {
            return Err("not in this kernel".into());
        }
        let (attr, size) = ruleset(abi, p.network);
        let ruleset = sys::landlock_ruleset(&attr, size).map_err(|e| e.to_string())?;
        let RulesetAttr { fs, net, scoped } = attr;
        for (path, allowed) in rules(p) {
            // O_PATH: a handle on the file or directory, not opened for reading
            let Ok(parent) = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_PATH | libc::O_CLOEXEC).open(&path)
            else {
                continue; // not on this system
            };
            let allowed = if path.is_dir() { allowed } else { allowed & FS_FILE } & fs;
            sys::landlock_allow_path(ruleset.as_fd(), parent.as_fd(), allowed);
        }
        if net != 0 {
            for &port in &p.bind {
                sys::landlock_allow_port(ruleset.as_fd(), port, NET_BIND_TCP);
            }
        }
        sys::landlock_restrict(ruleset.as_fd()).map_err(|e| e.to_string())?;
        let mut what = vec!["fs"];
        if net != 0 {
            what.push(if p.network { "tcp listen" } else { "tcp" });
        }
        if scoped != 0 {
            what.push("signals");
        }
        Ok(format!("landlock v{abi} ({})", what.join(", ")))
    }

    /// The rights a ruleset handles (every one this kernel's Landlock `abi` knows: denied unless
    /// a rule grants it), and the size of its attribute for that ABI.
    fn ruleset(abi: i64, network: bool) -> (RulesetAttr, usize) {
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
            NET_BIND_TCP | if network { 0 } else { NET_CONNECT_TCP }
        } else {
            0
        };
        let scoped = if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 };
        let size = match abi {
            1..=3 => 8,
            4 | 5 => 16,
            _ => 24,
        };
        (RulesetAttr { fs, net, scoped }, size)
    }

    /// The paths a policy grants, with their rights.
    fn rules(p: &Policy) -> Vec<(PathBuf, u64)> {
        let read = FS_READ_FILE | FS_READ_DIR;
        let mut rules: Vec<(PathBuf, u64)> = p.read.iter().map(|d| (d.clone(), read)).collect();
        rules.push(("/dev/urandom".into(), FS_READ_FILE));
        rules.push(("/dev/null".into(), FS_READ_FILE | FS_WRITE_FILE));
        for d in &p.write {
            let mut rights = read | FS_WRITE_FILE | FS_TRUNCATE | FS_MAKE_REG | FS_MAKE_DIR | FS_REMOVE_FILE | FS_REMOVE_DIR | (1 << 13);
            // A device written (a GPU's, `machine::gpu_paths`) is driven by ioctl, which Landlock
            // (ABI 5, Linux 6.10) denies on devices opened after it unless granted
            if d.starts_with("/dev") {
                rights |= FS_IOCTL_DEV;
            }
            rules.push((d.clone(), rights));
        }
        if let Some(d) = &p.socket_dir {
            rules.push((d.clone(), FS_MAKE_SOCK | FS_REMOVE_FILE));
        }
        if p.network {
            rules.extend(network_reads().into_iter().map(|d| (d, read)));
        }
        rules
    }

    // seccomp-bpf

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
        let v = vec![
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
        let v = [v, vec![libc::SYS_fork, libc::SYS_vfork, libc::SYS_uselib, libc::SYS_iopl, libc::SYS_ioperm, libc::SYS_modify_ldt]]
            .concat();
        v
    }

    fn seccomp(no_unix: bool) -> Result<(), String> {
        // no_new_privs is set
        sys::seccomp(&program(no_unix)?).map_err(|e| e.to_string())
    }

    /// The seccomp filter, assembled. With `no_unix`, socket(AF_UNIX) is refused too.
    fn program(no_unix: bool) -> Result<Vec<Insn>, String> {
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
        if no_unix {
            at(None, JEQ, libc::SYS_socket as u32, J::To("socket"), J::Next);
        }
        at(None, JEQ, libc::SYS_clone as u32, J::To("clone"), J::Next);
        // clone3's flags are behind a pointer: have the C library fall back to clone
        at(None, JEQ, libc::SYS_clone3 as u32, J::To("nosys"), J::Next);
        at(None, RET, ALLOW, J::Next, J::Next);
        // Threads only: no new processes, no namespaces
        at(Some("clone"), LD_W_ABS, ARG0, J::Next, J::Next);
        at(None, JSET, namespaces, J::To("deny"), J::Next);
        at(None, JSET, libc::CLONE_THREAD as u32, J::To("allow"), J::To("deny"));
        if no_unix {
            at(Some("socket"), LD_W_ABS, ARG0, J::Next, J::Next);
            at(None, JEQ, libc::AF_UNIX as u32, J::To("deny"), J::To("allow"));
        }
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
        Ok(prog)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The filter's answer to a call, worked out as the kernel would (for the instructions
        /// the filter uses).
        fn verdict(prog: &[Insn], arch: u32, nr: libc::c_long, arg0: u32) -> u32 {
            let (mut pc, mut a) = (0, 0u32);
            loop {
                let i = prog[pc];
                match i.code {
                    LD_W_ABS => {
                        a = match i.k {
                            0 => nr as u32,
                            4 => arch,
                            16 => arg0,
                            k => panic!("a load of offset {k}"),
                        }
                    },
                    RET => return i.k,
                    JEQ | JSET | JGE => {
                        let taken = match i.code {
                            JEQ => a == i.k,
                            JSET => a & i.k != 0,
                            _ => a >= i.k,
                        };
                        pc += if taken { i.jt } else { i.jf } as usize;
                    },
                    op => panic!("op {op:#x}"),
                }
                pc += 1;
            }
        }

        #[test]
        fn a_ruleset_handles_every_right_its_kernel_knows() {
            let (v1, size) = ruleset(1, false);
            assert_eq!((v1.fs, v1.net, v1.scoped, size), ((1 << 13) - 1, 0, 0, 8));
            assert_eq!(ruleset(3, false).0.fs, ((1 << 13) - 1) | (1 << 13) | FS_TRUNCATE);
            // From v4, TCP: listening only on the forwarded ports, connecting only with a network
            let (v4, size) = ruleset(4, false);
            assert_eq!((v4.net, size), (NET_BIND_TCP | NET_CONNECT_TCP, 16));
            assert_eq!(ruleset(4, true).0.net, NET_BIND_TCP);
            assert_eq!(ruleset(5, false).0.fs & (1 << 15), 1 << 15);
            let (v6, size) = ruleset(6, false);
            assert_eq!((v6.scoped, size), (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL, 24));
        }

        #[test]
        fn rules_grant_reads_writes_and_the_socket_directory() {
            let p = Policy {
                read: vec!["/site".into()],
                write: vec!["/cache".into(), "/dev/dri".into()],
                socket_dir: Some("/sock".into()),
                bind: vec![],
                network: false,
                hidden: vec![],
            };
            let r = rules(&p);
            let rights = |path: &str| r.iter().find(|(p, _)| p == Path::new(path)).map(|(_, a)| *a);
            assert_eq!(rights("/site"), Some(FS_READ_FILE | FS_READ_DIR));
            let cache = rights("/cache").unwrap();
            assert_eq!(cache & (FS_WRITE_FILE | FS_MAKE_DIR | FS_REMOVE_FILE), FS_WRITE_FILE | FS_MAKE_DIR | FS_REMOVE_FILE);
            assert_eq!(cache & FS_EXECUTE, 0, "nothing runs from what a run writes");
            assert_eq!(cache & FS_IOCTL_DEV, 0, "no ioctls but on devices");
            // A GPU's device nodes are driven by ioctl
            assert_eq!(rights("/dev/dri").unwrap() & FS_IOCTL_DEV, FS_IOCTL_DEV);
            assert_eq!(rights("/sock"), Some(FS_MAKE_SOCK | FS_REMOVE_FILE));
            assert_eq!(rights("/dev/urandom"), Some(FS_READ_FILE));
            assert_eq!(rights("/etc/resolv.conf"), None);
            // A network reads DNS configuration and TLS roots
            assert!(rules(&Policy { network: true, ..p }).iter().any(|(p, _)| p == Path::new("/etc/resolv.conf")));
        }

        #[test]
        fn the_filter_refuses_new_programs_and_processes_but_not_threads() {
            let p = program(false).unwrap();
            let call = |nr, arg0| verdict(&p, ARCH, nr, arg0);
            // A server's children may make Unix sockets (a machine binds its control socket)
            assert_eq!(call(libc::SYS_socket, libc::AF_UNIX as u32), ALLOW);
            assert_eq!(call(libc::SYS_read, 0), ALLOW);
            assert_eq!(call(libc::SYS_openat, 0), ALLOW);
            for nr in denied() {
                assert_eq!(call(nr, 0), errno(libc::EPERM), "{nr}");
            }
            // clone3: the C library falls back to clone, whose flags the filter can see
            assert_eq!(call(libc::SYS_clone3, 0), errno(libc::ENOSYS));
            let thread = (libc::CLONE_VM | libc::CLONE_FS | libc::CLONE_FILES | libc::CLONE_SIGHAND | libc::CLONE_THREAD) as u32;
            assert_eq!(call(libc::SYS_clone, thread), ALLOW);
            assert_eq!(call(libc::SYS_clone, libc::SIGCHLD as u32), errno(libc::EPERM), "fork");
            assert_eq!(call(libc::SYS_clone, thread | libc::CLONE_NEWUSER as u32), errno(libc::EPERM), "a namespace");
            // Calls of another architecture end the process
            assert_eq!(verdict(&p, 0x1234, libc::SYS_read, 0), KILL_PROCESS);
        }

        #[test]
        fn a_confined_job_makes_no_unix_socket_but_still_tcp() {
            let p = program(true).unwrap();
            let call = |nr, arg0| verdict(&p, ARCH, nr, arg0);
            assert_eq!(call(libc::SYS_socket, libc::AF_UNIX as u32), errno(libc::EPERM));
            assert_eq!(call(libc::SYS_socket, libc::AF_INET as u32), ALLOW);
            assert_eq!(call(libc::SYS_socket, libc::AF_INET6 as u32), ALLOW);
            // The rest as before
            assert_eq!(call(libc::SYS_read, 0), ALLOW);
            assert_eq!(call(libc::SYS_clone, libc::SIGCHLD as u32), errno(libc::EPERM));
            assert_eq!(call(libc::SYS_execve, 0), errno(libc::EPERM));
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::CString;

    fn quoted(p: &Path) -> String {
        let p = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        format!("\"{}\"", p.display().to_string().replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// The Seatbelt profile for a policy, `home` the user's home directory. `job`: a job (or a
    /// machine) confined to its own, which may connect to no Unix socket (what seccomp's refusal
    /// of socket(AF_UNIX) is on Linux): not its server's control socket, not another machine's.
    /// With a network, the system's DNS resolver's socket only, which the host's lookups use.
    pub fn profile(p: &Policy, home: Option<&Path>, job: bool) -> String {
        let subpaths = |v: &[PathBuf]| v.iter().map(|d| format!("(subpath {})", quoted(d))).collect::<Vec<_>>().join(" ");
        let mut writable = p.write.clone();
        writable.extend(p.socket_dir.iter().cloned());
        let mut readable = p.read.clone();
        readable.extend(writable.iter().cloned());
        if p.network {
            readable.extend(network_reads());
        }
        // Later rules take precedence over earlier ones
        let mut profile = String::from("(version 1)\n(allow default)\n(deny process-exec*)\n(deny process-fork)\n");
        profile += &format!(
            "(deny file-write*)\n(allow file-write* (subpath \"/dev\") {})\n",
            subpaths(&writable)
        );
        if !p.hidden.is_empty() {
            profile += &format!("(deny file-read* {})\n", subpaths(&p.hidden));
            if home.is_none() && !readable.is_empty() {
                profile += &format!("(allow file-read* {})\n", subpaths(&readable));
            }
        }
        if let Some(home) = home {
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
        if job {
            profile += "(deny network-outbound (remote unix-socket))\n";
            if p.network {
                profile += "(allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n";
            }
        }
        profile
    }

    pub fn apply(p: &Policy, stage: Stage) -> (Vec<String>, Vec<String>) {
        // Seatbelt forbids forking, so a parent leaves it to each child
        if stage == Stage::Parent {
            return (vec!["seatbelt per job".into()], vec![]);
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let Ok(c) = CString::new(profile(p, home.as_deref(), stage == Stage::Job)) else {
            return (vec![], vec!["seatbelt".into()]);
        };
        match crate::sys::seatbelt(&c) {
            Ok(()) => {
            let mut what = vec!["exec", "writes"];
            if home.is_some() {
                what.push("home reads");
            }
            if !p.network {
                what.push("network");
            }
            if stage == Stage::Job {
                what.push("unix sockets");
            }
            (vec![format!("seatbelt ({})", what.join(", "))], vec![])
            },
            Err(msg) => (vec![], vec![format!("seatbelt ({})", msg.trim())]),
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::*;
    pub fn apply(_: &Policy, _: Stage) -> (Vec<String>, Vec<String>) {
        (vec![], vec!["a sandbox for this system".into()])
    }
}

/// The directory a path is in, for a socket made there.
pub fn parent_of(p: &Path) -> Option<PathBuf> {
    p.parent().map(|d| if d.as_os_str().is_empty() { PathBuf::from(".") } else { d.to_path_buf() })
}

/// `snowglobe-vm sandbox-check`: sandbox this process as a run without a network would be, then
/// try what it must not be able to do. Exits non-zero if any of it worked.
///
/// `--forked` checks the split a serving process uses: the parent's stage, a fork, then the
/// child's stage, and the attempts made in the child.
pub fn check(forked: bool) -> Result<u8, String> {
    let scratch = std::env::temp_dir().join(format!("snowglobe-sandbox-check-{}", std::process::id()));
    let allowed = scratch.join("cache");
    let policy = Policy { read: vec![], write: vec![allowed.clone()], socket_dir: None, bind: vec![], network: false, hidden: vec![] };
    if forked {
        println!("parent: {}", apply_stage(&policy, Stage::Parent)?);
        // Single-threaded here; the child runs the checks and exits
        match crate::sys::fork().map_err(|e| format!("fork: {e}"))? {
            crate::sys::Forked::Child => {
                let code = apply_stage(&policy, Stage::Child).map_or(2, |s| {
                    println!("child: {s}");
                    attempts(&scratch, &allowed)
                });
                let _ = std::io::Write::flush(&mut std::io::stdout());
                // Leave the child without unwinding into the parent's code
                crate::sys::exit_now(code as i32);
            },
            crate::sys::Forked::Parent(pid) => {
                let code = crate::sys::wait(pid, true).and_then(|(_, code)| code);
                return Ok(code.map_or(1, |c| c as u8));
            },
        }
    }
    println!("{}", apply(&policy)?);
    Ok(attempts(&scratch, &allowed))
}

/// `snowglobe-vm sandbox-check --job`: what a job forked by a serving process can reach of the
/// jobs root. The parent sandboxes itself as a server does (the whole root writable), makes two
/// workspaces in it and forks; the child narrows itself to the first (`Stage::Job`) and tries
/// the second, which another job's would be, what the server shares (its JIT profile cache, its
/// logs) and Unix sockets. Exits non-zero if any of that worked, or if the
/// child couldn't use its own workspace.
pub fn check_job() -> Result<u8, String> {
    let root = std::env::temp_dir().join(format!("snowglobe-sandbox-check-job-{}", std::process::id()));
    let (mine, theirs) = (root.join("job-a"), root.join("job-b"));
    for d in [&mine, &theirs] {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    std::fs::write(theirs.join("env.json"), b"{\"SECRET\":\"x\"}").map_err(|e| e.to_string())?;
    // The server's control socket, which a job must not reach (another job's machine's is the same)
    let sock = root.join("server.sock");
    let _listening = std::os::unix::net::UnixListener::bind(&sock).map_err(|e| format!("{}: {e}", sock.display()))?;
    // And one the job may read the directory of: refused for being a Unix socket, not for its path
    let open_dir = std::env::temp_dir().join(format!("snowglobe-sandbox-check-sock-{}", std::process::id()));
    std::fs::create_dir_all(&open_dir).map_err(|e| format!("{}: {e}", open_dir.display()))?;
    let open_sock = open_dir.join("other.sock");
    let _ = std::fs::remove_file(&open_sock);
    let _listening_too = std::os::unix::net::UnixListener::bind(&open_sock).map_err(|e| format!("{}: {e}", open_sock.display()))?;
    // What the server writes besides the jobs root, as its JIT profile cache and --log-dir are:
    // shared by every job it serves, of every team, so no job may write it
    let shared = std::env::temp_dir().join(format!("snowglobe-sandbox-check-shared-{}", std::process::id()));
    std::fs::create_dir_all(&shared).map_err(|e| format!("{}: {e}", shared.display()))?;
    std::fs::write(shared.join("profile.bin"), b"profile").map_err(|e| e.to_string())?;
    std::fs::write(shared.join("events.jsonl"), b"").map_err(|e| e.to_string())?;
    let server = Policy { read: vec![root.clone()], write: vec![root.clone(), shared.clone()], socket_dir: None, bind: vec![], network: false, hidden: vec![] };
    println!("server: {}", apply_stage(&server, Stage::Parent)?);
    match crate::sys::fork().map_err(|e| format!("fork: {e}"))? {
        crate::sys::Forked::Child => {
            let job = Policy { read: vec![mine.clone(), open_dir.clone()], write: vec![mine.clone()], socket_dir: None, bind: vec![], network: false, hidden: vec![root.clone()] };
            let code = apply_stage(&job, Stage::Job).map_or(2, |s| {
                println!("job: {s}");
                let mut escaped = 0u8;
                let mut try_it = |what: String, worked: bool| {
                    println!("  {} {what}", if worked { "ALLOWED" } else { "refused" });
                    escaped += worked as u8;
                };
                try_it(format!("read {}", theirs.join("env.json").display()), std::fs::read(theirs.join("env.json")).is_ok());
                try_it(format!("write {}", theirs.join("x").display()), std::fs::write(theirs.join("x"), b"x").is_ok());
                try_it(format!("list {}", theirs.display()), std::fs::read_dir(&theirs).is_ok());
                try_it(format!("list {}", root.display()), std::fs::read_dir(&root).is_ok());
                try_it(format!("write {}", root.join("x").display()), std::fs::write(root.join("x"), b"x").is_ok());
                try_it(format!("write {}", shared.join("profile.bin").display()), std::fs::write(shared.join("profile.bin"), b"x").is_ok());
                let append = std::fs::OpenOptions::new().append(true).open(shared.join("events.jsonl"));
                try_it(format!("append to {}", shared.join("events.jsonl").display()), append.is_ok());
                try_it(format!("write {}", shared.join("new").display()), std::fs::write(shared.join("new"), b"x").is_ok());
                // No Unix socket reached: seccomp makes none at all (Linux), Seatbelt connects to
                // none (macOS)
                try_it(format!("connect {}", sock.display()), std::os::unix::net::UnixStream::connect(&sock).is_ok());
                try_it(format!("connect {}", open_sock.display()), std::os::unix::net::UnixStream::connect(&open_sock).is_ok());
                let own = std::fs::write(mine.join("out"), b"x").is_ok() && std::fs::read(mine.join("out")).is_ok();
                println!("  {} write and read its own workspace (must work)", if own { "ok" } else { "FAILED" });
                if escaped == 0 && own {
                    0
                } else {
                    1
                }
            });
            let _ = std::io::Write::flush(&mut std::io::stdout());
            crate::sys::exit_now(code as i32);
        },
        crate::sys::Forked::Parent(pid) => {
            let code = crate::sys::wait(pid, true).and_then(|(_, code)| code);
            Ok(code.map_or(1, |c| c as u8))
        },
    }
}

/// What a sandboxed run must not be able to do, tried; 0 if none of it worked.
fn attempts(scratch: &Path, allowed: &Path) -> u8 {
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
    if escaped == 0 && ok && threads {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_is_made_in_its_directory_even_a_relative_one() {
        assert_eq!(parent_of(Path::new("/tmp/s.sock")), Some(PathBuf::from("/tmp")));
        assert_eq!(parent_of(Path::new("s.sock")), Some(PathBuf::from(".")));
        assert_eq!(parent_of(Path::new("/")), None);
    }

    #[test]
    fn the_banner_says_what_is_in_force_and_strict_wants_all_of_it() {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(report(&s(&["landlock", "seccomp"]), &[], true), Ok("sandboxed: landlock, seccomp".into()));
        assert_eq!(report(&[], &[], false), Ok("sandboxed: nothing".into()));
        assert_eq!(
            report(&s(&["seccomp"]), &s(&["landlock (old kernel)"]), false),
            Ok("sandboxed: seccomp (unavailable: landlock (old kernel))".into())
        );
        assert_eq!(
            report(&s(&["seccomp"]), &s(&["landlock (old kernel)"]), true),
            Err("sandbox: landlock (old kernel) unavailable (SNOWGLOBE_SANDBOX=strict)".into())
        );
    }

    #[test]
    fn a_network_reads_dns_and_tls_roots() {
        let reads = network_reads();
        assert!(reads.contains(&PathBuf::from("/etc/resolv.conf")));
        assert!(reads.contains(&PathBuf::from("/etc/ssl")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_seatbelt_profile_denies_programs_writes_home_and_network() {
        let p = Policy {
            read: vec!["/site".into()],
            write: vec!["/cache".into()],
            socket_dir: Some("/sock".into()),
            bind: vec![],
            network: false,
            hidden: vec![],
        };
        let profile = imp::profile(&p, Some(Path::new("/Users/me")), false);
        let lines: Vec<&str> = profile.lines().collect();
        assert_eq!(
            lines,
            [
                "(version 1)",
                "(allow default)",
                "(deny process-exec*)",
                "(deny process-fork)",
                "(deny file-write*)",
                "(allow file-write* (subpath \"/dev\") (subpath \"/cache\") (subpath \"/sock\"))",
                "(deny file-read* (subpath \"/Users/me\"))",
                "(allow file-read* (subpath \"/site\") (subpath \"/cache\") (subpath \"/sock\"))",
                "(allow file-read-metadata (literal \"/Users/me\"))",
                "(deny network-outbound (remote ip))",
            ]
        );
        // With a network: no network rule, and its configuration readable
        let net = imp::profile(&Policy { network: true, ..p }, None, false);
        assert!(!net.contains("network-outbound"));
        assert!(!net.contains("file-read"), "no home, nothing to hide reads from");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_confined_jobs_seatbelt_connects_to_no_unix_socket() {
        let p = Policy { read: vec![], write: vec![], socket_dir: None, bind: vec![], network: false, hidden: vec![] };
        assert!(!imp::profile(&p, None, false).contains("unix-socket"), "a server, a whole run: as before");
        // Its link sockets included: a machine's links come over its daemon's channel (linker.rs),
        // so nothing here opens up for them
        let job = imp::profile(&p, None, true);
        assert!(job.ends_with("(deny network-outbound (remote unix-socket))\n"), "{job}");
        // With a network, the system's resolver only (later rules win)
        let job = imp::profile(&Policy { network: true, ..p }, None, true);
        assert!(job.ends_with("(deny network-outbound (remote unix-socket))\n(allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n"), "{job}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_paths_are_quoted() {
        let p = Policy { read: vec![], write: vec!["/a \"b\"\\c".into()], socket_dir: None, bind: vec![], network: true, hidden: vec![] };
        assert!(imp::profile(&p, None, false).contains(r#"(subpath "/a \"b\"\\c")"#));
    }
}
