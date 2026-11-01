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
//! only in a new directory), and `EXCLAVE_WORKSPACE` names it. The command runs from a script
//! written there: only `sh <script>` is typed. The script runs the command with its input closed,
//! syncs what it wrote, then prints a marker with its status, which the echo of the typed line
//! can't contain. One job at a time per machine.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::machine::Activity;

/// A file for a job: its path in the workspace, contents and mode.
pub type File = (String, Vec<u8>, u32);

pub struct Request {
    pub files: Vec<File>,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

pub struct Done {
    pub output: Vec<u8>,
    /// None: it ran out of time
    pub status: Option<i32>,
    /// What it wrote to out/, by path under it
    pub out: Vec<(String, Vec<u8>)>,
}

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn run(board: &armless::Board, activity: &Arc<Activity>, req: &Request) -> Result<Done, String> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let id = format!("{:016x}", u64::from_le_bytes(armless::runner::os_entropy()[..8].try_into().unwrap()));
    let ws = format!("/sgjob/{id}");
    for (rel, data, mode) in &req.files {
        if rel.starts_with(".sg/") || rel.starts_with("out/") || rel.split('/').any(|c| c == "..") {
            continue;
        }
        board.fs_write_file(&format!("{ws}/{rel}"), data, *mode)?;
    }
    // The app's environment: a login PATH, /etc/profile, the image's ENV
    let mut script = String::from(
        "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root\n\
         [ -f /etc/profile ] && . /etc/profile >/dev/null 2>&1\n\
         [ -f /usr/local/bin/snowglobe-console ] && eval \"$(grep '^export ' /usr/local/bin/snowglobe-console)\"\n",
    );
    script += &format!("cd {} || exit 1\nmkdir -p in out\n", quote(&ws));
    script += &format!("export EXCLAVE_WORKSPACE={}\n", quote(&ws));
    for (k, v) in &req.env {
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("{k}: not a variable name"));
        }
        script += &format!("export {k}={}\n", quote(v));
    }
    script += &format!(
        "( {} ) </dev/null >.sg/output 2>&1\ns=$?\nsync\nprintf '\\nSGDONE_%s_%s\\n' {id} \"$s\"\n",
        req.command
    );
    board.fs_write_file(&format!("{ws}/.sg/job.sh"), script.as_bytes(), 0o755)?;

    let marker = format!("SGDONE_{id}_");
    let from = activity.serial_total();
    board.serial_input(format!("sh {ws}/.sg/job.sh\n").as_bytes());
    activity.touch();
    let deadline = Instant::now() + req.timeout;
    let mut status = None;
    {
        let mut screen = activity.screen.lock().unwrap();
        loop {
            let printed = String::from_utf8_lossy(&activity.serial_since(from)).into_owned();
            if let Some(at) = printed.find(&marker) {
                let rest = &printed[at + marker.len()..];
                if let Some(end) = rest.find(['\r', '\n']) {
                    status = rest[..end].trim().parse().ok();
                    break;
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            screen = activity.screen_cv.wait_timeout(screen, left.min(Duration::from_millis(200))).unwrap().0;
        }
    }
    let output = board
        .fs_read_tree(&format!("{ws}/.sg"))?
        .and_then(|f| f.into_iter().find(|(n, _)| n == "output").map(|(_, d)| d))
        .unwrap_or_default();
    let out = if status.is_some() {
        board
            .fs_read_tree(&format!("{ws}/out"))?
            .unwrap_or_default()
            .into_iter()
            .filter(|(rel, _)| !rel.split('/').any(|c| c == ".."))
            .collect()
    } else {
        Vec::new()
    };
    Ok(Done { output, status, out })
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
    serde_json::json!({ "status": d.status, "output": crate::b64::encode(&d.output), "out": out })
}
