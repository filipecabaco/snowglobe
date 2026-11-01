//! A run as a job (`--workspace DIR --cmd COMMAND`): the shape of a sandboxed job runner's run
//! (Exclave's, say) on a site whose app is a shell.
//!
//! The workspace directory's files are written into the guest from the host (no console, no
//! quoting), the command runs there with its input closed, and the run ends with the command:
//! what it printed (stdout and stderr) on stdout, the guest's `out/` written back into the
//! workspace, and its exit status as this process's (124 if it ran out of time).
//!
//! In the guest the workspace is /sgjob/<id>, a directory its kernel has never seen (it caches
//! what it has, so new files appear only in a new directory), and `EXCLAVE_WORKSPACE` names it.
//! The command runs from a script written there: only `sh <script>` is typed into the console.
//! The script runs the command, syncs what it wrote to the filesystem, then prints a marker with
//! its status, which the echo of the typed line can't contain.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::machine::Activity;

pub struct Job {
    pub workspace: PathBuf,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

pub struct Done {
    pub output: Vec<u8>,
    /// None: it ran out of time
    pub status: Option<i32>,
    /// Files written to out/
    pub out: usize,
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The workspace's files, relative to it (directories walked; symlinks and the like skipped).
fn files(root: &Path) -> Result<Vec<(String, Vec<u8>, u32)>, String> {
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
                let mode = e.metadata().map(|m| m.permissions().mode() & 0o777).unwrap_or(0o644);
                out.push((rel, std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?, mode));
            }
        }
    }
    Ok(out)
}

pub fn run(board: &armless::Board, activity: &Arc<Activity>, job: &Job) -> Result<Done, String> {
    let id = format!("{:016x}", u64::from_le_bytes(armless::runner::os_entropy()[..8].try_into().unwrap()));
    let ws = format!("/sgjob/{id}");
    for (rel, data, mode) in files(&job.workspace)? {
        if rel.starts_with(".sg/") || rel.starts_with("out/") {
            continue;
        }
        board.fs_write_file(&format!("{ws}/{rel}"), &data, mode)?;
    }
    let mut script = format!("cd {} || exit 1\nmkdir -p in out\n", quote(&ws));
    script += &format!("export EXCLAVE_WORKSPACE={}\n", quote(&ws));
    for (k, v) in &job.env {
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("--env {k}: not a variable name"));
        }
        script += &format!("export {k}={}\n", quote(v));
    }
    script += &format!(
        "( {} ) </dev/null >.sg/output 2>&1\ns=$?\nsync\nprintf '\\nSGDONE_%s_%s\\n' {id} \"$s\"\n",
        job.command
    );
    board.fs_write_file(&format!("{ws}/.sg/job.sh"), script.as_bytes(), 0o755)?;

    let marker = format!("SGDONE_{id}_");
    let from = activity.screen.lock().unwrap().total();
    board.console_input(format!("sh {ws}/.sg/job.sh\r").as_bytes());
    activity.touch();
    let deadline = Instant::now() + job.timeout;
    let mut status = None;
    {
        let mut screen = activity.screen.lock().unwrap();
        loop {
            let printed = String::from_utf8_lossy(screen.since(from)).into_owned();
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
    let mut out = 0;
    if status.is_some() {
        for (rel, data) in board.fs_read_tree(&format!("{ws}/out"))?.unwrap_or_default() {
            let dest = job.workspace.join("out").join(&rel);
            if rel.split('/').any(|c| c == "..") {
                continue;
            }
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&dest, data).map_err(|e| format!("{}: {e}", dest.display()))?;
            out += 1;
        }
    }
    Ok(Done { output, status, out })
}
