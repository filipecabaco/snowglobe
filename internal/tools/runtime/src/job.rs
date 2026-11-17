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

use crate::limits::{Abort, Guard, Limits};
use crate::log;
use crate::machine::Activity;

/// A file for a job: its path in the workspace, contents and mode.
pub type File = (String, Vec<u8>, u32);

#[derive(Default)]
pub struct Request {
    pub files: Vec<File>,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    /// Start in the home directory rather than the workspace: a command typed by a person or an
    /// agent (`snowglobe sh`, run_command), not a job that reads its files in and writes out/
    pub home: bool,
    /// What it may use besides its time (limits.rs)
    pub limits: Limits,
    /// An absolute guest path to run in instead of its own /sgjob/<id> (`"workdir"`): its files
    /// are copied there by the guest before the command starts, and its out/ is read from there
    /// (only what the job wrote: what out/ held before is not its result). How a job forked from a
    /// build's snapshot runs in the workspace the build left (`/workspace`)
    pub workdir: Option<String>,
    /// Recorded with it (`"labels"`: who it is for), in its log events
    pub labels: Vec<(String, String)>,
    /// Set to end it as one stopped is (its client went: `cancelled`)
    pub cancel: Arc<AtomicBool>,
    /// On a running machine's control socket, not a process of its own: past its memory or CPU
    /// time it is killed (the machine goes on), not the process ended, and those count from the
    /// job's start
    pub instance: bool,
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
    /// Out of memory: the guest killed it (`--memory-limit`, its status 137), or this process went
    /// past `--max-rss` and ended it
    pub oom: bool,
    /// It printed more than `--output-limit`: killed, and what it printed cut there
    pub output_truncated: bool,
    /// A write of the guest's was refused for the disk limit (ENOSPC)
    pub disk_full: bool,
    /// This process went past `--cpu-time`, and ended it
    pub cpu_time_exceeded: bool,
    /// out/ was more than the copy limit: what is past it was left behind
    pub out_truncated: bool,
    pub ms: u64,
}

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
static STOPPING: AtomicBool = AtomicBool::new(false);
/// Jobs running beside a program with no kernel (user.rs), which stop as these do
static BESIDE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Whether the instance is stopping (its jobs are to be killed, and no other starts)
pub(crate) fn stopping() -> bool {
    STOPPING.load(Ordering::SeqCst)
}

/// A job beside a program with no kernel starts (`ended` when it has answered): wait_idle waits
/// for it too
pub(crate) fn begun_beside() {
    BESIDE.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn ended_beside() {
    BESIDE.fetch_sub(1, Ordering::SeqCst);
}

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
        let free = ONE_AT_A_TIME.try_lock().is_ok() || matches!(ONE_AT_A_TIME.try_lock(), Err(std::sync::TryLockError::Poisoned(_)));
        if free && BESIDE.load(Ordering::SeqCst) == 0 {
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
#[cfg(test)]
pub fn scripts(id: &str, ws: &str, env: &[(String, String)], command: &str, home: bool) -> Result<(String, String), String> {
    scripts_limited(id, ws, env, command, home, &Limits::default(), None)
}

/// A job's workdir (`Request::workdir`): an absolute guest path, spelled plainly, that isn't the
/// root, the guest's own (/proc, /sys, /dev) or a job's (/sgjob).
pub fn check_workdir(w: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("workdir {w}: {why}"));
    if !w.starts_with('/') {
        return bad("an absolute path");
    }
    let parts: Vec<&str> = w.split('/').filter(|c| !c.is_empty()).collect();
    if parts.is_empty() {
        return bad("not the root");
    }
    if parts.iter().any(|c| *c == "." || *c == "..") || w.contains(['\n', '\0']) {
        return bad("no . or .. in it");
    }
    if matches!(parts[0], "proc" | "sys" | "dev" | "sgjob") {
        return bad("not under /proc, /sys, /dev or /sgjob");
    }
    Ok(())
}

/// The cgroup v2 hierarchy in the guest (the boot layer's init mounts it)
const CGROUP: &str = "/sys/fs/cgroup";
/// The cgroup the boot layer's init makes for jobs' limits, under `CGROUP`
pub const SHARED_CGROUP: &str = "sgjob";
/// cpu.max's period, microseconds
const CPU_PERIOD: u64 = 100_000;

/// `scripts`, with the limits the guest enforces (`Limits::in_guest`): the command in a cgroup v2
/// of its own (memory.max with no swap and the whole group killed on OOM, cpu.max, pids.max),
/// `in/` mounted read-only. What the guest can't enforce, the launcher says
/// (`SGFAIL_<id>_<nonce>_<what>`, `parse_fail`) and starts nothing. With a `workdir`, the job's
/// files (written into `ws`/files) are copied there by the guest first, and the command starts
/// there; the launcher still keeps its own files in `ws`/.sg.
pub fn scripts_limited(
    id: &str,
    ws: &str,
    env: &[(String, String)],
    command: &str,
    home: bool,
    limits: &Limits,
    workdir: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(w) = workdir {
        check_workdir(w)?;
    }
    let wd = workdir.unwrap_or(ws);
    // The app's environment: a login PATH, /etc/profile, the image's ENV (from the file a build
    // writes; a site built before there was one has it only in its console script)
    let mut cmd = String::from(
        "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root\n\
         [ -f /etc/profile ] && . /etc/profile >/dev/null 2>&1\n\
         if [ -f /etc/snowglobe/env ]; then . /etc/snowglobe/env\n\
         elif [ -f /usr/local/bin/snowglobe-console ]; then eval \"$(grep '^export ' /usr/local/bin/snowglobe-console)\"; fi\n",
    );
    if !home {
        cmd += &format!("cd {} || exit 1\n", quote(wd));
    }
    cmd += &format!("export EXCLAVE_WORKSPACE={}\n", quote(wd));
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

    // The guest's limits, set up before the command starts: anything that fails ends the
    // launcher with what it was, and nothing runs
    let mut setup = String::new();
    let (mut join, mut leave) = (String::new(), String::new());
    if limits.in_guest() || workdir.is_some() {
        setup += &format!("sg_fail() {{ printf '\\nSGFAIL_%s_%s_%s\\n' {id} \"$n\" \"$1\"; exit 0; }}\n");
    }
    if let Some(w) = workdir {
        // Copied by the guest, not written into it from the host: the workdir is a directory its
        // kernel has seen (and caches), the job's own directory is not. Then dropped, so the
        // copy counts once against the disk limit
        setup += &format!(
            "wd={}\nmkdir -p \"$wd\" && cp -a files/. \"$wd\"/ && rm -rf files && mkdir -p \"$wd/in\" \"$wd/out\" || sg_fail workdir\n",
            quote(w)
        );
    }
    if limits.cgroup() {
        // No process is started for any of it (each would be one more for the emulated guest to
        // fork and exec, ~5 ms apiece): the shell's own read, echo, test and case. The cgroup is
        // the one the boot layer's init made (`sgjob`, the controllers already handed down to
        // it), reused while it is empty (one job at a time per machine); a site whose init didn't
        // make one, or with something else running in it, gets one of the job's own (removed
        // after). What a limited job leaves running is killed as it ends, so its cgroup is empty
        let mut controllers = Vec::new();
        let mut set = String::new();
        match limits.memory_mb {
            Some(mb) => {
                controllers.push("memory");
                set += &format!(
                    "echo {} >\"$cg/memory.max\" || sg_fail memory\n\
                     [ -f \"$cg/memory.swap.max\" ] && echo 0 >\"$cg/memory.swap.max\"\n\
                     echo 1 >\"$cg/memory.oom.group\" 2>/dev/null\n",
                    mb << 20
                );
            },
            None => set += "[ -f \"$cg/memory.max\" ] && echo max >\"$cg/memory.max\"\n",
        }
        match limits.cpus {
            Some(cpus) => {
                controllers.push("cpu");
                let quota = ((cpus * CPU_PERIOD as f64).round() as u64).max(1000);
                set += &format!("echo '{quota} {CPU_PERIOD}' >\"$cg/cpu.max\" || sg_fail cpu\n");
            },
            None => set += "[ -f \"$cg/cpu.max\" ] && echo max >\"$cg/cpu.max\"\n",
        }
        match limits.pids {
            Some(n) => {
                controllers.push("pids");
                set += &format!("echo {n} >\"$cg/pids.max\" || sg_fail pids\n");
            },
            None => set += "[ -f \"$cg/pids.max\" ] && echo max >\"$cg/pids.max\"\n",
        }
        let controllers = controllers.join(" ");
        setup += &format!(
            r#"[ -f {CGROUP}/cgroup.controllers ] || mount -t cgroup2 cgroup2 {CGROUP} 2>/dev/null
[ -f {CGROUP}/cgroup.controllers ] || sg_fail cgroup
read -r sc <{CGROUP}/cgroup.subtree_control
for c in {controllers}; do
  case " $sc " in *" $c "*) ;; *) echo "+$c" >{CGROUP}/cgroup.subtree_control 2>/dev/null || sg_fail "$c" ;; esac
done
cg={CGROUP}/{SHARED_CGROUP}
if [ ! -d "$cg" ] || read -r x <"$cg/cgroup.procs"; then cg={CGROUP}/sgjob-{id} cgnew=1; mkdir "$cg" || sg_fail cgroup; fi
{set}sg_ooms() {{
  o_n=0
  [ -f "$cg/memory.events" ] || return 0
  while read -r sg_k sg_v; do [ "$sg_k" = oom_kill ] && o_n=$sg_v; done <"$cg/memory.events"
}}
sg_ooms; o0=$o_n
read -r me </proc/self/cgroup
"#
        );
        // The launcher joins the cgroup only to start the command in it (what it forks is born
        // there), then goes back where it was: a kill of the cgroup (OOM, out of time) never
        // takes the launcher with it
        join = "echo $$ >\"$cg/cgroup.procs\" || sg_fail cgroup\n".to_string();
        leave = format!("echo $$ >\"{CGROUP}${{me#0::}}/cgroup.procs\" 2>/dev/null\n");
    }
    if limits.read_only_in {
        setup += "mount -o bind \"$wd/in\" \"$wd/in\" 2>/dev/null && mount -o remount,ro,bind \"$wd/in\" 2>/dev/null || sg_fail read_only_in\nro=1\n";
    }

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
cg= cgnew= ro= o=0 wd=.
{setup}sg_procs() {{
  for p in /proc/[0-9]*; do
    read -r st 2>/dev/null <"$p/stat" || continue
    set -- ${{st##*") "}}
    if [ "${{p#/proc/}}" != "$$" ] && {{ [ "$3" = "$pg" ] || [ "$4" = "$pg" ]; }}; then echo "${{p#/proc/}}"; fi
  done
}}
sg_kill() {{
  [ -n "$cg" ] && echo 1 >"$cg/cgroup.kill" 2>/dev/null
  kill -"$1" -"$pg" 2>/dev/null
  for q in $(sg_procs); do kill -"$1" "$q" 2>/dev/null; done
}}
sg_alive() {{
  kill -0 -"$pg" 2>/dev/null || [ -n "$(sg_procs)" ]
}}
{join}if command -v setsid >/dev/null 2>&1; then
  setsid sh .sg/cmd </dev/null >.sg/output 2>&1 &
else
  set -m; sh .sg/cmd </dev/null >.sg/output 2>&1 & set +m
fi
pg=$!
{leave}wait "$pg"; s=$?
if [ "$k" = 1 ]; then
  sg_kill TERM
  i=0
  while [ "$i" -lt 30 ] && sg_alive; do
    if sleep 0.1 2>/dev/null; then i=$((i+1)); else sleep 1; i=$((i+10)); fi
  done
  sg_kill KILL
  wait "$pg"; s=$?
fi
if [ -n "$cg" ]; then
  sg_ooms
  [ "$o_n" != "$o0" ] && {{ o=1; s=137; }}
  if read -r x <"$cg/cgroup.procs"; then
    echo 1 >"$cg/cgroup.kill" 2>/dev/null
    i=0
    while [ "$i" -lt 50 ] && read -r x <"$cg/cgroup.procs"; do sleep 0.02 2>/dev/null || sleep 1; i=$((i+1)); done
  fi
  [ -n "$cgnew" ] && rmdir "$cg" 2>/dev/null
fi
[ -n "$ro" ] && umount "$wd/in" 2>/dev/null
sync
printf '\nSGDONE_%s_%s_%s_%s_%s\n' {id} "$n" "$s" "$k" "$o"
"#,
        ws = quote(ws),
    );
    Ok((launcher, cmd))
}

/// What the launcher's marker says: the command's status, whether it was killed (out of time or
/// stopped), and whether the guest killed it for its memory limit
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marker {
    pub status: i32,
    pub killed: bool,
    pub oom: bool,
}

/// The launcher's marker in what the serial line printed. Only a whole line
/// `SGDONE_<id>_<nonce>_<status>_<0|1>[_<0|1>]` counts: not one without the nonce, nor one pieced
/// together around the terminal's echo of the typed nonce.
pub fn parse_marker(printed: &str, id: &str, nonce: &str) -> Option<Marker> {
    let prefix = format!("SGDONE_{id}_{nonce}_");
    // Whole lines only: the last piece hasn't ended yet
    let (lines, _) = printed.rsplit_once('\n')?;
    lines.split('\n').find_map(|line| {
        let mut parts = line.trim_end_matches('\r').strip_prefix(&prefix)?.split('_');
        let status = parts.next()?.parse().ok()?;
        let flag = |p: Option<&str>| match p {
            Some("0") => Some(false),
            Some("1") => Some(true),
            _ => None,
        };
        let killed = flag(parts.next())?;
        let oom = match parts.next() {
            None => false,
            p => flag(p)?,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(Marker { status, killed, oom })
    })
}

/// What the launcher couldn't set up (`SGFAIL_<id>_<nonce>_<what>` on a line of its own), as the
/// job's error.
pub fn parse_fail(printed: &str, id: &str, nonce: &str) -> Option<String> {
    let prefix = format!("SGFAIL_{id}_{nonce}_");
    let (lines, _) = printed.rsplit_once('\n')?;
    let what = lines.split('\n').find_map(|line| line.trim_end_matches('\r').strip_prefix(&prefix).map(str::to_string))?;
    let rebuild = "rebuild the site with a snowglobe whose guest kernel has cgroup v2";
    Some(match what.as_str() {
        "cgroup" => format!("the guest can't limit the job's memory, CPUs or processes: its kernel has no cgroup v2 ({rebuild})"),
        "memory" => "the guest can't enforce memory_limit_mb: its site was built without the memory cgroup controller \
                     (rebuild it with snowglobe build --memory-limits)"
            .to_string(),
        "cpu" => format!("the guest can't enforce cpus_limit: its kernel has no cpu cgroup controller ({rebuild})"),
        "pids" => format!("the guest can't enforce pids_limit: its kernel has no pids cgroup controller ({rebuild})"),
        "read_only_in" => "the guest can't mount in/ read-only (read_only_in)".to_string(),
        "workdir" => "the job's files couldn't be copied into its workdir, or its in/ and out/ made there".to_string(),
        other => format!("the guest can't set up the job's limits ({other})"),
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

/// How often a job whose process watches itself (its memory, CPU time, output) looks
const WATCH: Duration = Duration::from_millis(50);

/// The size of a file in the guest's filesystem (0 if there is none).
fn guest_size(board: &armless::Board, path: &str) -> u64 {
    board.with_fs(|fs| fs.lookup_path(path).and_then(|i| fs.get(i)).map_or(0, |i| i.size)).unwrap_or(0)
}

/// A file of the guest's, its first `max` bytes at most, and whether there was more.
pub(crate) fn read_guest(board: &armless::Board, path: &str, max: Option<u64>) -> (Vec<u8>, bool) {
    board
        .with_fs(|fs| {
            let Some(ino) = fs.lookup_path(path) else { return (Vec::new(), false) };
            let size = fs.get(ino).map_or(0, |i| i.size);
            let n = max.map_or(size, |m| m.min(size));
            (fs.read(ino, 0, n as usize).unwrap_or_default(), size > n)
        })
        .unwrap_or_default()
}

/// The regular files under a guest directory, paths relative to it, no more than `max` bytes of
/// them in all (in path order: what would go past it is left out), and whether any was left out.
/// Which version of each regular file under a guest directory there is (its inode and the stamp
/// of its contents), by path relative to it.
/// A file of out/: its path under it, and its contents
pub(crate) type OutFile = (String, Vec<u8>);

pub(crate) type Stamps = std::collections::HashMap<String, (u64, u64)>;

/// The regular files under a guest directory now, and which version of each (`Stamps`).
pub(crate) fn guest_stamps(board: &armless::Board, path: &str) -> Stamps {
    use armless::dev::fs;
    board
        .with_fs(|f| {
            let mut found = Stamps::new();
            let Some(top) = f.lookup_path(path) else { return found };
            let mut stack = vec![(top, String::new())];
            while let Some((dir, prefix)) = stack.pop() {
                let Ok(entries) = f.list(dir) else { continue };
                for (name, ino) in entries {
                    if name == b"." || name == b".." {
                        continue;
                    }
                    let rel = format!("{prefix}{}", String::from_utf8_lossy(&name));
                    let Some(i) = f.get(ino) else { continue };
                    match i.mode & fs::S_IFMT {
                        fs::S_IFDIR => stack.push((ino, rel + "/")),
                        fs::S_IFREG => {
                            found.insert(rel, (ino, i.data_gen));
                        },
                        _ => {},
                    }
                }
            }
            found
        })
        .unwrap_or_default()
}

/// `read_guest_tree`, leaving out the files that are as they were in `before` (the same inode,
/// unchanged since): what the job didn't write.
pub(crate) fn read_guest_tree_since(board: &armless::Board, path: &str, max: u64, before: &Stamps) -> Result<(Vec<OutFile>, bool), String> {
    use armless::dev::fs;
    board
        .with_fs(|f| {
            let Some(top) = f.lookup_path(path) else { return Ok((Vec::new(), false)) };
            // Names and sizes first, so nothing past the limit is read
            let mut found = Vec::new();
            let mut stack = vec![(top, String::new())];
            while let Some((dir, prefix)) = stack.pop() {
                let Ok(entries) = f.list(dir) else { continue };
                for (name, ino) in entries {
                    if name == b"." || name == b".." {
                        continue;
                    }
                    let rel = format!("{prefix}{}", String::from_utf8_lossy(&name));
                    let Some(i) = f.get(ino) else { continue };
                    match i.mode & fs::S_IFMT {
                        fs::S_IFDIR => stack.push((ino, rel + "/")),
                        fs::S_IFREG if before.get(&rel) != Some(&(ino, i.data_gen)) => found.push((rel, ino, i.size)),
                        _ => {},
                    }
                }
            }
            found.sort();
            let (mut out, mut total, mut cut) = (Vec::new(), 0u64, false);
            for (rel, ino, size) in found {
                if rel.split('/').any(|c| c == "..") {
                    continue;
                }
                if total + size > max {
                    cut = true;
                    continue;
                }
                total += size;
                match f.read_all(ino) {
                    Ok(data) => out.push((rel, data)),
                    Err(_) => return Err(format!("{path}/{rel}: contents not loaded")),
                }
            }
            Ok((out, cut))
        })
        .unwrap_or(Ok((Vec::new(), false)))
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
    let limits = &req.limits;
    let begun = Instant::now();
    let id = token();
    let nonce = token();
    let ws = format!("/sgjob/{id}");
    let workdir = req.workdir.as_deref();
    let (launcher, cmd) = scripts_limited(&id, &ws, &req.env, &req.command, req.home, limits, workdir)?;
    // Where its files go from the host (a workdir's: a directory of the job's own, which the
    // guest copies them from), and where its in/ and out/ are
    let (into, wd) = match workdir {
        Some(w) => (format!("{ws}/files"), w.trim_end_matches('/').to_string()),
        None => (ws.clone(), ws.clone()),
    };
    let given: u64 = req.files.iter().map(|f| f.1.len() as u64).sum();
    if given > limits.copy_bytes() {
        return Err(format!("the job's files are {} MB, more than its copy limit ({} MB)", given >> 20, limits.copy_mb));
    }
    let mut files = 0;
    for (rel, data, mode) in &req.files {
        // However it is spelled (`/out/x`, `./out/x`), nothing goes in the job's own directories
        let first = rel.split('/').find(|c| !c.is_empty() && *c != ".");
        if matches!(first, Some(".sg" | "out")) || rel.split('/').any(|c| c == "..") {
            continue;
        }
        board.fs_write_file(&format!("{into}/{rel}"), data, *mode)?;
        files += 1;
    }
    // in/ and out/ made from here: a mkdir in the guest is a process started, for every job
    if workdir.is_some() {
        // The guest makes in/ and out/ in the workdir as it copies the files there
        board.fs_mkdir(&into)?;
    } else {
        board.fs_mkdir(&format!("{ws}/in"))?;
        board.fs_mkdir(&format!("{ws}/out"))?;
    }
    // What the workdir's out/ already holds (a build's, say) isn't this job's result
    let before = workdir.map(|_| guest_stamps(board, &format!("{wd}/out"))).unwrap_or_default();
    board.fs_write_file(&format!("{ws}/.sg/cmd"), cmd.as_bytes(), 0o755)?;
    board.fs_write_file(&format!("{ws}/.sg/job.sh"), launcher.as_bytes(), 0o755)?;
    // The disk limit counts what the job writes, from here: its files are in, and its own
    // directories made. Lifted when it ends (an instance's next job has its own)
    if let Some(mb) = limits.disk_mb {
        if !board.set_fs_write_limit(Some(mb << 20)) {
            return Err("disk_limit_mb: the machine has no filesystem to limit".into());
        }
    }
    // What it prints is a file of the guest's too: with a limit of its own (a byte past the
    // output limit, to see it was passed; else as much as the disk limit), outside the disk
    // limit, so a job that fills its disk still says what happened
    if let Some(cap) = limits.output.map(|o| o + 1).or(limits.disk_mb.map(|mb| mb << 20)) {
        board.fs_write_file(&format!("{ws}/.sg/output"), b"", 0o644)?;
        board.set_fs_allowance(&format!("{ws}/.sg/output"), Some(cap));
    }
    log::event(
        "job_start",
        json!({
            "job": id,
            "pid": std::process::id(),
            "cmd": req.command,
            // Names only: values can be secrets
            "env": req.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            "files": files,
            "timeout": req.timeout.as_secs_f64(),
            "limits": serde_json::Value::Object(limits.to_json()),
            "workdir": workdir,
            "labels": labels_json(&req.labels),
        }),
    );

    let output_path = format!("{ws}/.sg/output");
    // A process of its own is ended with the job; a machine's job is killed, counted from its start
    let guard = if req.instance { Guard::from_now(limits) } else { Guard::new(limits) };
    let mut ended_for = None;
    let poll = if limits.watched() { WATCH } else { Duration::from_millis(200) };
    let from = activity.serial_total();
    // SNOWGLOBE_TIMING: when each step of the exchange with the launcher happened
    let timing = std::env::var_os("SNOWGLOBE_TIMING").is_some();
    let typed = Instant::now();
    let mut asked_at = None;
    let mut echoed_at = None;
    board.serial_input(format!("sh {ws}/.sg/job.sh\n").as_bytes());
    activity.touch();
    let mut deadline = begun + req.timeout;
    let mut done = Done::default();
    let mut killing = false;
    let mut marker = None;
    let mut asked = false;
    let mut failed = None;
    // Ended from here, at once: this process is out of memory or CPU time, and ends with the job
    let mut aborted = None;
    {
        let mut screen = activity.screen.lock().unwrap();
        loop {
            let printed = String::from_utf8_lossy(&activity.serial_since(from)).into_owned();
            if timing && echoed_at.is_none() && printed.contains("job.sh") {
                echoed_at = Some(typed.elapsed());
            }
            if !asked && printed.contains(&format!("SGNONCE_{id}")) {
                // With the host's time, which the launcher sets the guest's clock to
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                board.serial_input(format!("{nonce} {now}\n").as_bytes());
                asked = true;
                asked_at = Some(typed.elapsed());
            }
            if let Some(m) = parse_marker(&printed, &id, &nonce) {
                marker = Some(m);
                if timing {
                    eprintln!(
                        "timing: job set up in {:.1} ms, its line echoed at {:.1} ms, launcher asked for its nonce at {:.1} ms, marker at {:.1} ms",
                        typed.duration_since(begun).as_secs_f64() * 1e3,
                        echoed_at.unwrap_or_default().as_secs_f64() * 1e3,
                        asked_at.unwrap_or_default().as_secs_f64() * 1e3,
                        typed.elapsed().as_secs_f64() * 1e3
                    );
                }
                break;
            }
            if limits.in_guest() || workdir.is_some() {
                if let Some(e) = parse_fail(&printed, &id, &nonce) {
                    failed = Some(e);
                    break;
                }
            }
            // (A machine's job is killed only once its launcher has trapped ctrl-c: it has asked
            // for its nonce)
            if !killing && (asked || !req.instance) {
                if let Some(a) = guard.check() {
                    if !req.instance {
                        aborted = Some(a);
                        break;
                    }
                    // A machine's job: killed as one out of time is, the machine goes on
                    board.serial_input(&[0x03]);
                    killing = true;
                    ended_for = Some(a);
                    deadline = Instant::now() + KILL_GRACE;
                    continue;
                }
            }
            let stopping = STOPPING.load(Ordering::SeqCst) || (asked && req.cancel.load(Ordering::SeqCst));
            if !killing {
                let over = limits.output.is_some_and(|max| guest_size(board, &output_path) > max);
                if over || stopping || Instant::now() >= deadline {
                    // ctrl-c: the launcher kills the command's session, then prints its marker
                    board.serial_input(&[0x03]);
                    killing = true;
                    done.output_truncated = over;
                    done.timed_out = !over && !stopping;
                    done.cancelled = !over && stopping;
                    deadline = Instant::now() + KILL_GRACE;
                    continue;
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            screen = activity.screen_cv.wait_timeout(screen, left.min(poll)).unwrap().0;
        }
    }
    if let Some(e) = failed {
        board.set_fs_write_limit(None);
        log::event("job_end", json!({ "job": id, "error": e }));
        return Err(e);
    }
    let (output, cut) = read_guest(board, &output_path, limits.output);
    done.output = output;
    done.output_truncated |= cut;
    if let Some(m) = marker {
        done.killed = m.killed;
        done.oom = m.oom;
        if m.killed {
            // Out of time (or stopped, or past its output limit), whatever it ended with
            if let Some(a) = ended_for {
                done.oom |= a == Abort::Rss;
                done.cpu_time_exceeded = a == Abort::CpuTime;
            }
        } else {
            // It ended by itself (if a ctrl-c went, it went just after, to the shell's prompt)
            done.status = Some(m.status);
            done.timed_out = false;
            done.cancelled = false;
            done.output_truncated = cut;
        }
    }
    match aborted {
        Some(a) => {
            // Nothing more is asked of the guest: this process ends with the job
            done.killed = true;
            done.timed_out = false;
            done.cancelled = false;
            done.oom = a == Abort::Rss;
            done.cpu_time_exceeded = a == Abort::CpuTime;
        },
        // No marker even after the ctrl-c: the launcher may still be running in the shell. The job
        // keeps the shell (and the lock) until the shell answers; if it doesn't, the next job asks
        // again rather than being typed into it
        None if marker.is_none() && !shell_answers(board, activity, SYNC_WAIT) => {
            activity.shell_busy.store(true, Ordering::SeqCst);
            log::event("job_shell_busy", json!({ "job": id }));
        },
        None => {},
    }
    // What it wrote to out/, however it ended (out of time, it keeps what it had), up to the
    // copy limit
    let (out, out_cut) = read_guest_tree_since(board, &format!("{wd}/out"), limits.copy_bytes(), &before)?;
    done.out = out;
    done.out_truncated = out_cut;
    done.disk_full = board.fs_write_budget().is_some_and(|b| b.hit);
    if limits.disk_mb.is_some() {
        board.set_fs_write_limit(None);
    }
    done.ms = begun.elapsed().as_millis() as u64;
    let shown = &done.output[..done.output.len().min(LOGGED_OUTPUT)];
    log::event(
        "job_end",
        json!({
            "job": id,
            "labels": labels_json(&req.labels),
            "status": done.status,
            "timed_out": done.timed_out,
            "cancelled": done.cancelled,
            "killed": done.killed,
            "oom": done.oom,
            "output_truncated": done.output_truncated,
            "disk_full": done.disk_full,
            "cpu_time_exceeded": done.cpu_time_exceeded,
            "out_truncated": done.out_truncated,
            "ms": done.ms,
            "output": String::from_utf8_lossy(shown),
            "output_bytes": done.output.len(),
            "out_files": done.out.len(),
        }),
    );
    Ok(done)
}

/// Set `cancel` when the client on `conn` goes (its connection closes) or sends anything more
/// (a line `cancel`): a job on a machine's control socket is then stopped, as when the machine
/// stops, and answered `cancelled`. A client must keep its side open for writing while it waits.
pub(crate) fn watch_cancel(conn: &std::os::unix::net::UnixStream, cancel: Arc<AtomicBool>) {
    use std::io::Read;
    let Ok(mut c) = conn.try_clone() else { return };
    std::thread::spawn(move || {
        let mut b = [0u8; 256];
        loop {
            match c.read(&mut b) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                _ => break,
            }
        }
        cancel.store(true, Ordering::SeqCst);
    });
}

/// A job whose workspace is a host directory (`--workspace DIR`): its files go in, `out/` comes
/// back into it.
pub struct Workspace {
    pub dir: PathBuf,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    pub limits: Limits,
}

impl Workspace {
    /// The job it asks for: the directory's files (up to the copy limit) in.
    pub fn request(&self) -> Result<Request, String> {
        Ok(Request {
            files: files(&self.dir, self.limits.copy_bytes())?,
            command: self.command.clone(),
            env: self.env.clone(),
            timeout: self.timeout,
            home: false,
            limits: self.limits.clone(),
            ..Request::default()
        })
    }
}

pub fn run_workspace(board: &armless::Board, activity: &Arc<Activity>, w: &Workspace) -> Result<(Done, usize), String> {
    let done = run(board, activity, &w.request()?)?;
    let n = write_out(&w.dir, &done.out);
    Ok((done, n))
}

/// What a job wrote to out/, into `dir`/out: never through a symbolic link, and never onto one.
/// Each directory on the way is opened without following links (a link where one is is refused),
/// and each file is written new and renamed into place (what was at its name, a link included,
/// is replaced, not written through). `dir`/out itself must not be a link. How many were written;
/// what couldn't be is said on stderr and in the log.
pub fn write_out(dir: &Path, files: &[(String, Vec<u8>)]) -> usize {
    use std::ffi::OsStr;
    use std::io::Write;
    use std::os::fd::AsFd;
    if files.is_empty() {
        return 0;
    }
    let refuse = |what: String| {
        eprintln!("snowglobe: out/: {what}");
        log::event("out_refused", json!({ "what": what }));
    };
    let out = match crate::sys::open_dir_at(None, dir.as_os_str(), false)
        .and_then(|d| crate::sys::open_dir_at(Some(d.as_fd()), OsStr::new("out"), true))
    {
        Ok(d) => d,
        Err(e) => {
            refuse(format!("{}/out: {e} (a link is not followed)", dir.display()));
            return 0;
        },
    };
    let mut n = 0;
    for (rel, data) in files {
        let parts: Vec<&str> = rel.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
        let Some((name, dirs)) = parts.split_last() else { continue };
        if parts.contains(&"..") {
            continue;
        }
        let mut at = None;
        let mut failed = None;
        for d in dirs {
            let parent = at.as_ref().unwrap_or(&out);
            match crate::sys::open_dir_at(Some(parent.as_fd()), OsStr::new(d), true) {
                Ok(fd) => at = Some(fd),
                Err(e) => {
                    failed = Some(e);
                    break;
                },
            }
        }
        if let Some(e) = failed {
            refuse(format!("{rel}: {e} (a link is not followed)"));
            continue;
        }
        let d = at.as_ref().unwrap_or(&out);
        let tmp = format!(".sg-out-{}", token());
        let written = crate::sys::create_new_at(d.as_fd(), OsStr::new(&tmp), 0o644)
            .and_then(|mut f| f.write_all(data))
            .and_then(|_| crate::sys::rename_at(d.as_fd(), OsStr::new(&tmp), OsStr::new(name)));
        match written {
            Ok(()) => n += 1,
            Err(e) => {
                crate::sys::unlink_at(d.as_fd(), OsStr::new(&tmp));
                refuse(format!("{rel}: {e}"));
            },
        }
    }
    n
}

/// A directory's files, relative to it (directories walked; symlinks and the like skipped), no
/// more than `max` bytes of them.
pub(crate) fn files(root: &Path, max: u64) -> Result<Vec<File>, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut out = Vec::new();
    let mut total = 0u64;
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
                let meta = e.metadata().map_err(|e| format!("{}: {e}", path.display()))?;
                total += meta.len();
                if total > max {
                    return Err(format!("{}: more than its copy limit ({} MB) to copy in", root.display(), max >> 20));
                }
                let mode = meta.permissions().mode() & 0o777;
                // Not through a link that took the file's place since it was listed
                let mut f = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                let mut data = Vec::with_capacity(meta.len() as usize);
                std::io::Read::read_to_end(&mut std::io::Read::take(&mut f, max - (total - meta.len())), &mut data)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                out.push((rel, data, mode));
            }
        }
    }
    Ok(out)
}

/// A job as JSON on the control socket: {"files": {path: base64}, "cmd", "env": {..}, "timeout",
/// and its limits (limits.rs)} in, {"status", "output": base64, "out": {path: base64}, ...} back.
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
        limits: Limits::from_json(v)?,
        workdir: match &v["workdir"] {
            serde_json::Value::Null => None,
            w => {
                let w = w.as_str().ok_or("workdir: a string")?;
                check_workdir(w)?;
                Some(w.to_string())
            },
        },
        labels: v["labels"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
            .collect(),
        ..Request::default()
    })
}

/// A job's labels, for its log events
pub(crate) fn labels_json(labels: &[(String, String)]) -> serde_json::Value {
    labels.iter().map(|(k, v)| (k.clone(), serde_json::Value::from(v.as_str()))).collect::<serde_json::Map<_, _>>().into()
}

/// The result fields every answer has besides its output and files: a serving process's header,
/// a control socket's answer, a one-shot job's status file.
pub fn result_fields(d: &Done) -> serde_json::Map<String, serde_json::Value> {
    let v = json!({
        // Out of memory however it ended: 137, as a guest OOM kill is
        "status": d.status.or(d.oom.then_some(137)),
        "timed_out": d.timed_out,
        "cancelled": d.cancelled,
        "killed": d.killed,
        "oom": d.oom,
        "output_truncated": d.output_truncated,
        "disk_full": d.disk_full,
        "cpu_time_exceeded": d.cpu_time_exceeded,
        "out_truncated": d.out_truncated,
        "ms": d.ms,
    });
    match v {
        serde_json::Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// A result read back from its fields (`result_fields`): what a `--server` client is answered.
pub fn done_from_fields(v: &serde_json::Value) -> Done {
    let flag = |k: &str| v[k].as_bool().unwrap_or(false);
    Done {
        status: v["status"].as_i64().map(|s| s.clamp(i32::MIN as i64, i32::MAX as i64) as i32),
        timed_out: flag("timed_out"),
        cancelled: flag("cancelled"),
        killed: flag("killed"),
        oom: flag("oom"),
        output_truncated: flag("output_truncated"),
        disk_full: flag("disk_full"),
        cpu_time_exceeded: flag("cpu_time_exceeded"),
        out_truncated: flag("out_truncated"),
        ms: v["ms"].as_u64().unwrap_or(0),
        ..Done::default()
    }
}

pub fn to_json(d: &Done) -> serde_json::Value {
    let out: serde_json::Map<String, serde_json::Value> =
        d.out.iter().map(|(k, v)| (k.clone(), serde_json::Value::from(crate::b64::encode(v)))).collect();
    let mut m = result_fields(d);
    m.insert("output".into(), crate::b64::encode(&d.output).into());
    m.insert("out".into(), out.into());
    serde_json::Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_carries_status_and_kill() {
        let printed = "sh /sgjob/ab/.sg/job.sh\r\n\r\nSGDONE_ab_n0_143_1\r\n# ";
        assert_eq!(parse_marker(printed, "ab", "n0"), Some(Marker { status: 143, killed: true, oom: false }));
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0\n", "ab", "n0"), Some(Marker { status: 0, killed: false, oom: false }));
        // The guest killed it for its memory limit
        assert_eq!(parse_marker("\nSGDONE_ab_n0_137_0_1\n", "ab", "n0"), Some(Marker { status: 137, killed: false, oom: true }));
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0_0\n", "ab", "n0"), Some(Marker { status: 0, killed: false, oom: false }));
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0_2\n", "ab", "n0"), None);
        assert_eq!(parse_marker("\nSGDONE_ab_n0_0_0_0_0\n", "ab", "n0"), None);
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
        assert_eq!(parse_marker("\nSGDONE_ab_0_0\nSGDONE_ab_n0_7_0\n", "ab", "n0"), Some(Marker { status: 7, killed: false, oom: false }));
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
    fn a_request_names_its_workdir_and_labels() {
        let r = from_json(&json!({"cmd": "true", "workdir": "/workspace", "labels": {"exclave.team": "t1", "n": 1}})).unwrap();
        assert_eq!(r.workdir.as_deref(), Some("/workspace"));
        assert_eq!(r.labels, [("exclave.team".to_string(), "t1".to_string())]);
        assert!(!r.instance && !r.cancel.load(Ordering::SeqCst));
        assert!(from_json(&json!({"cmd": "true"})).unwrap().workdir.is_none());
        assert_eq!(from_json(&json!({"cmd": "true", "workdir": 1})).err().unwrap(), "workdir: a string");
        assert_eq!(from_json(&json!({"cmd": "true", "workdir": "rel"})).err().unwrap(), "workdir rel: an absolute path");
        for ok in ["/workspace", "/home/app/", "/a b"] {
            assert!(check_workdir(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/", "//", "/a/./b", "/a/..", "/proc", "/sys/fs", "/dev/x", "/sgjob", "/a\nb"] {
            assert!(check_workdir(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_workdir_job_runs_and_copies_in_there() {
        let (launcher, cmd) = scripts_limited("id", "/sgjob/id", &[], "make", false, &Limits::default(), Some("/workspace")).unwrap();
        assert!(cmd.contains("cd '/workspace' || exit 1\n"), "{cmd}");
        assert!(cmd.contains("export EXCLAVE_WORKSPACE='/workspace'\n"), "{cmd}");
        assert!(launcher.contains("wd='/workspace'\n"), "{launcher}");
        assert!(launcher.contains("cp -a files/. \"$wd\"/"), "{launcher}");
        assert!(launcher.contains("sg_fail workdir"), "{launcher}");
        // The launcher's own files stay in the job's directory
        assert!(launcher.contains("cd '/sgjob/id' || exit 1"));
        let e = parse_fail("\nSGFAIL_id_n0_workdir\n", "id", "n0").unwrap();
        assert!(e.contains("workdir"), "{e}");
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
        assert!(launcher.contains("SGDONE_%s_%s_%s_%s_%s\\n' id \"$n\" \"$s\" \"$k\" \"$o\""));
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
        // Whatever the umask made them
        for f in ["d/e/f", "d/out/kept"] {
            std::fs::set_permissions(ws.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        std::os::unix::fs::symlink("/etc/passwd", ws.join("link")).unwrap();
        let mut got = files(&ws, 1 << 20).unwrap();
        got.sort();
        let names: Vec<(&str, u32)> = got.iter().map(|(n, _, m)| (n.as_str(), *m)).collect();
        assert_eq!(names, [("a", 0o755), ("d/e/f", 0o644), ("d/out/kept", 0o644)]);
        assert_eq!(got[1].1, b"f");
        assert!(files(&ws.join("missing"), 1 << 20).is_err());
        // No more than the copy limit
        let e = files(&ws, 2).err().unwrap();
        assert!(e.contains("more than its copy limit"), "{e}");
    }

    #[test]
    fn out_is_written_without_following_or_writing_through_links() {
        let d = crate::testing::tmp("job-out-links");
        let outside = crate::testing::tmp("job-out-outside");
        std::fs::write(outside.join("secret"), b"keep").unwrap();
        let ws = d.join("ws");
        std::fs::create_dir_all(ws.join("out")).unwrap();
        // A file at a result's name that is a link to a file outside: replaced, not written through
        std::os::unix::fs::symlink(outside.join("secret"), ws.join("out/r")).unwrap();
        // A directory on a result's way that is a link outside: refused
        std::os::unix::fs::symlink(&outside, ws.join("out/sub")).unwrap();
        let files = vec![("r".to_string(), b"result".to_vec()), ("sub/x".to_string(), b"x".to_vec()), ("a/b/c".to_string(), b"c".to_vec())];
        assert_eq!(write_out(&ws, &files), 2);
        assert_eq!(std::fs::read(outside.join("secret")).unwrap(), b"keep");
        assert!(!outside.join("x").exists());
        assert!(!std::fs::symlink_metadata(ws.join("out/r")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(ws.join("out/r")).unwrap(), b"result");
        assert_eq!(std::fs::read(ws.join("out/a/b/c")).unwrap(), b"c");
        // No temporary file left behind
        let left: Vec<_> = std::fs::read_dir(ws.join("out")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.iter().all(|n| !n.to_string_lossy().starts_with(".sg-out-")), "{left:?}");

        // out/ itself a link: nothing is written
        let ws2 = d.join("ws2");
        std::fs::create_dir_all(&ws2).unwrap();
        std::os::unix::fs::symlink(&outside, ws2.join("out")).unwrap();
        assert_eq!(write_out(&ws2, &[("y".to_string(), b"y".to_vec())]), 0);
        assert!(!outside.join("y").exists());
    }

    #[test]
    fn a_workspace_copy_skips_links_and_stops_at_its_limit() {
        let ws = crate::testing::tmp("job-files-limit");
        crate::testing::write(&ws, &[("a", &[1u8; 600]), ("b", &[2u8; 600])]);
        assert_eq!(files(&ws, 1200).unwrap().len(), 2);
        assert!(files(&ws, 1199).is_err());
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
            Request { files, command: "make".into(), env: vec![("K".into(), "v".into())], timeout, ..Request::default() }
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
        fn a_job_out_of_time_is_killed_and_keeps_what_it_had() {
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
            // What it had printed and written to out/ comes back all the same
            assert_eq!(done.out, [("r".to_string(), b"x".to_vec())]);
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

        fn limited(limits: Limits, timeout: Duration) -> Request {
            Request { limits, ..request(vec![], timeout) }
        }

        /// Wait for the host to type ctrl-c (`typed` keeps what came in)
        fn ctrl_c_typed(board: &armless::Board, typed: &mut String) {
            let begun = Instant::now();
            while !typed.contains('\x03') {
                typed.push_str(&testing::typed(board));
                assert!(begun.elapsed() < Duration::from_secs(10), "no ctrl-c: {typed:?}");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        #[test]
        fn a_job_past_its_output_limit_is_killed_and_its_output_cut_there() {
            let (board, _runner) = testing::machine("job-output-limit");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let mut typed = String::new();
                    let (id, nonce) = start_launcher(&board, &activity, &mut typed);
                    // Its output has a limit of its own, a byte past the job's: a write that starts
                    // within it is taken whole, any after it dropped
                    board.fs_write_file(&format!("/sgjob/{id}/.sg/output"), &[b'x'; 1000], 0o644).unwrap();
                    board.with_fs(|fs| {
                        let ino = fs.lookup_path(&format!("/sgjob/{id}/.sg/output")).unwrap();
                        assert_eq!(fs.write(ino, 1000, b"more", 0), Ok(4), "past its allowance: dropped");
                        assert_eq!(fs.get(ino).unwrap().size, 1000);
                    });
                    // The host sees it is past the limit and has the launcher kill it
                    ctrl_c_typed(&board, &mut typed);
                    marker(&activity, &id, &nonce, 130, true);
                })
            };
            let done = run(&board, &activity, &limited(Limits { output: Some(100), ..Limits::default() }, Duration::from_secs(30))).unwrap();
            guest.join().unwrap();
            assert_eq!(done.output, [b'x'; 100]);
            assert!(done.output_truncated && done.killed && !done.timed_out);
            assert_eq!(done.status, None);
            assert_eq!(crate::limits::exit_code(&done), 153);
        }

        #[test]
        fn a_job_that_ends_within_its_output_limit_keeps_all_of_it() {
            let (board, _runner) = testing::machine("job-output-under");
            let activity = Activity::new(false);
            let guest = play(board.clone(), activity.clone(), Duration::ZERO, &[(".sg/output", b"short")], 0, false);
            let done = run(&board, &activity, &limited(Limits { output: Some(100), ..Limits::default() }, Duration::from_secs(30))).unwrap();
            guest.join().unwrap();
            assert_eq!((done.status, done.output.as_slice(), done.output_truncated), (Some(0), &b"short"[..], false));
        }

        #[test]
        fn a_job_past_its_disk_limit_gets_enospc_and_says_so() {
            let (board, _runner) = testing::machine("job-disk-limit");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let (id, nonce) = start_launcher(&board, &activity, &mut String::new());
                    // The guest's writes count against the job's budget (1 MB)
                    let e = board.fs_write_file(&format!("/sgjob/{id}/big"), &vec![0u8; 2 << 20], 0o644).err().unwrap();
                    assert!(e.contains("errno 28"), "{e}");
                    board.fs_write_file(&format!("/sgjob/{id}/out/r"), b"small", 0o644).unwrap();
                    marker(&activity, &id, &nonce, 1, false);
                })
            };
            let done = run(&board, &activity, &limited(Limits { disk_mb: Some(1), ..Limits::default() }, Duration::from_secs(30))).unwrap();
            guest.join().unwrap();
            assert_eq!(done.status, Some(1));
            assert!(done.disk_full);
            assert_eq!(done.out, [("r".to_string(), b"small".to_vec())]);
            // Lifted once the job is done
            assert_eq!(board.fs_write_budget(), None);
        }

        #[test]
        fn a_limit_the_guest_says_it_cant_enforce_fails_the_job() {
            let (board, _runner) = testing::machine("job-cant-limit");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let (id, nonce) = start_launcher(&board, &activity, &mut String::new());
                    activity.observe(&Event::Serial(format!("\r\nSGFAIL_{id}_{nonce}_memory\r\n# ").into_bytes()));
                })
            };
            let e = run(&board, &activity, &limited(Limits { memory_mb: Some(64), ..Limits::default() }, Duration::from_secs(30))).err().unwrap();
            guest.join().unwrap();
            assert!(e.contains("memory_limit_mb") && e.contains("cgroup"), "{e}");
            // Without the nonce, it is the job's own printing: not believed
            assert_eq!(parse_fail("\nSGFAIL_ab_0_memory\n", "ab", "n0"), None);
        }

        #[test]
        fn a_job_whose_process_goes_past_its_memory_ends_at_once() {
            let (board, _runner) = testing::machine("job-rss");
            let activity = Activity::new(false);
            // This test process has more than 1 MB resident: the job ends before the guest answers
            let done = run(&board, &activity, &limited(Limits { max_rss_mb: Some(1), ..Limits::default() }, Duration::from_secs(30))).unwrap();
            assert!(done.oom && done.killed && !done.timed_out);
            assert_eq!(done.status, None);
            assert_eq!(crate::limits::exit_code(&done), 137);
        }

        #[test]
        fn a_job_with_a_workdir_has_its_files_copied_there_and_only_its_own_out_back() {
            let (board, _runner) = testing::machine("job-workdir");
            let activity = Activity::new(false);
            // What a build left in the workdir, out/ included: not this job's result
            board.fs_write_file("/workspace/out/old", b"build's", 0o644).unwrap();
            board.fs_write_file("/workspace/out/changed", b"build's", 0o644).unwrap();
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let (id, nonce) = start_launcher(&board, &activity, &mut String::new());
                    let given = board.fs_read_tree(&format!("/sgjob/{id}/files")).unwrap().unwrap();
                    // The launcher copies them over, and the job writes its results
                    board.fs_write_file("/workspace/in/a", b"in", 0o644).unwrap();
                    board.fs_write_file("/workspace/out/new", b"mine", 0o644).unwrap();
                    board.fs_write_file("/workspace/out/changed", b"mine too", 0o644).unwrap();
                    marker(&activity, &id, &nonce, 0, false);
                    given
                })
            };
            let r = Request {
                workdir: Some("/workspace".into()),
                labels: vec![("exclave.team".into(), "t1".into())],
                ..request(vec![("in/a".into(), b"in".to_vec(), 0o644), ("out/x".into(), b"no".to_vec(), 0o644)], Duration::from_secs(30))
            };
            let done = run(&board, &activity, &r).unwrap();
            let given = guest.join().unwrap();
            assert_eq!(given, [("in/a".to_string(), b"in".to_vec())], "into the job's own directory, never out/");
            let mut out = done.out.clone();
            out.sort();
            assert_eq!(out, [("changed".to_string(), b"mine too".to_vec()), ("new".to_string(), b"mine".to_vec())]);
            assert_eq!(done.status, Some(0));
        }

        #[test]
        fn a_bad_workdir_fails_the_job_before_it_starts() {
            let (board, _runner) = testing::machine("job-bad-workdir");
            for w in ["workspace", "/", "/a/../b", "/proc/x", "/sgjob/x"] {
                let r = Request { workdir: Some(w.into()), ..request(vec![], Duration::from_secs(1)) };
                let e = run(&board, &Activity::new(false), &r).err().unwrap();
                assert!(e.starts_with(&format!("workdir {w}: ")), "{e}");
            }
            assert!(board.fs_read_tree("/sgjob").unwrap().is_none());
        }

        #[test]
        fn a_job_whose_client_goes_is_killed_and_says_it_was_cancelled() {
            let (board, _runner) = testing::machine("job-cancel");
            let activity = Activity::new(false);
            let r = request(vec![], Duration::from_secs(30));
            let cancel = r.cancel.clone();
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let mut typed = String::new();
                    let (id, nonce) = start_launcher(&board, &activity, &mut typed);
                    board.fs_write_file(&format!("/sgjob/{id}/.sg/output"), b"so far", 0o644).unwrap();
                    cancel.store(true, Ordering::SeqCst);
                    ctrl_c_typed(&board, &mut typed);
                    marker(&activity, &id, &nonce, 130, true);
                })
            };
            let begun = Instant::now();
            let done = run(&board, &activity, &r).unwrap();
            guest.join().unwrap();
            assert!(begun.elapsed() < Duration::from_secs(10));
            assert!(done.cancelled && done.killed && !done.timed_out);
            assert_eq!((done.status, done.output.as_slice()), (None, &b"so far"[..]));
        }

        #[test]
        fn a_machines_job_past_its_memory_is_killed_and_the_machine_goes_on() {
            let (board, _runner) = testing::machine("job-instance-rss");
            let activity = Activity::new(false);
            let guest = {
                let (board, activity) = (board.clone(), activity.clone());
                std::thread::spawn(move || {
                    let mut typed = String::new();
                    let (id, nonce) = start_launcher(&board, &activity, &mut typed);
                    // This test process has more than 1 MB resident: the host has the job killed
                    ctrl_c_typed(&board, &mut typed);
                    marker(&activity, &id, &nonce, 137, true);
                })
            };
            let r = Request { instance: true, ..limited(Limits { max_rss_mb: Some(1), ..Limits::default() }, Duration::from_secs(30)) };
            let done = run(&board, &activity, &r).unwrap();
            guest.join().unwrap();
            assert!(done.oom && done.killed && !done.timed_out && !done.cpu_time_exceeded);
            assert_eq!(done.status, None);
            // Answered as the contract has it: out of memory is 137
            assert_eq!(to_json(&done)["status"], 137);
            assert!(!activity.shell_busy.load(Ordering::SeqCst), "the shell is free for the next job");
        }

        #[test]
        fn a_job_with_more_files_than_its_copy_limit_doesnt_start() {
            let (board, _runner) = testing::machine("job-copy-limit");
            let r = Request { limits: Limits { copy_mb: 1, ..Limits::default() }, ..request(vec![("in/a".into(), vec![0u8; 2 << 20], 0o644)], Duration::from_secs(1)) };
            let e = run(&board, &Activity::new(false), &r).err().unwrap();
            assert!(e.contains("copy limit"), "{e}");
            assert!(board.fs_read_tree("/sgjob").unwrap().is_none());
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
            let w = Workspace { dir: dir.clone(), command: "true".into(), env: vec![], timeout: Duration::from_secs(30), limits: Limits::default() };
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
            id: String,
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
                Run::start_with(name, "t", env, command, path, home, &Limits::default())
            }

            /// With `limits` the guest enforces, and an id of its own (its cgroup is named after it)
            fn limited(name: &str, command: &str, limits: &Limits) -> Run {
                Run::start_with(name, name, &[], command, None, false, limits)
            }

            fn start_with(name: &str, id: &str, env: &[(String, String)], command: &str, path: Option<&Path>, home: bool, limits: &Limits) -> Run {
                Run::start_full(name, id, env, command, path, home, limits, None, &[])
            }

            #[allow(clippy::too_many_arguments)]
            fn start_full(
                name: &str,
                id: &str,
                env: &[(String, String)],
                command: &str,
                path: Option<&Path>,
                home: bool,
                limits: &Limits,
                workdir: Option<&Path>,
                files: &[(&str, &str)],
            ) -> Run {
                let ws = std::env::temp_dir().join(format!("sgjob-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&ws);
                // As `run` makes them, from the host: with a workdir, its files go in files/
                let dirs: &[&str] = if workdir.is_some() { &[".sg", "files"] } else { &[".sg", "in", "out"] };
                for d in dirs {
                    std::fs::create_dir_all(ws.join(d)).unwrap();
                }
                for (rel, data) in files {
                    let f = ws.join("files").join(rel);
                    std::fs::create_dir_all(f.parent().unwrap()).unwrap();
                    std::fs::write(f, data).unwrap();
                }
                let wd = workdir.map(|w| w.to_str().unwrap().to_string());
                let (launcher, cmd) = scripts_limited(id, ws.to_str().unwrap(), env, command, home, limits, wd.as_deref()).unwrap();
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
                let mut run = Run { ws, id: id.to_string(), child, master, printed };
                // It asks for its nonce, as the host types it
                let begun = Instant::now();
                while !String::from_utf8_lossy(&run.printed.lock().unwrap()).contains(&format!("SGNONCE_{id}")) {
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
            fn finish(self) -> (Option<(i32, bool)>, PathBuf) {
                let (marker, ws, _) = self.finish_all();
                (marker.map(|m| (m.status, m.killed)), ws)
            }

            /// The whole marker, and what the launcher printed
            fn finish_all(mut self) -> (Option<Marker>, PathBuf, String) {
                let begun = Instant::now();
                while self.child.try_wait().unwrap().is_none() {
                    assert!(begun.elapsed() < Duration::from_secs(15), "the launcher didn't end");
                    std::thread::sleep(Duration::from_millis(20));
                }
                std::thread::sleep(Duration::from_millis(100));
                let printed = String::from_utf8_lossy(&self.printed.lock().unwrap()).into_owned();
                (parse_marker(&printed, &self.id, NONCE), self.ws, printed)
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
        fn a_job_with_a_workdir_runs_there_with_its_files_copied_in() {
            let wd = std::env::temp_dir().join(format!("sgjob-workdir-wd-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&wd);
            // What a build left there: kept, and seen by the job
            std::fs::create_dir_all(wd.join("node_modules/dep")).unwrap();
            std::fs::write(wd.join("node_modules/dep/index.js"), "built").unwrap();
            let run = Run::start_full(
                "workdir",
                "t",
                &[],
                "pwd; echo \"$EXCLAVE_WORKSPACE\"; cat assigns.json in/a.txt node_modules/dep/index.js; echo made > out/r",
                None,
                false,
                &Limits::default(),
                Some(&wd),
                &[("assigns.json", "{}"), ("in/a.txt", "input")],
            );
            let (marker, ws) = run.finish();
            assert_eq!(marker, Some((0, false)));
            let output = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert_eq!(output, format!("{0}\n{0}\n{{}}inputbuilt", wd.display()), "{output}");
            assert_eq!(std::fs::read_to_string(wd.join("out/r")).unwrap(), "made\n");
            // Copied, then dropped
            assert!(!ws.join("files").exists());
            let _ = std::fs::remove_dir_all(&wd);
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

        /// The guest's limits need root (a cgroup of the job's own, a mount), as the guest's
        /// serial shell has: these run as root only (`sudo -E cargo test`, a VM, a privileged
        /// container). The guest's shell is in the root cgroup, which may hold processes and
        /// still hand controllers down; any other cgroup can't (in a container whose cgroup
        /// namespace is its own, move its processes to a leaf first, as Docker-in-Docker does)
        /// Held for the test: one at a time, as a guest runs one job at a time (the launcher reuses
        /// the shared cgroup, `SHARED_CGROUP`, while it is empty)
        fn root() -> Option<std::sync::MutexGuard<'static, ()>> {
            static ONE: Mutex<()> = Mutex::new(());
            // Root in a container that isn't privileged has /sys/fs/cgroup mounted read-only
            let root = crate::sys::euid() == 0
                && Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
                && crate::sys::writable(c"/sys/fs/cgroup/cgroup.subtree_control");
            if !root {
                eprintln!("skipped: needs root and a writable cgroup v2");
                return None;
            }
            Some(ONE.lock().unwrap_or_else(|e| e.into_inner()))
        }

        #[test]
        fn the_command_runs_in_a_cgroup_of_its_own_with_its_limits() {
            let Some(_one) = root() else { return };
            let limits = Limits { memory_mb: Some(64), cpus: Some(0.5), pids: Some(40), ..Limits::default() };
            let run = Run::limited(
                "cglimits",
                "cg=/sys/fs/cgroup$(grep '^0::' /proc/self/cgroup | cut -d: -f3); cat $cg/memory.max $cg/cpu.max $cg/pids.max; cat $cg/memory.swap.max 2>/dev/null",
                &limits,
            );
            let (marker, ws, _) = run.finish_all();
            assert_eq!(marker, Some(Marker { status: 0, killed: false, oom: false }));
            let output = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            let lines: Vec<&str> = output.lines().collect();
            assert_eq!(&lines[..3], [&(64u64 << 20).to_string(), "50000 100000", "40"], "{output}");
            if let Some(swap) = lines.get(3) {
                assert_eq!(*swap, "0");
            }
            // Its cgroup is gone once it has ended
            assert!(!Path::new("/sys/fs/cgroup/sgjob-cglimits").exists());
        }

        /// As the boot layer's init makes it: the shared cgroup is used (and kept) while it is
        /// empty, its limits set anew each time; something left running in it gets the next
        /// job a cgroup of its own, removed after
        #[test]
        fn the_shared_cgroup_is_reused_while_empty() {
            let Some(_one) = root() else { return };
            let shared = Path::new("/sys/fs/cgroup").join(SHARED_CGROUP);
            let _ = std::fs::create_dir(&shared);
            let show = "cat /proc/self/cgroup; cat /sys/fs/cgroup/sgjob/memory.max /sys/fs/cgroup/sgjob/pids.max";
            let run = Run::limited("cgshared1", show, &Limits { memory_mb: Some(64), pids: Some(40), ..Limits::default() });
            let (marker, ws, _) = run.finish_all();
            assert_eq!(marker.map(|m| m.status), Some(0));
            let out = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert!(out.starts_with("0::/sgjob\n"), "{out}");
            assert!(out.contains(&(64u64 << 20).to_string()) && out.contains("\n40\n"), "{out}");
            assert!(shared.exists(), "kept for the next job");
            // The next job's limits only: what the last set and this one doesn't is lifted
            let run = Run::limited("cgshared2", show, &Limits { pids: Some(9), ..Limits::default() });
            let (_, ws, _) = run.finish_all();
            let out = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert!(out.contains("0::/sgjob\nmax\n9\n"), "{out}");
            // The launcher went back where it was: nothing is left in the cgroup
            assert_eq!(std::fs::read_to_string(shared.join("cgroup.procs")).unwrap(), "");
            // What a limited job leaves running ends with it: the cgroup is empty for the next
            let run = Run::limited("cgshared3", "sleep 3171 >/dev/null 2>&1 &", &Limits { pids: Some(9), ..Limits::default() });
            run.finish_all();
            assert!(sleeping(&["3171"]).is_empty(), "left running");
            assert_eq!(std::fs::read_to_string(shared.join("cgroup.procs")).unwrap(), "");
            // Something running there all the same (not a job's): the next job gets one of its own
            let mut squatter = Command::new("sleep").arg("3172").spawn().unwrap();
            std::fs::write(shared.join("cgroup.procs"), squatter.id().to_string()).unwrap();
            let run = Run::limited("cgshared4", "cat /proc/self/cgroup", &Limits { pids: Some(9), ..Limits::default() });
            let (_, ws, _) = run.finish_all();
            let _ = squatter.kill();
            let _ = squatter.wait();
            let out = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert!(out.starts_with("0::/sgjob-cgshared4\n"), "{out}");
            assert!(!Path::new("/sys/fs/cgroup/sgjob-cgshared4").exists());
            let _ = std::fs::write(shared.join("cgroup.kill"), "1");
            std::thread::sleep(Duration::from_millis(200));
            let _ = std::fs::remove_dir(&shared);
        }

        #[test]
        fn a_command_past_its_memory_limit_is_killed_with_137() {
            let Some(_one) = root() else { return };
            let limits = Limits { memory_mb: Some(32), ..Limits::default() };
            // A shell variable of 128 MB
            let run = Run::limited("cgoom", "x=$(head -c 134217728 /dev/zero | tr '\\0' a); echo ${#x}", &limits);
            let (marker, _, _) = run.finish_all();
            assert_eq!(marker, Some(Marker { status: 137, killed: false, oom: true }));
        }

        #[test]
        fn a_command_past_its_pids_limit_cant_start_more() {
            let Some(_one) = root() else { return };
            let limits = Limits { pids: Some(4), ..Limits::default() };
            let run = Run::limited("cgpids", "for i in 1 2 3 4 5 6 7 8; do sleep 2 & done 2>/dev/null; echo started", &limits);
            let (marker, ws, _) = run.finish_all();
            let m = marker.expect("no marker");
            assert!(!m.oom);
            let output = std::fs::read_to_string(ws.join(".sg/output")).unwrap();
            assert!(m.status != 0 || !output.contains("started"), "{m:?}: {output}");
        }

        #[test]
        fn in_is_read_only_when_asked() {
            let Some(_one) = root() else { return };
            let limits = Limits { read_only_in: true, ..Limits::default() };
            let run = Run::limited("roin", "touch in/x 2>/dev/null && echo wrote; echo made > out/r; ls in", &limits);
            let (marker, ws, _) = run.finish_all();
            assert_eq!(marker.map(|m| m.status), Some(0));
            assert!(!std::fs::read_to_string(ws.join(".sg/output")).unwrap().contains("wrote"));
            assert_eq!(std::fs::read_to_string(ws.join("out/r")).unwrap(), "made\n");
            assert!(!ws.join("in/x").exists());
            // Unmounted after: the host's directory is writable as it was
            std::fs::write(ws.join("in/after"), b"x").unwrap();
        }

        #[test]
        fn a_limit_the_guest_cant_enforce_starts_nothing() {
            // A cgroup hierarchy that isn't there (or a controller it doesn't have): the launcher
            // says which, and the command never runs. Not root: the mount fails as it would
            if crate::sys::euid() == 0 {
                return;
            }
            let limits = Limits { memory_mb: Some(64), ..Limits::default() };
            let run = Run::limited("cgfail", "echo ran > out/r", &limits);
            let (marker, ws, printed) = run.finish_all();
            assert_eq!(marker, None);
            let e = parse_fail(&printed, "cgfail", NONCE).expect("no failure line");
            assert!(e.contains("memory_limit_mb") || e.contains("cgroup v2"), "{e}");
            assert!(!ws.join("out/r").exists(), "the command ran");
        }
    }
}
