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
//! only in a new directory), and `EXCLAVE_WORKSPACE` names it. The command starts there (its files
//! in, `out/` back), or, asked to (`"home": true`: a command typed for a person or an agent, as
//! `snowglobe sh` and run_command send), in the home directory, as the machine's terminal and the
//! browser's agent page have it. Only `sh <launcher>` is typed. The
//! launcher asks for a nonce, which the host then types (it is in no file, and the command hasn't
//! started yet) with its own time, which the launcher sets the guest's wall clock to (a restored
//! guest's clock otherwise starts at its snapshot's moment: as after a resume from suspend, the
//! wall clock catches up and the monotonic one doesn't count the gap), starts the command in a session of its own (setsid; else a process group of its
//! own), waits for it, syncs what it wrote, then prints a marker line with the nonce and its
//! status. Only that whole line ends the job: a job that prints a marker of its own from what it
//! can read (`.sg/job.sh`, its id) doesn't end or misreport itself. One job at a time per machine.
//!
//! What this can't stop: a job runs as root in the guest, so one set on it can still read the
//! nonce out of the launcher's memory (/proc/<pid>/mem) or take over the serial line, and forge
//! its own result. It can only ever forge its own: the host enforces the timeout, and a job that
//! leaves the shell busy holds up the next one (below) rather than having it typed into it.
//!
//! Out of time (or the instance stopping), the host types ctrl-c: the launcher, in the terminal's
//! foreground, traps it and kills the command's session and process group, TERM and then KILL
//! after 3 s, so nothing the command started is left running (short of a process that made a
//! session of its own: a daemon), and the shell is free for the next job. Its marker then says
//! it killed them. If no marker comes even then, the shell may still be busy: before another job
//! is typed, the shell must answer a sync (a line it computes, which its echo can't contain); until
//! it does, jobs fail with "the guest's shell is not answering".

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
    /// Start in the home directory rather than the workspace: a command typed by a person or an
    /// agent (`snowglobe sh`, run_command), not a job that reads its files in and writes out/
    pub home: bool,
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
const KILL_GRACE: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(10) };
/// How long a shell that may be busy gets to answer a sync
const SYNC_WAIT: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(10) };
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

/// A job's time limit, in seconds (300 unless given). Never negative, NaN or endless: making a
/// Duration of those panics, which would take the whole instance down with one request.
pub fn timeout(secs: Option<f64>) -> Result<Duration, String> {
    let t = Duration::try_from_secs_f64(secs.unwrap_or(300.0)).map_err(|_| "timeout: seconds")?;
    // Longer than any job runs, and still a time to wait until
    Ok(t.min(Duration::from_secs(1 << 32)))
}

/// A job's exit status as a process's: its own, or 124 (as timeout(1) has it) when it ran out of
/// time or was stopped.
pub fn exit_code(status: Option<i64>) -> u8 {
    status.map_or(124, |s| s.clamp(0, 255) as u8)
}

/// `--timeout SECS`
pub fn timeout_flag(arg: Option<&str>) -> Result<Duration, String> {
    arg.map(str::parse).transpose().ok().and_then(|s| timeout(s).ok()).ok_or_else(|| "--timeout: seconds".into())
}

pub(crate) fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The two scripts of a job in workspace `ws`: the launcher (typed `sh <ws>/.sg/job.sh`) and the
/// command with its environment (`.sg/cmd`). The command starts in `ws`, or with `home` in the
/// home directory (as in the machine's terminal, and as the browser's agent page runs jobs), `ws`
/// still its own as `$EXCLAVE_WORKSPACE`.
pub fn scripts(id: &str, ws: &str, env: &[(String, String)], command: &str, home: bool) -> Result<(String, String), String> {
    // The app's environment: a login PATH, /etc/profile, the image's ENV (from the file a build
    // writes; a site built before there was one has it only in its console script)
    let mut cmd = String::from(
        "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root\n\
         [ -f /etc/profile ] && . /etc/profile >/dev/null 2>&1\n\
         if [ -f /etc/snowglobe/env ]; then . /etc/snowglobe/env\n\
         elif [ -f /usr/local/bin/snowglobe-console ]; then eval \"$(grep '^export ' /usr/local/bin/snowglobe-console)\"; fi\n",
    );
    if !home {
        cmd += &format!("cd {} || exit 1\n", quote(ws));
    }
    cmd += &format!("export EXCLAVE_WORKSPACE={}\n", quote(ws));
    for (k, v) in env {
        if k.is_empty() || k.starts_with(|c: char| c.is_ascii_digit()) || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("{k}: not a variable name"));
        }
        cmd += &format!("export {k}={}\n", quote(v));
    }
    if home {
        // After the image's ENV and the job's, either of which may set HOME
        cmd += "cd \"${HOME:-/root}\" 2>/dev/null || cd /\n";
    }
    cmd += command;
    cmd.push('\n');

    // The trap first: a ctrl-c that comes early still finds it. Then the nonce, typed by the host
    // when asked (never in a file; before the command starts, so it can't read it off the
    // terminal), kept in an unexported variable
    let launcher = format!(
        r#"k=0
trap 'k=1' INT TERM HUP
printf '\nSGNONCE_%s\n' {id}
read -r n t
[ -n "$t" ] && date -s "@$t" >/dev/null 2>&1
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
printf '\nSGDONE_%s_%s_%s_%s\n' {id} "$n" "$s" "$k"
"#,
        ws = quote(ws),
    );
    Ok((launcher, cmd))
}

/// The launcher's marker in what the serial line printed: the command's status, and whether it
/// was killed. Only a whole line `SGDONE_<id>_<nonce>_<status>_<0|1>` counts: not one without the
/// nonce, nor one pieced together around the terminal's echo of the typed nonce.
pub fn parse_marker(printed: &str, id: &str, nonce: &str) -> Option<(i32, bool)> {
    let prefix = format!("SGDONE_{id}_{nonce}_");
    // Whole lines only: the last piece hasn't ended yet
    let (lines, _) = printed.rsplit_once('\n')?;
    lines.split('\n').find_map(|line| {
        let (status, killed) = line.trim_end_matches('\r').strip_prefix(&prefix)?.split_once('_')?;
        let killed = match killed {
            "0" => false,
            "1" => true,
            _ => return None,
        };
        Some((status.parse().ok()?, killed))
    })
}

/// A fresh random token, 16 hex digits.
pub(crate) fn token() -> String {
    format!("{:016x}", u64::from_le_bytes(armless::runner::os_entropy()[..8].try_into().unwrap()))
}

/// Whether the serial shell is at its prompt: it runs a line (once whatever it is running ends)
/// and prints what it computes, which the echo of the typed line can't contain.
fn shell_answers(board: &armless::Board, activity: &Activity, wait: Duration) -> bool {
    let tok = token();
    let from = activity.serial_total();
    board.serial_input(format!("echo SGSYNC_{tok}_$((6*7))\n").as_bytes());
    let answer = format!("SGSYNC_{tok}_42");
    let deadline = Instant::now() + wait;
    loop {
        if String::from_utf8_lossy(&activity.serial_since(from)).contains(&answer) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn run(board: &armless::Board, activity: &Arc<Activity>, req: &Request) -> Result<Done, String> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    if STOPPING.load(Ordering::SeqCst) {
        return Err("the instance is stopping".into());
    }
    // The last job left the shell maybe busy: nothing is typed into it until it answers
    if activity.shell_busy.load(Ordering::SeqCst) {
        if !shell_answers(board, activity, SYNC_WAIT) {
            return Err("the guest's shell is not answering".into());
        }
        activity.shell_busy.store(false, Ordering::SeqCst);
    }
    let begun = Instant::now();
    let id = token();
    let nonce = token();
    let ws = format!("/sgjob/{id}");
    let (launcher, cmd) = scripts(&id, &ws, &req.env, &req.command, req.home)?;
    let mut files = 0;
    for (rel, data, mode) in &req.files {
        // However it is spelled (`/out/x`, `./out/x`), nothing goes in the job's own directories
        let first = rel.split('/').find(|c| !c.is_empty() && *c != ".");
        if matches!(first, Some(".sg" | "out")) || rel.split('/').any(|c| c == "..") {
            continue;
        }
        board.fs_write_file(&format!("{ws}/{rel}"), data, *mode)?;
        files += 1;
    }
    // in/ and out/ made from here: a mkdir in the guest is a process started, for every job
    board.fs_mkdir(&format!("{ws}/in"))?;
    board.fs_mkdir(&format!("{ws}/out"))?;
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
    let mut asked = false;
    {
        let mut screen = activity.screen.lock().unwrap();
        loop {
            let printed = String::from_utf8_lossy(&activity.serial_since(from)).into_owned();
            if !asked && printed.contains(&format!("SGNONCE_{id}")) {
                // With the host's time, which the launcher sets the guest's clock to
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                board.serial_input(format!("{nonce} {now}\n").as_bytes());
                asked = true;
            }
            if let Some(m) = parse_marker(&printed, &id, &nonce) {
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
    // No marker even after the ctrl-c: the launcher may still be running in the shell. The job
    // keeps the shell (and the lock) until the shell answers; if it doesn't, the next job asks
    // again rather than being typed into it
    if marker.is_none() && !shell_answers(board, activity, SYNC_WAIT) {
        activity.shell_busy.store(true, Ordering::SeqCst);
        log::event("job_shell_busy", json!({ "job": id }));
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
        &Request { files: files(&w.dir)?, command: w.command.clone(), env: w.env.clone(), timeout: w.timeout, home: false },
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
        timeout: timeout(v["timeout"].as_f64())?,
        home: v["home"].as_bool().unwrap_or(false),
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
        let printed = "sh /sgjob/ab/.sg/job.sh\r\n\r\nSGDONE_ab_n0_143_1\r\n# ";
        assert_eq!(parse_marker(printed, "ab", "n0"), Some((143, true)));
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0\n", "ab", "n0"), Some((0, false)));
        // Not this job's, or not a whole line yet
        assert_eq!(parse_marker("\nSGDONE_cd_n0_0_0\n", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0", "ab", "n0"), None, "not a whole line yet");
        // The typed line's echo has no marker in it
        assert_eq!(parse_marker("sh /sgjob/ab/.sg/job.sh\r\n", "ab", "n0"), None);
    }

    #[test]
    fn only_the_launchers_own_marker_line_counts() {
        // Without the nonce (all a job can build from .sg/job.sh), or with another one
        assert_eq!(parse_marker("\nSGDONE_ab_0_0\n", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n1_0_0\n", "ab", "n0"), None);
        // Not at the start of its line, or with more after it
        assert_eq!(parse_marker("x SGDONE_ab_n0_0_0\n", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0x\n", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_2\n", "ab", "n0"), None);
        // Pieced together around the terminal's echo of the typed nonce: its own line, cut short
        assert_eq!(parse_marker("SGDONE_ab_n0\r\n_0_0\n", "ab", "n0"), None);
        // A spoof first, then the real one: the real one
        assert_eq!(parse_marker("\nSGDONE_ab_0_0\nSGDONE_ab_n0_7_0\n", "ab", "n0"), Some((7, false)));
    }

    #[test]
    fn variables_are_quoted_and_checked() {
        let (_, cmd) = scripts("id", "/sgjob/id", &[("A".into(), "it's $HOME".into())], "echo \"$A\"", false).unwrap();
        assert!(cmd.contains("export A='it'\\''s $HOME'\n"), "{cmd}");
        assert!(cmd.ends_with("echo \"$A\"\n"));
        for bad in ["", "1A", "A-B", "A B", "A;rm"] {
            assert!(scripts("id", "/w", &[(bad.into(), "v".into())], "true", false).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_command_starts_in_its_workspace_or_the_home_directory() {
        // A job with files (cp, a bundle's job runner): in its workspace, where in/ and out/ are
        let (_, cmd) = scripts("id", "/sgjob/id", &[], "cat in/a", false).unwrap();
        let lines: Vec<&str> = cmd.lines().collect();
        assert!(lines.contains(&"cd '/sgjob/id' || exit 1"), "{cmd}");
        assert!(!cmd.contains("${HOME"), "{cmd}");

        // A command typed for a person or an agent (`snowglobe sh`, run_command): in the home
        // directory, as the machine's terminal and the browser's agent page have it, the workspace
        // still its own. After the image's ENV and the job's, which may set HOME
        let (launcher, cmd) = scripts("id", "/sgjob/id", &[("HOME".into(), "/home/me".into())], "pwd", true).unwrap();
        let lines: Vec<&str> = cmd.lines().collect();
        let n = lines.len();
        assert_eq!(lines[n - 1], "pwd");
        assert_eq!(lines[n - 2], "cd \"${HOME:-/root}\" 2>/dev/null || cd /");
        assert_eq!(lines[n - 3], "export HOME='/home/me'");
        assert!(lines.contains(&"export EXCLAVE_WORKSPACE='/sgjob/id'"));
        assert!(!cmd.contains("cd '/sgjob/id'"), "{cmd}");
        // The launcher still keeps its files in the workspace
        assert!(launcher.contains("cd '/sgjob/id' || exit 1"));

        // Run as the launcher runs it: it starts where HOME is
        let dir = std::env::temp_dir().join(format!("sgjob-cwd-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let (_, cmd) =
            scripts("id", dir.to_str().unwrap(), &[("HOME".into(), home.to_str().unwrap().into())], "pwd; echo \"$EXCLAVE_WORKSPACE\"", true)
                .unwrap();
        std::fs::write(dir.join("cmd"), cmd).unwrap();
        let out = std::process::Command::new("sh").arg(dir.join("cmd")).current_dir(&dir).output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{}\n{}\n", home.display(), dir.display()));
    }

    #[test]
    fn a_request_starts_in_the_home_directory_only_when_asked() {
        assert!(!from_json(&json!({"cmd": "true"})).unwrap().home);
        assert!(from_json(&json!({"cmd": "true", "home": true})).unwrap().home);
    }

    #[test]
    fn the_launcher_traps_before_anything_else() {
        let (launcher, _) = scripts("id", "/sgjob/id", &[], "true", false).unwrap();
        let first: Vec<&str> = launcher.lines().take(5).collect();
        assert_eq!(
            first,
            [
                "k=0",
                "trap 'k=1' INT TERM HUP",
                "printf '\\nSGNONCE_%s\\n' id",
                // The nonce, and the host's time, which the guest's clock is set to
                "read -r n t",
                "[ -n \"$t\" ] && date -s \"@$t\" >/dev/null 2>&1",
            ]
        );
        assert!(launcher.contains("setsid sh .sg/cmd"));
        // The marker carries the nonce, which is in no file
        assert!(launcher.contains("SGDONE_%s_%s_%s_%s\\n' id \"$n\""));
        assert!(!launcher.contains("export n"));
    }

    #[test]
    fn timeouts_are_seconds_a_job_can_wait() {
        assert_eq!(timeout(None), Ok(Duration::from_secs(300)));
        assert_eq!(timeout(Some(1.5)), Ok(Duration::from_millis(1500)));
        assert_eq!(timeout(Some(0.0)), Ok(Duration::ZERO));
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(timeout(Some(bad)).is_err(), "{bad}");
        }
        // However long, a deadline can still be made of it
        let _ = Instant::now() + timeout(Some(1e19)).unwrap();
        assert!(timeout(Some(1e300)).is_err());
        assert_eq!(timeout_flag(None), Ok(Duration::from_secs(300)));
        assert_eq!(timeout_flag(Some("2")), Ok(Duration::from_secs(2)));
        for bad in ["-1", "soon", "NaN", "inf", ""] {
            assert_eq!(timeout_flag(Some(bad)), Err("--timeout: seconds".into()), "{bad}");
        }
    }

    #[test]
    fn a_jobs_exit_code_is_its_status_or_124() {
        assert_eq!(exit_code(Some(0)), 0);
        assert_eq!(exit_code(Some(7)), 7);
        assert_eq!(exit_code(Some(300)), 255);
        assert_eq!(exit_code(None), 124);
    }

    #[test]
    fn quoting_survives_any_text() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("a'b"), "'a'\\''b'");
        assert_eq!(quote("$(rm -rf /) `x` \"y\""), "'$(rm -rf /) `x` \"y\"'");
    }

    #[test]
    fn a_job_from_json_decodes_its_files_and_keeps_string_variables() {
        let v = serde_json::json!({
            "files": { "in/a.txt": crate::b64::encode(b"hello") },
            "cmd": "cat in/a.txt",
            "env": { "A": "1", "N": 2 },
            "timeout": 5,
        });
        let r = from_json(&v).unwrap();
        assert_eq!(r.files, [("in/a.txt".to_string(), b"hello".to_vec(), 0o644)]);
        assert_eq!(r.command, "cat in/a.txt");
        assert_eq!(r.env, [("A".to_string(), "1".to_string())], "a value that isn't a string is left out");
        assert_eq!(r.timeout, Duration::from_secs(5));
        // Only cmd is needed
        let r = from_json(&serde_json::json!({ "cmd": "true" })).unwrap();
        assert!(r.files.is_empty() && r.env.is_empty());
        assert_eq!(r.timeout, Duration::from_secs(300));
    }

    #[test]
    fn a_bad_job_from_json_says_what_is_wrong() {
        let err = |v: serde_json::Value| from_json(&v).err().unwrap();
        assert_eq!(err(serde_json::json!({})), "no cmd");
        assert_eq!(err(serde_json::json!({ "cmd": "x", "files": { "a": 1 } })), "files: base64 strings");
        assert_eq!(err(serde_json::json!({ "cmd": "x", "files": { "a": "!!" } })), "files: bad base64");
        // Not a panic that takes the instance down
        assert_eq!(err(serde_json::json!({ "cmd": "x", "timeout": -1 })), "timeout: seconds");
    }

    #[test]
    fn a_finished_job_as_json() {
        let d = Done {
            output: b"hi\n".to_vec(),
            status: Some(3),
            out: vec![("r/x".into(), b"made".to_vec())],
            ms: 12,
            ..Done::default()
        };
        let v = to_json(&d);
        assert_eq!(v["status"], 3);
        assert_eq!(crate::b64::decode(v["output"].as_str().unwrap()).unwrap(), b"hi\n");
        assert_eq!(crate::b64::decode(v["out"]["r/x"].as_str().unwrap()).unwrap(), b"made");
        assert_eq!((v["timed_out"].as_bool(), v["cancelled"].as_bool(), v["killed"].as_bool()), (Some(false), Some(false), Some(false)));
        assert_eq!(v["ms"], 12);
        // Out of time: no status
        assert!(to_json(&Done { timed_out: true, ..Done::default() })["status"].is_null());
    }

    #[test]
    fn a_workspace_goes_in_without_its_own_out_and_sg() {
        use std::os::unix::fs::PermissionsExt;
        let ws = crate::testing::tmp("job-files");
        crate::testing::write(&ws, &[("a", b"a"), ("d/e/f", b"f"), ("out/old", b"x"), (".sg/cmd", b"x"), ("d/out/kept", b"k")]);
        std::fs::set_permissions(ws.join("a"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", ws.join("link")).unwrap();
        let mut got = files(&ws).unwrap();
        got.sort();
        let names: Vec<(&str, u32)> = got.iter().map(|(n, _, m)| (n.as_str(), *m)).collect();
        assert_eq!(names, [("a", 0o755), ("d/e/f", 0o644), ("d/out/kept", 0o644)]);
        assert_eq!(got[1].1, b"f");
        assert!(files(&ws.join("missing")).is_err());
    }

    #[test]
    fn idle_when_no_job_runs() {
        assert!(wait_idle(Duration::ZERO) || wait_idle(Duration::from_secs(30)));
    }

    /// A job on a machine that never runs: this plays the guest, from the files the job wrote
    /// into its filesystem to the marker its launcher prints.
    mod guest {
        use super::super::*;
        use crate::testing;
        use armless::dev::Event;

        /// The job's id and the files it was given
        type Played = (String, Vec<(String, Vec<u8>)>);

        /// The next whole line the host typed into the serial line (`typed` keeps what has come
        /// in after it).
        fn next_line(board: &armless::Board, typed: &mut String) -> String {
            let begun = Instant::now();
            loop {
                typed.push_str(&testing::typed(board));
                if let Some((line, rest)) = typed.split_once('\n') {
                    let line = line.to_string();
                    *typed = rest.to_string();
                    return line;
                }
                assert!(begun.elapsed() < Duration::from_secs(10), "nothing typed: {typed:?}");
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        /// A launcher starting, played: typed in, it asks for its nonce and reads it. Its id and
        /// nonce.
        fn start_launcher(board: &armless::Board, activity: &Arc<Activity>, typed: &mut String) -> (String, String) {
            let id = loop {
                let line = next_line(board, typed);
                if let Some(id) = line.strip_prefix("sh /sgjob/").and_then(|l| l.strip_suffix("/.sg/job.sh")) {
                    break id.to_string();
                }
            };
            activity.observe(&Event::Serial(format!("sh /sgjob/{id}/.sg/job.sh\r\n\r\nSGNONCE_{id}\r\n").into_bytes()));
            // The nonce, then the host's time (Unix seconds), which the launcher sets the clock to
            let line = next_line(board, typed);
            let (nonce, time) = line.split_once(' ').expect("the nonce and the host's time");
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            let time: u64 = time.parse().expect("seconds");
            assert!(time.abs_diff(now) <= 5, "the host's time, typed: {time} (now {now})");
            // The terminal echoes it
            activity.observe(&Event::Serial(format!("{line}\r\n").into_bytes()));
            (id, nonce.to_string())
        }

        /// The shell back at its prompt: it answers the next sync typed in.
        fn answer_sync(board: &armless::Board, activity: &Arc<Activity>, typed: &mut String) {
            loop {
                // A ctrl-c typed before it is the shell's, not part of the line
                let line = next_line(board, typed).trim_start_matches('\x03').to_string();
                if let Some(tok) = line.strip_prefix("echo SGSYNC_").and_then(|l| l.strip_suffix("_$((6*7))")) {
                    activity.observe(&Event::Serial(format!("{line}\r\nSGSYNC_{tok}_42\r\n# ").into_bytes()));
                    return;
                }
            }
        }

        fn marker(activity: &Arc<Activity>, id: &str, nonce: &str, status: i32, killed: bool) {
            activity.observe(&Event::Serial(format!("\r\nSGDONE_{id}_{nonce}_{status}_{}\r\n# ", killed as u8).into_bytes()));
        }

        /// A job, played: its launcher starts; then, after `after`, `files` are written into its
        /// workspace and the marker printed with `status` and `killed`.
        fn play(
            board: Arc<armless::Board>,
            activity: Arc<Activity>,
            after: Duration,
            files: &'static [(&'static str, &'static [u8])],
            status: i32,
            killed: bool,
        ) -> std::thread::JoinHandle<Played> {
            std::thread::spawn(move || {
                let (id, nonce) = start_launcher(&board, &activity, &mut String::new());
                let given = board.fs_read_tree("/sgjob").unwrap().unwrap();
                std::thread::sleep(after);
                for (rel, data) in files {
                    board.fs_write_file(&format!("/sgjob/{id}/{rel}"), data, 0o644).unwrap();
                }
                marker(&activity, &id, &nonce, status, killed);
                (id, given)
            })
        }

        fn request(files: Vec<File>, timeout: Duration) -> Request {
            Request { files, command: "make".into(), env: vec![("K".into(), "v".into())], timeout, home: false }
        }

        #[test]
        fn a_job_that_ends_brings_back_its_status_output_and_out() {
            let (board, _runner) = testing::machine("job-ends");
            let activity = Activity::new(false);
            let printed: &[(&str, &[u8])] = &[(".sg/output", b"built\n"), ("out/r/x", b"made")];
            let guest = play(board.clone(), activity.clone(), Duration::ZERO, printed, 7, false);
            let files = vec![
                ("src/main.c".into(), b"int main;".to_vec(), 0o600),
                // Never written: the job's own, its results, or outside its workspace
                (".sg/cmd".into(), b"x".to_vec(), 0o644),
                ("out/x".into(), b"x".to_vec(), 0o644),
                ("../escape".into(), b"x".to_vec(), 0o644),
                ("a/../../escape".into(), b"x".to_vec(), 0o644),
            ];
            let done = run(&board, &activity, &request(files, Duration::from_secs(30))).unwrap();
            let (id, given) = guest.join().unwrap();
            assert_eq!(done.status, Some(7));
            assert_eq!(done.output, b"built\n");
            assert_eq!(done.out, [("r/x".to_string(), b"made".to_vec())]);
            assert!(!done.timed_out && !done.cancelled && !done.killed);
            let names: Vec<&str> = given.iter().map(|(n, _)| n.strip_prefix(&format!("{id}/")).unwrap()).collect();
            assert_eq!(names, [".sg/cmd", ".sg/job.sh", "src/main.c"]);
            let cmd = String::from_utf8_lossy(&given[0].1).into_owned();
            assert!(cmd.contains("export K='v'\n") && cmd.ends_with("make\n"), "{cmd}");
            assert!(board.fs_read_tree("/escape").unwrap().is_none());
        }

        #[test]
        fn a_job_out_of_time_is_killed_and_brings_back_no_status() {
            let (board, _runner) = testing::machine("job-late");
            let activity = Activity::new(false);
            // The guest answers the ctrl-c sent at the deadline: it killed the command
            let printed: &[(&str, &[u8])] = &[(".sg/output", b"partial"), ("out/r", b"x")];
            let guest = play(board.clone(), activity.clone(), Duration::from_millis(300), printed, 130, true);
            let done = run(&board, &activity, &request(vec![], Duration::from_millis(50))).unwrap();
            guest.join().unwrap();
            assert_eq!(done.status, None);
            assert!(done.timed_out && done.killed && !done.cancelled);
            assert_eq!(done.output, b"partial");
            assert!(done.out.is_empty(), "out/ of a job that didn't finish isn't taken");
            assert_eq!(to_json(&done)["status"], serde_json::Value::Null);
        }

        #[test]
        fn a_job_that_ends_just_as_its_time_is_up_counts_as_ended() {
            let (board, _runner) = testing::machine("job-just");
            let activity = Activity::new(false);
            // The ctrl-c went to the shell's prompt: the marker says the command ended by itself
            let guest = play(board.clone(), activity.clone(), Duration::from_millis(200), &[], 0, false);
            let done = run(&board, &activity, &request(vec![], Duration::from_millis(20))).unwrap();
            guest.join().unwrap();
            assert_eq!(done.status, Some(0));
            assert!(!done.timed_out && !done.killed);
        }

        #[test]
        fn input_files_never_land_in_the_jobs_own_directories_however_spelled() {
            let (board, _runner) = testing::machine("job-spelled");
            let activity = Activity::new(false);
            let guest = play(board.clone(), activity.clone(), Duration::ZERO, &[], 0, false);
            let files = ["/out/fake", "./out/fake", "out//fake", "//.sg/x", "./.sg/x", "a/./b"]
                .iter()
                .map(|n| (n.to_string(), b"x".to_vec(), 0o644))
                .collect();
            let done = run(&board, &activity, &request(files, Duration::from_secs(30))).unwrap();
            let (id, given) = guest.join().unwrap();
            assert!(done.out.is_empty(), "an input came back as a result: {:?}", done.out);
            let names: Vec<&str> = given.iter().map(|(n, _)| n.strip_prefix(&format!("{id}/")).unwrap()).collect();
            assert_eq!(names, [".sg/cmd", ".sg/job.sh", "a/b"]);
        }

        #[test]
        fn a_marker_the_job_prints_itself_doesnt_end_or_misreport_it() {
            let (board, _runner) = testing::machine("job-spoof");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let (id, nonce) = start_launcher(&board, &activity, &mut String::new());
                    // The job read its id from .sg/job.sh and prints "done, status 0" itself, as
                    // the old launcher did, and with a guessed nonce
                    activity.observe(&Event::Serial(format!("\r\nSGDONE_{id}_0_0\r\nSGDONE_{id}_0000000000000000_0_0\r\n").into_bytes()));
                    std::thread::sleep(Duration::from_millis(300));
                    board.fs_write_file(&format!("/sgjob/{id}/.sg/output"), b"real", 0o644).unwrap();
                    marker(&activity, &id, &nonce, 7, false);
                })
            };
            let done = run(&board, &activity, &request(vec![], Duration::from_secs(30))).unwrap();
            guest.join().unwrap();
            assert_eq!(done.status, Some(7), "ended by its own marker");
            assert_eq!(done.output, b"real");
            assert!(done.ms >= 300);
        }

        #[test]
        fn a_job_whose_shell_never_comes_back_holds_up_the_next_one() {
            let (board, _runner) = testing::machine("job-stuck-shell");
            let activity = Activity::new(false);
            let mut typed = String::new();
            // A job out of time whose launcher never answers the ctrl-c, nor the sync after it
            let first = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || run(&board, &activity, &request(vec![], Duration::from_millis(50))))
            };
            let (first_id, _) = start_launcher(&board, &activity, &mut typed);
            let done = first.join().unwrap().unwrap();
            assert_eq!(done.status, None);
            assert!(done.timed_out && !done.killed);
            assert!(activity.shell_busy.load(Ordering::SeqCst));
            // The next one isn't typed into the busy shell: it fails, having typed only a sync
            let e = run(&board, &activity, &request(vec![], Duration::from_secs(30))).err().unwrap();
            assert_eq!(e, "the guest's shell is not answering");
            typed.push_str(&testing::typed(&board));
            assert!(!typed.contains("sh /sgjob/"), "typed into the busy shell: {typed:?}");
            let jobs: Vec<String> = board.fs_read_tree("/sgjob").unwrap().unwrap().iter().map(|(n, _)| n.split('/').next().unwrap().to_string()).collect();
            assert!(jobs.iter().all(|j| *j == first_id), "{jobs:?}");
            // Once the shell is back, jobs run again
            typed.clear();
            let next = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || run(&board, &activity, &request(vec![], Duration::from_secs(30))))
            };
            answer_sync(&board, &activity, &mut typed);
            let (id, nonce) = start_launcher(&board, &activity, &mut typed);
            marker(&activity, &id, &nonce, 0, false);
            assert_eq!(next.join().unwrap().unwrap().status, Some(0));
            assert!(!activity.shell_busy.load(Ordering::SeqCst));
        }

        #[test]
        fn a_killed_job_whose_shell_answers_frees_it_at_once() {
            let (board, _runner) = testing::machine("job-late-sync");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let mut typed = String::new();
                    start_launcher(&board, &activity, &mut typed);
                    // No marker, but the shell is back by the time the host asks
                    answer_sync(&board, &activity, &mut typed);
                })
            };
            let done = run(&board, &activity, &request(vec![], Duration::from_millis(50))).unwrap();
            guest.join().unwrap();
            assert!(done.timed_out && done.status.is_none());
            assert!(!activity.shell_busy.load(Ordering::SeqCst));
        }

        #[test]
        fn a_bad_variable_name_fails_the_job_before_it_starts() {
            let (board, _runner) = testing::machine("job-badenv");
            let r = Request { env: vec![("A B".into(), "v".into())], ..request(vec![], Duration::from_secs(1)) };
            assert_eq!(run(&board, &Activity::new(false), &r).err().unwrap(), "A B: not a variable name");
            assert!(board.fs_read_tree("/sgjob").unwrap().is_none());
        }

        #[test]
        fn a_workspace_job_writes_out_back_into_the_directory() {
            let (board, _runner) = testing::machine("job-ws");
            let activity = Activity::new(false);
            let dir = testing::tmp("job-ws-dir");
            testing::write(&dir, &[("in.txt", b"in")]);
            let guest = play(board.clone(), activity.clone(), Duration::ZERO, &[("out/a/b.txt", b"result"), ("out/c", b"c")], 0, false);
            let w = Workspace { dir: dir.clone(), command: "true".into(), env: vec![], timeout: Duration::from_secs(30) };
            let (done, n) = run_workspace(&board, &activity, &w).unwrap();
            let (_, given) = guest.join().unwrap();
            assert!(given.iter().any(|(n, d)| n.ends_with("/in.txt") && d == b"in"));
            assert_eq!((done.status, n), (Some(0), 2));
            assert_eq!(std::fs::read(dir.join("out/a/b.txt")).unwrap(), b"result");
            assert_eq!(std::fs::read(dir.join("out/c")).unwrap(), b"c");
        }
    }

    /// The launcher, run by this machine's sh as the guest's serial shell runs it: on a terminal
    /// (a pty here), where ctrl-c is a byte typed into it. What it prints, and what it leaves.
    #[cfg(target_os = "linux")]
    mod launcher {
        use super::super::*;
        use std::io::{Read, Write};
        use std::os::fd::AsFd;
        use std::process::Command;

        const NONCE: &str = "0123456789abcdef";

        struct Run {
            ws: PathBuf,
            child: std::process::Child,
            master: std::fs::File,
            printed: Arc<Mutex<Vec<u8>>>,
        }

        impl Run {
            /// `path`: the PATH the launcher gets (to leave setsid out of it)
            fn start(name: &str, env: &[(String, String)], command: &str, path: Option<&Path>) -> Run {
                Run::start_in(name, env, command, path, false)
            }

            /// `home`: the command starts in the home directory, not the workspace
            fn start_in(name: &str, env: &[(String, String)], command: &str, path: Option<&Path>, home: bool) -> Run {
                let ws = std::env::temp_dir().join(format!("sgjob-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&ws);
                // As `run` makes them, from the host
                for d in [".sg", "in", "out"] {
                    std::fs::create_dir_all(ws.join(d)).unwrap();
                }
                let (launcher, cmd) = scripts("t", ws.to_str().unwrap(), env, command, home).unwrap();
                std::fs::write(ws.join(".sg/cmd"), cmd).unwrap();
                std::fs::write(ws.join(".sg/job.sh"), launcher).unwrap();

                let (master, slave) = crate::sys::openpty().unwrap();
                let master = std::fs::File::from(master);
                let mut cmd = Command::new("sh");
                cmd.arg(ws.join(".sg/job.sh"));
                if let Some(p) = path {
                    cmd.env("PATH", p);
                }
                // A session of its own, the pty its terminal, as getty gives the shell
                crate::sys::on_terminal(&mut cmd, slave.as_fd());
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
                let mut run = Run { ws, child, master, printed };
                // It asks for its nonce, as the host types it
                let begun = Instant::now();
                while !String::from_utf8_lossy(&run.printed.lock().unwrap()).contains("SGNONCE_t") {
                    assert!(begun.elapsed() < Duration::from_secs(10), "the launcher never asked for its nonce");
                    std::thread::sleep(Duration::from_millis(10));
                }
                run.master.write_all(format!("{NONCE}\n").as_bytes()).unwrap();
                run
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
                (parse_marker(&printed, "t", NONCE), self.ws)
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

        #[test]
        fn a_command_for_a_person_starts_in_the_home_directory() {
            let home = std::env::temp_dir().join(format!("sgjob-homedir-{}", std::process::id()));
            std::fs::create_dir_all(&home).unwrap();
            let run = Run::start_in(
                "home",
                &[("HOME".into(), home.to_str().unwrap().into())],
                "pwd; echo made > \"$EXCLAVE_WORKSPACE\"/out/r",
                None,
                true,
            );
            let (marker, ws) = run.finish();
            assert_eq!(marker, Some((0, false)));
            assert_eq!(std::fs::read_to_string(ws.join(".sg/output")).unwrap(), format!("{}\n", home.display()));
            assert_eq!(std::fs::read_to_string(ws.join("out/r")).unwrap(), "made\n");
            let _ = std::fs::remove_dir_all(&home);
        }

        #[test]
        fn a_job_that_prints_its_own_marker_on_the_terminal_isnt_believed() {
            // What a job can do: read its id from the launcher, find the launcher's terminal, and
            // print "done, status 0" there, with no nonce or a guessed one
            let run = Run::start(
                "spoof",
                &[],
                r#"id=$(awk '/SGNONCE/ {print $NF}' .sg/job.sh)
for p in /proc/[0-9]*; do
  f=$(readlink "$p/fd/1" 2>/dev/null)
  case "$f" in /dev/pts/*) grep -q job.sh "$p/cmdline" 2>/dev/null && t=$f ;; esac
done
[ -n "$t" ] || exit 99
printf '
SGDONE_%s_0_0
SGDONE_%s_0000000000000000_0_0
' "$id" "$id" > "$t"
exit 7"#,
                None,
            );
            let (marker, _) = run.finish();
            assert_eq!(marker, Some((7, false)));
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
            for tool in ["sh", "sleep", "sync", "cat", "grep"] {
                let found = ["/bin", "/usr/bin"].iter().map(|d| Path::new(d).join(tool)).find(|p| p.exists()).unwrap();
                std::os::unix::fs::symlink(found, bin.join(tool)).unwrap();
            }
            kills_everything("nosetsid", ["3181", "3182", "3183", "3184"], Some(&bin));
        }
    }
}
