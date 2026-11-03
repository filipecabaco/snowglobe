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
use crate::{job, profile, sandbox, sys, Args};

pub fn main(args: &Args, site: Site, socket: &str) -> Result<u8, String> {
    let (info, spec, title) = crate::run::site_spec(&site)?;
    let root = PathBuf::from(args.get("jobs-root").ok_or("--serve needs --jobs-root DIR (where job workspaces live)")?);
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let max: usize = match args.get("max-jobs") {
        Some(n) => n.parse().map_err(|_| "--max-jobs: a number")?,
        None => std::thread::available_parallelism().map_or(2, |n| n.get() * 2),
    };
    let policy = policy(&site, &root, socket, spec.network == "fetch");
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
    let mut reader = zstd::stream::read::Decoder::with_buffer(&state[..]).map_err(|e| e.to_string())?;
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
        while sys::wait(-1, running >= max).is_some() {
            running = running.saturating_sub(1);
        }
        // This process has no other threads (see above), so the child has a consistent copy of
        // it; the child never returns into this loop
        match sys::fork() {
            Ok(sys::Forked::Child) => {
                drop(listener);
                let code = match child(&board, &mut runner, &site, &policy, &root, &spec, net, conn) {
                    Ok(()) => 0,
                    Err(e) => {
                        eprintln!("snowglobe: job: {e}");
                        1
                    },
                };
                // Leave without running destructors (the CPUs are running)
                sys::exit_now(code);
            },
            Err(e) => eprintln!("snowglobe: fork: {e}"),
            Ok(sys::Forked::Parent(_)) => running += 1,
        }
    }
    Ok(0)
}

/// What a serving process and its jobs may touch: the site and the jobs root, the JIT profile
/// cache, and the socket. No ports: a job forwards none.
fn policy(site: &Site, root: &Path, socket: &str, network: bool) -> sandbox::Policy {
    let mut write: Vec<PathBuf> = profile::cache_path(site).and_then(|p| sandbox::parent_of(&p)).into_iter().collect();
    write.push(root.to_path_buf());
    sandbox::Policy {
        read: [site.read_paths(), vec![root.to_path_buf()]].concat(),
        write,
        socket_dir: sandbox::parent_of(Path::new(socket)),
        bind: Vec::new(),
        network,
    }
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
    let line = read_request(BufReader::new(conn.try_clone().map_err(|e| e.to_string())?))?;
    let job = request(&line, root)?;

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

    let (done, out) = job::run_workspace(board, &activity, &job)?;
    let mut w = conn;
    let header = json!({ "status": done.status, "out": out, "timed_out": done.timed_out, "killed": done.killed, "ms": done.ms });
    w.write_all(format!("{header}\n").as_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&done.output).map_err(|e| e.to_string())?;
    let _ = w.flush();
    if let Some(l) = learned {
        l.learn(runner);
    }
    Ok(())
}

/// The most a request may be: paths, a command and its variables (an env file for big ones)
const MAX_REQUEST: u64 = 1 << 20;

/// A request's line, read no further than MAX_REQUEST.
fn read_request(r: impl BufRead) -> Result<String, String> {
    let mut line = String::new();
    r.take(MAX_REQUEST + 1).read_line(&mut line).map_err(|e| format!("request: {e}"))?;
    if line.len() as u64 > MAX_REQUEST {
        return Err(format!("request: longer than {MAX_REQUEST} bytes"));
    }
    Ok(line)
}

/// A job's request: its workspace (and env file) must be under the jobs root, wherever their
/// paths lead.
fn request(line: &str, root: &Path) -> Result<job::Workspace, String> {
    let req: Value = serde_json::from_str(line).map_err(|e| format!("request: {e}"))?;
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
    Ok(job::Workspace {
        dir: workspace,
        command: req["cmd"].as_str().ok_or("request: no cmd")?.to_string(),
        env,
        timeout: job::timeout(req["timeout"].as_f64())?,
    })
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
    let timeout = job::timeout_flag(args.get("timeout"))?;
    let req = json!({
        "workspace": workspace,
        "cmd": args.get("cmd").ok_or("--server needs --cmd COMMAND")?,
        "env": env,
        "env_file": args.get("env-file").map(abs).transpose()?,
        "timeout": timeout.as_secs_f64(),
    });
    let mut conn = UnixStream::connect(socket).map_err(|e| format!("{socket}: {e}"))?;
    conn.write_all(format!("{req}\n").as_bytes()).map_err(|e| e.to_string())?;
    conn.set_read_timeout(Some(timeout.saturating_add(Duration::from_secs(30)))).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(conn);
    let mut header = String::new();
    reader.read_line(&mut header).map_err(|e| format!("{socket}: {e}"))?;
    let header: Value = serde_json::from_str(&header).map_err(|_| format!("{socket}: the job ended without an answer"))?;
    let mut output = Vec::new();
    let _ = reader.read_to_end(&mut output);
    let mut out = std::io::stdout();
    let _ = out.write_all(&output);
    let _ = out.flush();
    let status = header["status"].as_i64();
    if status.is_none() {
        eprintln!("snowglobe: the job ran out of time ({}s)", timeout.as_secs_f64());
    }
    Ok(job::exit_code(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{tmp, write};

    fn args(v: &[&str]) -> Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        Args::parse(&v, crate::RUN_FLAGS).unwrap()
    }

    /// A jobs root with a workspace and an env file in it, and a directory outside it.
    fn root(name: &str) -> (PathBuf, PathBuf) {
        let d = tmp(name);
        write(&d, &[("root/ws/in", b""), ("root/env.json", br#"{"S":"secret","N":1}"#)]);
        write(&d, &[("outside/ws/in", b""), ("outside/env.json", b"{}")]);
        std::os::unix::fs::symlink(d.join("outside/ws"), d.join("root/link")).unwrap();
        (d.join("root").canonicalize().unwrap(), d.join("outside").canonicalize().unwrap())
    }

    #[test]
    fn serving_refuses_bad_arguments_before_it_restores() {
        let (dir, site) = crate::testing::site("serve-main", &[]);
        let socket = dir.join("s.sock").display().to_string();
        let err = |v: &[&str], site: &Site| main(&args(v), site.clone(), &socket).err().unwrap();
        assert!(err(&[], &site).contains("isn't a built snowglobe site"));
        write(&dir, &[("run.json", b"{}")]);
        assert!(err(&[], &site).starts_with("--serve needs --jobs-root DIR"));
        let jobs = dir.join("jobs").display().to_string();
        assert_eq!(err(&["--jobs-root", &jobs, "--max-jobs", "many"], &site), "--max-jobs: a number");
        // The jobs root is made
        assert!(dir.join("jobs").is_dir());
        assert!(err(&["--jobs-root", "/dev/null/jobs"], &site).starts_with("/dev/null/jobs: "));
    }

    #[test]
    fn jobs_may_touch_the_site_their_root_and_the_socket() {
        let (dir, site) = crate::testing::site("serve-policy", &[]);
        let p = policy(&site, &dir.join("jobs"), "/run/sg/s.sock", true);
        assert_eq!(p.read, [dir.clone(), dir.join("system"), dir.join("system/filesystem"), dir.join("jobs")]);
        assert_eq!(p.write.last(), Some(&dir.join("jobs")));
        assert_eq!(p.socket_dir, Some(PathBuf::from("/run/sg")));
        assert!(p.bind.is_empty() && p.network);
    }

    #[test]
    fn a_request_names_a_workspace_under_the_jobs_root() {
        let (root, _) = root("serve-request");
        let line = json!({
            "workspace": root.join("ws"),
            "cmd": "make",
            "env": { "A": "1", "B": 2 },
            "env_file": root.join("env.json"),
            "timeout": 5,
        })
        .to_string();
        let job = request(&line, &root).unwrap();
        assert_eq!(job.dir, root.join("ws"));
        assert_eq!(job.command, "make");
        assert_eq!(job.timeout, Duration::from_secs(5));
        // Strings only, from the request and then the file
        assert_eq!(job.env, [("A".to_string(), "1".to_string()), ("S".to_string(), "secret".to_string())]);
        let job = request(&json!({ "workspace": root.join("ws"), "cmd": "true" }).to_string(), &root).unwrap();
        assert!(job.env.is_empty());
        assert_eq!(job.timeout, Duration::from_secs(300));
    }

    #[test]
    fn a_request_cant_reach_outside_the_jobs_root() {
        let (root, outside) = root("serve-outside");
        let err = |v: Value| request(&v.to_string(), &root).err().unwrap();
        for ws in [outside.join("ws"), root.join("../outside/ws"), root.join("link")] {
            assert!(err(json!({ "workspace": ws, "cmd": "true" })).contains("is not under the jobs root"), "{}", ws.display());
        }
        let e = err(json!({ "workspace": root.join("ws"), "cmd": "true", "env_file": outside.join("env.json") }));
        assert!(e.starts_with("env_file ") && e.contains("is not under the jobs root"), "{e}");
        assert!(err(json!({ "workspace": root.join("missing"), "cmd": "true" })).starts_with("workspace "));
    }

    #[test]
    fn a_request_is_read_to_its_line_and_no_further_than_the_limit() {
        assert_eq!(read_request(&b"{\"cmd\":\"x\"}\nmore"[..]), Ok("{\"cmd\":\"x\"}\n".into()));
        let exact = vec![b'a'; MAX_REQUEST as usize];
        assert_eq!(read_request(&exact[..]).unwrap().len(), MAX_REQUEST as usize);
        // An endless line is cut off at the limit, not read into memory whole
        let endless = std::io::BufReader::new(std::io::repeat(b'a'));
        assert_eq!(read_request(endless), Err(format!("request: longer than {MAX_REQUEST} bytes")));
        assert!(read_request(&b"\xff\xfe\n"[..]).err().unwrap().starts_with("request: "));
    }

    #[test]
    fn a_bad_request_says_what_is_wrong() {
        let (root, _) = root("serve-bad");
        let err = |s: &str| request(s, &root).err().unwrap();
        assert!(err("{").starts_with("request: "));
        assert_eq!(err("{}"), "request: no workspace");
        let ws = root.join("ws");
        assert_eq!(err(&json!({ "workspace": ws }).to_string()), "request: no cmd");
        assert_eq!(err(&json!({ "workspace": ws, "cmd": "x", "timeout": -1 }).to_string()), "timeout: seconds");
        std::fs::write(root.join("bad.json"), "{").unwrap();
        assert!(request(&json!({ "workspace": ws, "cmd": "x", "env_file": root.join("bad.json") }).to_string(), &root).is_err());
    }

    /// A serving process that reads one request and answers with `answer`; what it was asked.
    fn server(name: &str, answer: &'static [u8]) -> (String, std::thread::JoinHandle<Value>) {
        let socket = tmp(name).join("s.sock");
        let l = UnixListener::bind(&socket).unwrap();
        let t = std::thread::spawn(move || {
            let (conn, _) = l.accept().unwrap();
            let mut line = String::new();
            BufReader::new(conn.try_clone().unwrap()).read_line(&mut line).unwrap();
            (&conn).write_all(answer).unwrap();
            serde_json::from_str(&line).unwrap()
        });
        (socket.display().to_string(), t)
    }

    #[test]
    fn the_client_sends_the_job_and_exits_with_its_status() {
        let ws = tmp("serve-client-ws");
        write(&ws, &[("env.json", b"{}")]);
        let (socket, t) = server("serve-client", b"{\"status\":3,\"out\":0}\n");
        let env_file = ws.join("env.json").display().to_string();
        let a = args(&["--workspace", ws.to_str().unwrap(), "--cmd", "make", "--env", "A=1=2", "--env-file", &env_file, "--timeout", "9"]);
        assert_eq!(client(&a, &socket), Ok(3));
        let req = t.join().unwrap();
        // Paths made absolute and real, for the server to check against its root
        assert_eq!(req["workspace"], ws.canonicalize().unwrap().display().to_string());
        assert_eq!(req["env_file"], ws.join("env.json").canonicalize().unwrap().display().to_string());
        assert_eq!(req["cmd"], "make");
        assert_eq!(req["env"], json!({ "A": "1=2" }));
        assert_eq!(req["timeout"], 9.0);
    }

    #[test]
    fn a_job_out_of_time_exits_124_and_one_without_an_answer_is_an_error() {
        let ws = tmp("serve-client-late");
        let a = args(&["--workspace", ws.to_str().unwrap(), "--cmd", "sleep 9"]);
        let (socket, t) = server("serve-client-late-s", b"{\"status\":null}\n");
        assert_eq!(client(&a, &socket), Ok(124));
        assert_eq!(t.join().unwrap()["timeout"], 300.0);
        let (socket, t) = server("serve-client-none", b"");
        assert_eq!(client(&a, &socket).err().unwrap(), format!("{socket}: the job ended without an answer"));
        t.join().unwrap();
    }

    #[test]
    fn the_client_checks_its_flags_before_it_connects() {
        let ws = tmp("serve-client-flags");
        let w = ws.to_str().unwrap();
        let err = |v: &[&str]| client(&args(v), "/nonexistent/s.sock").err().unwrap();
        assert_eq!(err(&["--cmd", "x"]), "--server needs --workspace DIR");
        assert_eq!(err(&["--workspace", w]), "--server needs --cmd COMMAND");
        assert_eq!(err(&["--workspace", w, "--cmd", "x", "--env", "NOVALUE"]), "--env takes NAME=VALUE");
        assert_eq!(err(&["--workspace", w, "--cmd", "x", "--timeout", "-1"]), "--timeout: seconds");
        assert!(err(&["--workspace", "/nonexistent/ws", "--cmd", "x"]).starts_with("/nonexistent/ws: "));
        assert!(err(&["--workspace", w, "--cmd", "x"]).starts_with("/nonexistent/s.sock: "));
    }
}
