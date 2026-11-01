//! Jobs: files into a guest, a command run there, its output, exit status and `out/` back. The
//! shape of a sandboxed job runner's run (Exclave's, say), and what `snowglobe sh`, `snowglobe cp`
//! and `snowglobe mcp` are made of.
//!
//! A job runs on the guest's serial root shell (ttyS0), which every snowglobe guest has beside its
//! app (the app's terminal, hvc0, is left alone): so jobs work whatever the app is, a shell or a
//! REPL. With the environment the app gets: a login PATH, /etc/profile, and the image's own ENV
//! (the exports of the app's console script).
//!
//! The job's files are written into the guest from the host (no console, no quoting) under
//! /sgjob/<id>, a directory its kernel has never seen (it caches what it has, so new files appear
//! only in a new directory), and `EXCLAVE_WORKSPACE` names it. Only `sh <launcher>` is typed. The
//! launcher starts the command in a session of its own (setsid; else a process group of its own),
//! waits for it, syncs what it wrote, then prints a marker with its status, which the echo of the
//! typed line can't contain. One job at a time per machine.
//!
//! Out of time (or the instance stopping), the host types ctrl-c: the launcher, in the terminal's
//! foreground, traps it and kills the command's session and process group, TERM and then KILL
//! after 3 s, so nothing the command started is left running (short of a process that made a
//! session of its own: a daemon), and the shell is free for the next job. Its marker then says
//! it killed them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::log;
use crate::machine::Activity;

/// A file for a job: its path in the workspace, contents and mode.
pub type File = (String, Vec<u8>, u32);

pub struct Request {
    pub files: Vec<File>,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

#[derive(Default)]
pub struct Done {
    pub output: Vec<u8>,
    /// None: it ran out of time, or was stopped
    pub status: Option<i32>,
    /// What it wrote to out/, by path under it
    pub out: Vec<(String, Vec<u8>)>,
    pub timed_out: bool,
    /// The instance stopped while it ran
    pub cancelled: bool,
    /// Out of time or stopped, the guest killed what it had started (the launcher said so)
    pub killed: bool,
    pub ms: u64,
}

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
static STOPPING: AtomicBool = AtomicBool::new(false);

/// How long the guest gets to kill a job, once told to
const KILL_GRACE: Duration = Duration::from_secs(10);
/// Output kept in a job's log entry
const LOGGED_OUTPUT: usize = 64 << 10;

/// The instance is stopping: the running job is killed and no other starts.
pub fn stop_all() {
    STOPPING.store(true, Ordering::SeqCst);
}

/// Wait until no job is running (true), or the timeout.
pub fn wait_idle(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ONE_AT_A_TIME.try_lock().is_ok() || matches!(ONE_AT_A_TIME.try_lock(), Err(std::sync::TryLockError::Poisoned(_))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The two scripts of a job in workspace `ws`: the launcher (typed `sh <ws>/.sg/job.sh`) and the
/// command with its environment (`.sg/cmd`).
pub fn scripts(id: &str, ws: &str, env: &[(String, String)], command: &str) -> Result<(String, String), String> {
    // The app's environment: a login PATH, /etc/profile, the image's ENV
    let mut cmd = String::from(
        "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root\n\
         [ -f /etc/profile ] && . /etc/profile >/dev/null 2>&1\n\
         [ -f /usr/local/bin/snowglobe-console ] && eval \"$(grep '^export ' /usr/local/bin/snowglobe-console)\"\n",
    );
    cmd += &format!("cd {} || exit 1\nmkdir -p in out\n", quote(ws));
    cmd += &format!("export EXCLAVE_WORKSPACE={}\n", quote(ws));
    for (k, v) in env {
        if k.is_empty() || k.starts_with(|c: char| c.is_ascii_digit()) || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("{k}: not a variable name"));
        }
        cmd += &format!("export {k}={}\n", quote(v));
    }
    cmd += command;
    cmd.push('\n');

    // The trap first: a ctrl-c that comes early still finds it
    let launcher = format!(
        r#"k=0
trap 'k=1' INT TERM HUP
cd {ws} || exit 1
sg_procs() {{
  for p in /proc/[0-9]*; do
    read -r st 2>/dev/null <"$p/stat" || continue
    set -- ${{st##*") "}}
    if [ "${{p#/proc/}}" != "$$" ] && {{ [ "$3" = "$pg" ] || [ "$4" = "$pg" ]; }}; then echo "${{p#/proc/}}"; fi
  done
}}
sg_kill() {{
  kill -"$1" -"$pg" 2>/dev/null
  for q in $(sg_procs); do kill -"$1" "$q" 2>/dev/null; done
}}
sg_alive() {{
  kill -0 -"$pg" 2>/dev/null || [ -n "$(sg_procs)" ]
}}
if command -v setsid >/dev/null 2>&1; then
  setsid sh .sg/cmd </dev/null >.sg/output 2>&1 &
else
  set -m; sh .sg/cmd </dev/null >.sg/output 2>&1 & set +m
fi
pg=$!
wait "$pg"; s=$?
if [ "$k" = 1 ]; then
  sg_kill TERM
  i=0
  while [ "$i" -lt 30 ] && sg_alive; do
    if sleep 0.1 2>/dev/null; then i=$((i+1)); else sleep 1; i=$((i+10)); fi
  done
  sg_kill KILL
  wait "$pg"; s=$?
fi
sync
printf '\nSGDONE_%s_%s_%s\n' {id} "$s" "$k"
"#,
        ws = quote(ws),
    );
    Ok((launcher, cmd))
}

/// The launcher's marker in what the serial line printed: the command's status, and whether it
/// was killed.
pub fn parse_marker(printed: &str, id: &str) -> Option<(i32, bool)> {
    let marker = format!("SGDONE_{id}_");
    let at = printed.find(&marker)?;
    let rest = &printed[at + marker.len()..];
    let line = &rest[..rest.find(['\r', '\n'])?];
    let (status, killed) = line.trim().split_once('_')?;
    Some((status.parse().ok()?, killed == "1"))
}

pub fn run(board: &armless::Board, activity: &Arc<Activity>, req: &Request) -> Result<Done, String> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    if STOPPING.load(Ordering::SeqCst) {
        return Err("the instance is stopping".into());
    }
    let begun = Instant::now();
    let id = format!("{:016x}", u64::from_le_bytes(armless::runner::os_entropy()[..8].try_into().unwrap()));
    let ws = format!("/sgjob/{id}");
    let (launcher, cmd) = scripts(&id, &ws, &req.env, &req.command)?;
    let mut files = 0;
    for (rel, data, mode) in &req.files {
        if rel.starts_with(".sg/") || rel.starts_with("out/") || rel.split('/').any(|c| c == "..") {
            continue;
        }
        board.fs_write_file(&format!("{ws}/{rel}"), data, *mode)?;
        files += 1;
    }
    board.fs_write_file(&format!("{ws}/.sg/cmd"), cmd.as_bytes(), 0o755)?;
    board.fs_write_file(&format!("{ws}/.sg/job.sh"), launcher.as_bytes(), 0o755)?;
    log::event(
        "job_start",
        json!({
            "job": id,
            "cmd": req.command,
            // Names only: values can be secrets
            "env": req.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            "files": files,
            "timeout": req.timeout.as_secs_f64(),
        }),
    );

    let from = activity.serial_total();
    board.serial_input(format!("sh {ws}/.sg/job.sh\n").as_bytes());
    activity.touch();
    let mut deadline = begun + req.timeout;
    let mut done = Done::default();
    let mut killing = false;
    let mut marker = None;
    {
        let mut screen = activity.screen.lock().unwrap();
        loop {
            let printed = String::from_utf8_lossy(&activity.serial_since(from)).into_owned();
            if let Some(m) = parse_marker(&printed, &id) {
                marker = Some(m);
                break;
            }
            let stopping = STOPPING.load(Ordering::SeqCst);
            if !killing && (stopping || Instant::now() >= deadline) {
                // ctrl-c: the launcher kills the command's session, then prints its marker
                board.serial_input(&[0x03]);
                killing = true;
                done.timed_out = !stopping;
                done.cancelled = stopping;
                deadline = Instant::now() + KILL_GRACE;
                continue;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            screen = activity.screen_cv.wait_timeout(screen, left.min(Duration::from_millis(200))).unwrap().0;
        }
    }
    done.output = board
        .fs_read_tree(&format!("{ws}/.sg"))?
        .and_then(|f| f.into_iter().find(|(n, _)| n == "output").map(|(_, d)| d))
        .unwrap_or_default();
    if let Some((status, killed)) = marker {
        done.killed = killed;
        if killed {
            // Out of time (or stopped), whatever it ended with
        } else {
            // It ended by itself (if a ctrl-c went, it went just after, to the shell's prompt)
            done.status = Some(status);
            done.timed_out = false;
            done.cancelled = false;
        }
    }
    if done.status.is_some() {
        done.out = board
            .fs_read_tree(&format!("{ws}/out"))?
            .unwrap_or_default()
            .into_iter()
            .filter(|(rel, _)| !rel.split('/').any(|c| c == ".."))
            .collect();
    }
    done.ms = begun.elapsed().as_millis() as u64;
    let shown = &done.output[..done.output.len().min(LOGGED_OUTPUT)];
    log::event(
        "job_end",
        json!({
            "job": id,
            "status": done.status,
            "timed_out": done.timed_out,
            "cancelled": done.cancelled,
            "killed": done.killed,
            "ms": done.ms,
            "output": String::from_utf8_lossy(shown),
            "output_bytes": done.output.len(),
            "out_files": done.out.len(),
        }),
    );
    Ok(done)
}

/// A job whose workspace is a host directory (`--workspace DIR`): its files go in, `out/` comes
/// back into it.
pub struct Workspace {
    pub dir: PathBuf,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

pub fn run_workspace(board: &armless::Board, activity: &Arc<Activity>, w: &Workspace) -> Result<(Done, usize), String> {
    let done = run(
        board,
        activity,
        &Request { files: files(&w.dir)?, command: w.command.clone(), env: w.env.clone(), timeout: w.timeout },
    )?;
    for (rel, data) in &done.out {
        let dest = w.dir.join("out").join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&dest, data).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    let n = done.out.len();
    Ok((done, n))
}

/// A directory's files, relative to it (directories walked; symlinks and the like skipped).
fn files(root: &Path) -> Result<Vec<File>, String> {
    use std::os::unix::fs::PermissionsExt;
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let e = e.map_err(|e| e.to_string())?;
            let ty = e.file_type().map_err(|e| e.to_string())?;
            let path = e.path();
            if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if rel.starts_with(".sg/") || rel.starts_with("out/") {
                    continue;
                }
                let mode = e.metadata().map(|m| m.permissions().mode() & 0o777).unwrap_or(0o644);
                out.push((rel, std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?, mode));
            }
        }
    }
    Ok(out)
}

/// A job as JSON on the control socket: {"files": {path: base64}, "cmd", "env": {..}, "timeout"}
/// in, {"status", "output": base64, "out": {path: base64}} back.
pub fn from_json(v: &serde_json::Value) -> Result<Request, String> {
    let files = v["files"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| {
            let data = crate::b64::decode(v.as_str().ok_or("files: base64 strings")?).ok_or("files: bad base64")?;
            Ok((k.clone(), data, 0o644))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Request {
        files,
        command: v["cmd"].as_str().ok_or("no cmd")?.to_string(),
        env: v["env"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
            .collect(),
        timeout: Duration::from_secs_f64(v["timeout"].as_f64().unwrap_or(300.0)),
    })
}

pub fn to_json(d: &Done) -> serde_json::Value {
    let out: serde_json::Map<String, serde_json::Value> =
        d.out.iter().map(|(k, v)| (k.clone(), serde_json::Value::from(crate::b64::encode(v)))).collect();
    json!({
        "status": d.status,
        "output": crate::b64::encode(&d.output),
        "out": out,
        "timed_out": d.timed_out,
        "cancelled": d.cancelled,
        "killed": d.killed,
        "ms": d.ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_carries_status_and_kill() {
        let printed = "sh /sgjob/ab/.sg/job.sh\r\n\r\nSGDONE_ab_143_1\r\n# ";
        assert_eq!(parse_marker(printed, "ab"), Some((143, true)));
        assert_eq!(parse_marker("\nSGDONE_ab_0_0\n", "ab"), Some((0, false)));
        // Not this job's, or not a whole line yet
        assert_eq!(parse_marker("\nSGDONE_cd_0_0\n", "ab"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_0_", "ab"), None);
        // The typed line's echo has no marker in it
        assert_eq!(parse_marker("sh /sgjob/ab/.sg/job.sh\r\n", "ab"), None);
    }

    #[test]
    fn variables_are_quoted_and_checked() {
        let (_, cmd) = scripts("id", "/sgjob/id", &[("A".into(), "it's $HOME".into())], "echo \"$A\"").unwrap();
        assert!(cmd.contains("export A='it'\\''s $HOME'\n"), "{cmd}");
        assert!(cmd.ends_with("echo \"$A\"\n"));
        for bad in ["", "1A", "A-B", "A B", "A;rm"] {
            assert!(scripts("id", "/w", &[(bad.into(), "v".into())], "true").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_launcher_traps_before_anything_else() {
        let (launcher, _) = scripts("id", "/sgjob/id", &[], "true").unwrap();
        let first: Vec<&str> = launcher.lines().take(2).collect();
        assert_eq!(first, ["k=0", "trap 'k=1' INT TERM HUP"]);
        assert!(launcher.contains("setsid sh .sg/cmd"));
        assert!(launcher.contains("SGDONE_%s_%s_%s\\n' id"));
    }

    /// The launcher, run by this machine's sh as the guest's serial shell runs it: on a terminal
    /// (a pty here), where ctrl-c is a byte typed into it. What it prints, and what it leaves.
    #[cfg(target_os = "linux")]
    mod launcher {
        use super::super::*;
        use std::io::{Read, Write};
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::os::unix::process::CommandExt;
        use std::process::Command;

        struct Run {
            ws: PathBuf,
            child: std::process::Child,
            master: std::fs::File,
            printed: Arc<Mutex<Vec<u8>>>,
        }

        impl Run {
            /// `path`: the PATH the launcher gets (to leave setsid out of it)
            fn start(name: &str, env: &[(String, String)], command: &str, path: Option<&Path>) -> Run {
                let ws = std::env::temp_dir().join(format!("sgjob-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&ws);
                std::fs::create_dir_all(ws.join(".sg")).unwrap();
                let (launcher, cmd) = scripts("t", ws.to_str().unwrap(), env, command).unwrap();
                std::fs::write(ws.join(".sg/cmd"), cmd).unwrap();
                std::fs::write(ws.join(".sg/job.sh"), launcher).unwrap();

                let (mut m, mut s) = (0, 0);
                // SAFETY: openpty fills in two descriptors we then own
                assert_eq!(unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()) }, 0);
                let slave = unsafe { OwnedFd::from_raw_fd(s) };
                let master = unsafe { std::fs::File::from_raw_fd(m) };
                let mut cmd = Command::new("sh");
                cmd.arg(ws.join(".sg/job.sh"));
                if let Some(p) = path {
                    cmd.env("PATH", p);
                }
                let fd = std::os::fd::AsRawFd::as_raw_fd(&slave);
                // SAFETY: only async-signal-safe calls between fork and exec
                unsafe {
                    cmd.pre_exec(move || {
                        // A session of its own, the pty its terminal, as getty gives the shell
                        if libc::setsid() < 0 || libc::ioctl(fd, libc::TIOCSCTTY, 0) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        for to in 0..3 {
                            libc::dup2(fd, to);
                        }
                        Ok(())
                    });
                }
                let child = cmd.spawn().unwrap();
                drop(slave);
                let printed = Arc::new(Mutex::new(Vec::new()));
                {
                    let printed = printed.clone();
                    let mut master = master.try_clone().unwrap();
                    std::thread::spawn(move || {
                        let mut buf = [0u8; 4096];
                        // Ends with EIO once the launcher is gone
                        while let Ok(n @ 1..) = master.read(&mut buf) {
                            printed.lock().unwrap().extend_from_slice(&buf[..n]);
                        }
                    });
                }
                Run { ws, child, master, printed }
            }

            fn ctrl_c(&mut self) {
                self.master.write_all(&[0x03]).unwrap();
            }

            /// The marker, once the launcher has ended (within 15 s)
            fn finish(mut self) -> (Option<(i32, bool)>, PathBuf) {
                let begun = Instant::now();
                while self.child.try_wait().unwrap().is_none() {
                    assert!(begun.elapsed() < Duration::from_secs(15), "the launcher didn't end");
                    std::thread::sleep(Duration::from_millis(20));
                }
                std::thread::sleep(Duration::from_millis(100));
                let printed = String::from_utf8_lossy(&self.printed.lock().unwrap()).into_owned();
                (parse_marker(&printed, "t"), self.ws)
            }
        }

        /// Processes whose command line is `sleep <n>` with one of these n
        fn sleeping(ns: &[&str]) -> Vec<String> {
            let mut found = Vec::new();
            for e in std::fs::read_dir("/proc").unwrap().flatten() {
                let Ok(cmdline) = std::fs::read(e.path().join("cmdline")) else { continue };
                let args: Vec<String> = cmdline.split(|&b| b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
                if args.first().is_some_and(|a| a.ends_with("sleep")) && args.get(1).is_some_and(|n| ns.contains(&n.as_str())) {
                    found.push(args[1].clone());
                }
            }
            found
        }

        #[test]
        fn a_command_that_ends_reports_its_status_and_output() {
            let run = Run::start(
                "ends",
                &[("GREETING".into(), "it's me".into())],
                "echo \"$GREETING\" in $EXCLAVE_WORKSPACE; echo made > out/r; exit 7",
                None,
            );
            let (marker, ws) = run.finish();
            assert_eq!(marker, Some((7, false)));
            let output = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert_eq!(output, format!("it's me in {}\n", ws.display()));
            assert_eq!(std::fs::read_to_string(ws.join("out/r")).unwrap(), "made\n");
        }

        /// In the background, ignoring TERM (only KILL ends it), in a shell of its own, and in
        /// the foreground: ctrl-c leaves none of them
        fn kills_everything(name: &str, ns: [&str; 4], path: Option<&Path>) {
            let mut run = Run::start(
                name,
                &[],
                &format!(
                    "sleep {} & (trap '' TERM; sleep {}) & sh -c 'sleep {}; true'; sleep {}",
                    ns[0], ns[1], ns[2], ns[3]
                ),
                path,
            );
            let begun = Instant::now();
            while sleeping(&ns).len() < 3 {
                assert!(begun.elapsed() < Duration::from_secs(10), "the command didn't start: {:?}", sleeping(&ns));
                std::thread::sleep(Duration::from_millis(50));
            }
            run.ctrl_c();
            let (marker, _) = run.finish();
            let (status, killed) = marker.expect("no marker");
            assert!(killed);
            assert!(status > 128, "ended by a signal: {status}");
            assert!(begun.elapsed() < Duration::from_secs(12));
            assert_eq!(sleeping(&ns), Vec::<String>::new(), "left running");
        }

        #[test]
        fn ctrl_c_kills_everything_the_command_started() {
            kills_everything("kill", ["3171", "3172", "3173", "3174"], None);
        }

        /// A guest with no setsid: the command gets a process group of its own instead
        #[test]
        fn without_setsid_too() {
            let bin = std::env::temp_dir().join(format!("sgjob-bin-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&bin);
            std::fs::create_dir_all(&bin).unwrap();
            for tool in ["sh", "sleep", "sync", "cat", "grep", "mkdir"] {
                let found = ["/bin", "/usr/bin"].iter().map(|d| Path::new(d).join(tool)).find(|p| p.exists()).unwrap();
                std::os::unix::fs::symlink(found, bin.join(tool)).unwrap();
            }
            kills_everything("nosetsid", ["3181", "3182", "3183", "3184"], Some(&bin));
        }
    }
}
