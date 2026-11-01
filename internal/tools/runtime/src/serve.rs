//! Jobs from one restore (`--serve SOCKET --jobs-root DIR`): the snapshot is restored once, into
//! a process that never starts a thread, and every job is a fork of it. A child shares the
//! restored machine's memory copy-on-write, so a job starts in milliseconds and costs only the
//! pages it changes; it starts its own CPUs and JIT, gets fresh randomness (`Board::seed`, so no
//! two jobs draw the same numbers), runs the job (`job::run`), answers and exits. Nothing a job
//! does reaches the parent or another job.
//!
//! Measured on Linux: the parent holds ~92 MB; a running job ~13 MB of its own (the rest is the
//! parent's, shared); an empty job answers in ~0.1 s, ten at once in ~0.3 s.
//!
//! The parent takes the part of the sandbox its children inherit (no_new_privs, Landlock: the
//! site, the jobs root, the profile cache) and that still lets it fork; each child adds the rest
//! (seccomp, or Seatbelt) before it starts a thread. Guest code only ever runs in children.
//!
//! The protocol, on the Unix socket: one JSON line, `{"workspace", "cmd", "env": {...},
//! "env_file", "timeout"}` (paths under the jobs root), answered by one JSON line, `{"status": N
//! or null (out of time), "out": files}`, then what the command printed. `--server SOCKET` with
//! the job's flags is the client: it behaves like a one-shot job (output, exit status, out/).

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use armless::runner::Runner;
use serde_json::{json, Value};

use crate::machine::{self, Activity};
use crate::site::Site;
use crate::{job, profile, sandbox, Args};

pub fn main(args: &Args, site: Site, socket: &str) -> Result<u8, String> {
    let (info, spec, title) = crate::run::site_spec(&site)?;
    let root = PathBuf::from(args.get("jobs-root").ok_or("--serve needs --jobs-root DIR (where job workspaces live)")?);
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let max: usize = match args.get("max-jobs") {
        Some(n) => n.parse().map_err(|_| "--max-jobs: a number")?,
        None => std::thread::available_parallelism().map_or(2, |n| n.get() * 2),
    };
    let policy = sandbox::Policy {
        read: [site.read_paths(), vec![root.clone()]].concat(),
        write: [profile::cache_path(&site).and_then(|p| sandbox::parent_of(&p)).into_iter().collect(), vec![root.clone()]]
            .concat(),
        socket_dir: sandbox::parent_of(Path::new(socket)),
        bind: Vec::new(),
        network: spec.network == "fetch",
    };
    let sandboxed = sandbox::apply_stage(&policy, sandbox::Stage::Parent)?;
    if std::env::var_os("ARMLESS_JIT_CODE_MB").is_none() {
        std::env::set_var("ARMLESS_JIT_CODE_MB", "64");
    }
    let net = machine::Net::from_args(args, Some(&info["tunnels"]))?;

    // The one restore. No thread may exist when this process forks: the JIT is off until a child
    // turns it on, and the CPUs and host loop start in children
    let started = std::time::Instant::now();
    let (vm, clock) = machine::new_vm_jit(&spec, &site, false)?;
    let board = vm.board.clone();
    let mut runner = Runner::new(vm, clock, false);
    let state = site.need("system/state.bin.zst")?;
    let mut reader = armless::zstd::reader(&state[..]).map_err(|e| e.to_string())?;
    runner.load_state_from(&mut reader)?;
    drop(reader);

    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket).map_err(|e| format!("{socket}: {e}"))?;
    eprintln!(
        "{title}: restored in {:.1}s, serving jobs on {socket} (workspaces under {}, {max} at once; {sandboxed})",
        started.elapsed().as_secs_f64(),
        root.display()
    );
    let mut running = 0usize;
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        // Reap finished jobs; at the limit, wait for one
        loop {
            let mut status = 0;
            // SAFETY: waitpid on our own children
            let pid = unsafe { libc::waitpid(-1, &mut status, if running >= max { 0 } else { libc::WNOHANG }) };
            if pid <= 0 {
                break;
            }
            running = running.saturating_sub(1);
        }
        // SAFETY: this process has no other threads (see above), so the child has a consistent
        // copy of it; the child never returns into this loop
        match unsafe { libc::fork() } {
            0 => {
                drop(listener);
                let code = match child(&board, &mut runner, &site, &policy, &root, &spec, net, conn) {
                    Ok(()) => 0,
                    Err(e) => {
                        eprintln!("snowglobe: job: {e}");
                        1
                    },
                };
                // SAFETY: leave without running destructors (the CPUs are running)
                unsafe { libc::_exit(code) };
            },
            -1 => eprintln!("snowglobe: fork: {}", std::io::Error::last_os_error()),
            _ => running += 1,
        }
    }
    Ok(0)
}

#[allow(clippy::too_many_arguments)]
fn child(
    board: &Arc<armless::Board>,
    runner: &mut Runner,
    site: &Site,
    policy: &sandbox::Policy,
    root: &Path,
    spec: &machine::Spec,
    net: machine::Net,
    conn: UnixStream,
) -> Result<(), String> {
    let mut reader = BufReader::new(conn.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let req: Value = serde_json::from_str(&line).map_err(|e| format!("request: {e}"))?;
    let under_root = |key: &str| -> Result<Option<PathBuf>, String> {
        let Some(p) = req[key].as_str() else { return Ok(None) };
        let p = Path::new(p).canonicalize().map_err(|e| format!("{key} {p}: {e}"))?;
        if !p.starts_with(root) {
            return Err(format!("{key} {} is not under the jobs root {}", p.display(), root.display()));
        }
        Ok(Some(p))
    };
    let workspace = under_root("workspace")?.ok_or("request: no workspace")?;
    let mut env: Vec<(String, String)> = req["env"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
        .collect();
    if let Some(f) = under_root("env_file")? {
        let v: Value = serde_json::from_slice(&std::fs::read(&f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        env.extend(v.as_object().into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))));
    }
    let job = job::Job {
        workspace,
        command: req["cmd"].as_str().ok_or("request: no cmd")?.to_string(),
        env,
        timeout: Duration::from_secs_f64(req["timeout"].as_f64().unwrap_or(300.0)),
    };

    // The rest of the sandbox, before any thread
    sandbox::apply_stage(policy, sandbox::Stage::Child)?;
    // This copy of the machine gets randomness of its own
    board.seed(&armless::runner::os_entropy());
    machine::enable_jit(runner, spec.cpus);
    // No prewarm here unless asked (ARMLESS_JIT_PREWARM=on): each child would compile the whole
    // profile for itself, ~48 MB private and no faster for the jobs measured; what a job runs hot
    // compiles as it runs
    let learned = std::env::var("ARMLESS_JIT_PREWARM").is_ok_and(|v| v == "on").then(|| {
        let l = profile::Learned::open(site);
        runner.jit_prewarm(&l.prewarm());
        l
    });
    let activity = Activity::new(false);
    let _host = machine::host(board, site, &spec.network, net, &activity);
    runner.start();

    let done = job::run(board, &activity, &job)?;
    let mut w = conn;
    let header = json!({ "status": done.status, "out": done.out });
    w.write_all(format!("{header}\n").as_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&done.output).map_err(|e| e.to_string())?;
    let _ = w.flush();
    if let Some(l) = learned {
        l.learn(runner);
    }
    Ok(())
}

/// `--server SOCKET --workspace DIR --cmd COMMAND [--env K=V] [--env-file F] [--timeout S]`: a job
/// on a serving process, answered as a one-shot job is (output, exit status, out/ in DIR).
pub fn client(args: &Args, socket: &str) -> Result<u8, String> {
    let abs = |p: &str| -> Result<String, String> {
        Ok(Path::new(p).canonicalize().map_err(|e| format!("{p}: {e}"))?.to_string_lossy().into_owned())
    };
    let workspace = abs(args.get("workspace").ok_or("--server needs --workspace DIR")?)?;
    let env: serde_json::Map<String, Value> = args
        .all("env")
        .iter()
        .map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), Value::from(v))))
        .collect::<Option<_>>()
        .ok_or("--env takes NAME=VALUE")?;
    let timeout: f64 = args.get("timeout").map_or(Ok(300.0), str::parse).map_err(|_| "--timeout: seconds")?;
    let req = json!({
        "workspace": workspace,
        "cmd": args.get("cmd").ok_or("--server needs --cmd COMMAND")?,
        "env": env,
        "env_file": args.get("env-file").map(abs).transpose()?,
        "timeout": timeout,
    });
    let mut conn = UnixStream::connect(socket).map_err(|e| format!("{socket}: {e}"))?;
    conn.write_all(format!("{req}\n").as_bytes()).map_err(|e| e.to_string())?;
    conn.set_read_timeout(Some(Duration::from_secs_f64(timeout + 30.0))).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(conn);
    let mut header = String::new();
    reader.read_line(&mut header).map_err(|e| format!("{socket}: {e}"))?;
    let header: Value = serde_json::from_str(&header).map_err(|_| format!("{socket}: the job ended without an answer"))?;
    let mut output = Vec::new();
    let _ = reader.read_to_end(&mut output);
    let mut out = std::io::stdout();
    let _ = out.write_all(&output);
    let _ = out.flush();
    Ok(match header["status"].as_i64() {
        Some(s) => s.clamp(0, 255) as u8,
        None => {
            eprintln!("snowglobe: the job ran out of time ({timeout}s)");
            124
        },
    })
}
