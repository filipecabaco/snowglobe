//! Sites with no kernel (`snowglobe build --kernel none`): the app is the image's own program, run
//! on armless with no guest kernel (armless user mode, `armless_user`), from the site's filesystem:
//! a static or dynamically linked program, with the image's environment and working directory, on
//! a terminal. The build runs it to its ready text, its threads on every CPU it builds on at once
//! (armless's `Smp`), and saves the machine (state.bin.zst, as any site: its RAM and filesystem)
//! with the CPUs the site has, and the process (system/user.bin); a run restores both, on the
//! site's CPUs.
//!
//! The program's terminal is the run's console: a terminal `snowglobe run` or an `attach` types
//! into it and sees it. A job (`snowglobe sh`, exec) types its command and a newline, and is done
//! when the program has printed and waits for input again: a REPL's answer, up to its next prompt.
//! `snapshot --user PROGRAM --user ARG ... [--user-env NAME=VALUE ...] [--user-cwd DIR]` builds
//! one; a site with system/user.bin runs this way.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use armless::platform::NativePlatform;
use armless::vm::Vm;
use armless_user::{ExecError, Process, Smp, Status};
use serde_json::json;

use crate::machine::{self, Activity, Spec};
use crate::site::Site;
use crate::{driver, image, job, term, Args};

const BUILD_TIMEOUT: Duration = Duration::from_secs(300);
/// The environment when the image gives none
const DEFAULT_ENV: [&str; 3] = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=xterm-256color"];
/// A job is done when the program has printed and then waited for input this long
const QUIET: Duration = Duration::from_millis(150);
const DETACH_KEY: u8 = 0x1d; // ctrl-]

/// Whether a site runs in user mode.
pub fn is_user(site: &Site) -> bool {
    site.need("system/user.bin").is_ok()
}

/// `snapshot` in user mode: start the program from the site's filesystem (its blobs served as for
/// a guest), run it on the build's CPUs (`spec.cpus`) until it printed `ready` (or, without one,
/// printed something and went quiet), then save the machine, with the site's CPUs (--cpus), and
/// the process.
pub fn snapshot(args: &Args, system: &Path, spec: &Spec, ready: Option<&str>, argv: &[String]) -> Result<u8, String> {
    let site = Site::system(system);
    let ship: usize = args.get("cpus").unwrap_or("1").parse().map_err(|_| "--cpus: not a number")?;
    let (mut vm, _clock) = machine::new_vm(spec, &site)?;
    let activity = Activity::new(false);
    let _host = machine::host(&vm.board, &site, &spec.network, machine::Net::from_args(args, None)?, &activity);
    // What it reads as it starts: what its restored process has open, wanted first in the page
    *activity.reads.lock().unwrap() = Some(machine::Reads::new());
    let mut env: Vec<String> = args.all("user-env");
    if env.is_empty() {
        env = DEFAULT_ENV.iter().map(|s| s.to_string()).collect();
    }
    if !env.iter().any(|e| e.starts_with("TERM=")) {
        env.push("TERM=xterm-256color".into());
    }
    let cwd = args.get("user-cwd").filter(|c| !c.is_empty()).unwrap_or("/").to_string();
    eprintln!("Starting {} in user mode (no kernel) on {} CPU(s) ...", argv.join(" "), spec.cpus);
    let started = Instant::now();
    // Its executable and loader may wait on blobs, which the host fetches meanwhile
    let mut p = loop {
        match Process::exec(&mut vm.cpus[0], vm.board.clone(), argv, &env, &cwd) {
            Ok(p) => break p,
            Err(ExecError::Need(_)) if started.elapsed() < BUILD_TIMEOUT => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(format!("{}: {e}", argv[0])),
        }
    };
    let (cols, rows) = (args.get("cols").and_then(|c| c.parse().ok()).unwrap_or(80), args.get("rows").and_then(|r| r.parse().ok()).unwrap_or(24));
    p.resize(cols, rows);
    let mut console = Vec::new();
    // CPU 0 on this thread, the others on threads of their own, until it's ready; then they put
    // their threads back in the process for the snapshot
    let smp = Smp::new(&mut p);
    let (first, others) = vm.cpus.split_at_mut(1);
    let workers = others.len();
    let cpu = &mut first[0];
    std::thread::scope(|s| -> Result<(), String> {
        for (i, c) in others.iter_mut().enumerate() {
            let smp = &smp;
            s.spawn(move || smp.serve(i + 1, c));
        }
        let up = run_until_ready(&smp, cpu, ready, argv, started, &mut console);
        smp.pause(workers);
        smp.stop();
        up
    })?;
    drop(smp);
    let boot_seconds = started.elapsed().as_secs_f64();
    eprintln!("\nApp ready after {boot_seconds:.2}s (user mode)");
    let process = p.save(&vm.cpus[0]);
    std::fs::write(system.join("user.bin"), &process).map_err(|e| format!("user.bin: {e}"))?;
    // The site's CPUs only: the others ran threads that are back in the process, and are off
    let machine = vm.cpus[0].machine.clone();
    for c in ship..spec.cpus {
        machine.power_off(c);
    }
    let state = vm.save_state_cpus(ship.min(spec.cpus))?;
    crate::snapshot::save(system, &state, boot_seconds, &console)?;
    let boot_reads = activity.reads.lock().unwrap().take().unwrap_or_default().into_vec();
    // The exercises, typed in after the snapshot (on CPU 0: what they read is what a visitor's
    // commands would fetch)
    let mut transcript = Vec::new();
    let mut exercise_reads = Vec::new();
    let exercises = args.all("exercise");
    if !exercises.is_empty() {
        let smp = Smp::new(&mut p);
        for command in &exercises {
            let (output, reads) = exercise(&smp, &mut vm.cpus[0], &activity, &mut console, command);
            transcript.push(json!({ "command": command, "output": String::from_utf8_lossy(&output) }));
            exercise_reads.push((command.clone(), reads));
        }
        eprintln!();
    }
    // Booting's reads are the restore's: the process holds open what it opened as it started
    crate::snapshot::write_json(&system.join("reads.json"), &crate::snapshot::reads_json(Vec::new(), boot_reads, &exercise_reads))?;
    crate::snapshot::write_json(&system.join("transcript.json"), &json!(transcript))?;
    std::fs::write(system.join("jit-profile.bin"), armless::jit::profile::write(&[])).map_err(|e| format!("jit-profile.bin: {e}"))?;
    Ok(0)
}

/// One exercise command typed into the program (on CPU 0), run until it is done as a kernel's
/// is (snapshot::exercised: quiet, or back at its prompt): what it printed, and the files it
/// fetched.
fn exercise<H: armless::Host>(smp: &Smp, cpu: &mut armless::cpu::Cpu<H>, activity: &Arc<Activity>, console: &mut Vec<u8>, command: &str) -> (Vec<u8>, Vec<String>) {
    *activity.reads.lock().unwrap() = Some(machine::Reads::new());
    let prompt = crate::snapshot::prompt(console);
    let from = console.len();
    let begun = Instant::now();
    eprint!("\nExercising: {command}");
    smp.lock().input(format!("{command}\r").as_bytes());
    activity.touch();
    loop {
        let status = smp.run(0, cpu, Duration::from_millis(20));
        let out = smp.lock().take_output();
        if !out.is_empty() {
            console.extend_from_slice(&out);
            activity.touch();
        }
        match status {
            Status::Running => activity.touch(),
            Status::Exited(_) | Status::Fault(_) => break,
            Status::Idle(wake) => {
                let most = Duration::from_millis(if smp.lock().waiting_on_blobs() { 1 } else { 20 });
                if smp.lock().waiting_on_blobs() {
                    activity.touch();
                }
                let wait = wake.map_or(most, |w| w.saturating_duration_since(Instant::now()));
                std::thread::sleep(wait.min(most));
            },
        }
        if crate::snapshot::exercised(&console[from..], prompt.as_deref(), activity.idle_for()) || begun.elapsed() >= crate::snapshot::EXERCISE_CAP {
            break;
        }
    }
    let reads = activity.reads.lock().unwrap().take().unwrap_or_default().into_vec();
    eprint!(" ({} files, {:.1}s)", reads.len(), begun.elapsed().as_secs_f64());
    (console[from..].to_vec(), reads)
}

/// Runs the program (CPU 0 here, the others `serve`d) until it printed `ready` (or, without one,
/// printed something and went quiet), and a little longer, its output on stderr and in `console`.
fn run_until_ready<H: armless::Host>(smp: &Smp, cpu: &mut armless::cpu::Cpu<H>, ready: Option<&str>, argv: &[String], started: Instant, console: &mut Vec<u8>) -> Result<(), String> {
    let mut quiet_since = Instant::now();
    loop {
        let status = smp.run(0, cpu, Duration::from_millis(20));
        let out = smp.lock().take_output();
        if !out.is_empty() {
            let _ = std::io::stderr().write_all(&out);
            console.extend_from_slice(&out);
            quiet_since = Instant::now();
        }
        let up = match ready {
            Some(t) => console.windows(t.len()).any(|w| w == t.as_bytes()),
            None => !console.is_empty() && quiet_since.elapsed() > Duration::from_secs(2),
        };
        if up {
            break;
        }
        match status {
            Status::Exited(c) => return Err(format!("{} exited ({c}) before it was ready", argv[0])),
            Status::Fault(f) => return Err(format!("{}: {f}", argv[0])),
            Status::Idle(wake) => {
                // A file's contents on their way come soon (see run)
                let most = Duration::from_millis(if smp.lock().waiting_on_blobs() { 1 } else { 20 });
                let wait = wake.map_or(most, |w| w.saturating_duration_since(Instant::now()));
                std::thread::sleep(wait.min(most));
            },
            Status::Running => {},
        }
        if started.elapsed() > BUILD_TIMEOUT {
            return Err(format!("app not ready after {}s", BUILD_TIMEOUT.as_secs()));
        }
    }
    // A little longer, so that what it prints right after its ready text is in the screen too
    let settle = Instant::now();
    while settle.elapsed() < Duration::from_millis(300) {
        if let Status::Exited(_) | Status::Fault(_) = smp.run(0, cpu, Duration::from_millis(20)) {
            break;
        }
        console.extend(smp.lock().take_output());
    }
    Ok(())
}

/// What the program's thread and the console's clients share.
#[derive(Default)]
pub struct Shared {
    io: Mutex<Io>,
    changed: Condvar,
}

/// A place the program's output goes as it comes: false when it is gone
type Watcher = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// Where a save's (bytes, ms) or its error goes
type SaveReply = std::sync::mpsc::Sender<Result<(u64, u64), String>>;

#[derive(Default)]
struct Io {
    /// Keys for the terminal, and a new size for it
    input: VecDeque<u8>,
    resize: Option<(u16, u16)>,
    /// Everything the program printed since the restore
    output: Vec<u8>,
    /// When it last printed, and whether it has waited for input since
    last_output: Option<Instant>,
    waiting: bool,
    /// Where its output goes as it comes too: the terminal of a `snowglobe run`, an attach
    watchers: Vec<Watcher>,
    ended: Option<String>,
    /// Jobs asked for (`snowglobe sh`, cp, mcp's run_command), for the program's thread to start
    jobs: Vec<Asked>,
    /// A save asked for (`snapshot save`): the machine and the process, to this path
    saves: Vec<(PathBuf, SaveReply)>,
}

/// A job asked for, and where its answer goes
struct Asked {
    req: job::Request,
    answer: std::sync::mpsc::Sender<Result<job::Done, String>>,
}

/// A job running beside the program: a shell of its own (`Process::spawn`)
struct Running {
    /// Its id, for the log (as a kernel's job's)
    id: String,
    /// Stopped because the instance is stopping, not out of time
    cancelled: bool,
    pid: i64,
    ws: String,
    begun: Instant,
    deadline: Instant,
    output: Vec<u8>,
    /// When it was told to stop (out of time, or the instance stopping): TERM, then KILL
    stopping: Option<Instant>,
    answer: std::sync::mpsc::Sender<Result<job::Done, String>>,
}

/// How long a job told to stop gets before it is killed
const JOB_KILL_GRACE: Duration = Duration::from_secs(3);

/// The CPUs a site with no kernel runs on natively: --cpus, or as many as it was built on, as many
/// as the host has at most (a page has one; the snapshot is of one, the others start empty).
pub fn cpus_for(args: &Args, site: &Site, spec: &Spec) -> Result<usize, String> {
    let built = crate::run::site_spec(site)?.0["build_cpus"].as_u64().unwrap_or(1) as usize;
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    match args.get("cpus") {
        Some(n) => n.parse::<usize>().ok().filter(|n| (1..=8).contains(n)).ok_or_else(|| "--cpus: 1 to 8".to_string()),
        None => Ok(built.min(cores).max(spec.cpus)),
    }
}

/// A machine of a site with no kernel saved with `save_machine`: its state (zstd) and its
/// process, read from `path` and `path`.user. Read before a sandbox closes, when it is outside
/// what the sandbox reads (a daemon's snapshot).
pub struct Saved {
    machine: Vec<u8>,
    process: Vec<u8>,
}

impl Saved {
    pub fn read(path: &Path) -> Result<Saved, String> {
        let user = user_path(path);
        Ok(Saved {
            machine: std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
            process: std::fs::read(&user).map_err(|e| format!("{}: {e}", user.display()))?,
        })
    }
}

/// A site with no kernel restored: its machine on `spec.cpus` CPUs (from the site's snapshot, on
/// its RAM image when there is one, or from a machine `saved`) and its program's process. `jit`:
/// compile hot code now (not in a process that forks: its children turn it on).
pub fn restore(site: &Site, spec: &Spec, image: Option<image::Image>, saved: Option<Saved>, jit: bool) -> Result<(Vm<NativePlatform>, Process), String> {
    let (ram, without_pages) = image.filter(|_| saved.is_none()).map(|i| (i.ram, i.state)).unzip();
    let (mut vm, _clock) = machine::new_vm_on(spec, site, jit, ram)?;
    let process = match saved {
        Some(saved) => {
            vm.load_state(&zstd::stream::decode_all(&saved.machine[..]).map_err(|e| e.to_string())?)?;
            saved.process
        },
        None => {
            match without_pages {
                Some(state) => vm.load_state(&state)?,
                None => {
                    let state = site.need("system/state.bin.zst")?;
                    vm.load_state(&zstd::stream::decode_all(&state[..]).map_err(|e| e.to_string())?)?;
                },
            }
            site.need("system/user.bin")?.to_vec()
        },
    };
    let p = Process::restore(&mut vm.cpus[0], Some(vm.board.clone()), &process)?;
    Ok((vm, p))
}

/// Where a saved machine's process goes, beside the machine's state
fn user_path(machine: &Path) -> PathBuf {
    let mut p = machine.as_os_str().to_owned();
    p.push(".user");
    PathBuf::from(p)
}

/// The machine of a site with no kernel to `path` (zstd, as a machine with a kernel's: one CPU, the
/// program's threads all in the process) and its process to `path`.user, from which a fork
/// server starts a machine again (`spawn` with a `state`). Every CPU but the first is stopped (its
/// thread back in the process: `Smp::pause`), and powered off for the save.
fn save_machine(vm: &mut Vm<NativePlatform>, p: &mut Process, path: &Path) -> Result<(u64, u64), String> {
    let begun = Instant::now();
    let process = p.save(&vm.cpus[0]);
    let machine_ = vm.cpus[0].machine.clone();
    for c in 1..vm.cpus.len() {
        machine_.power_off(c);
    }
    let state = vm.save_state_cpus(1)?;
    let data = zstd::stream::encode_all(&state[..], 3).map_err(|e| e.to_string())?;
    // Whole or not at all: a reader never sees half of either
    let write = |to: &Path, bytes: &[u8]| -> Result<(), String> {
        let tmp = to.with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, to).map_err(|e| format!("{}: {e}", to.display()))
    };
    write(&user_path(path), &process)?;
    write(path, &data)?;
    Ok(((data.len() + process.len()) as u64, begun.elapsed().as_millis() as u64))
}

/// `run` in user mode, once `run` has confined the process and set up its driver: restore the
/// machine (on the snapshot's RAM image, shared with every machine restored from it, as for any
/// site) and the process, serve the site's blobs, and connect the program's terminal to the
/// console's clients.
/// `env_file`: --env-file's variables, read before the sandbox took the file away, for a job.
#[allow(clippy::too_many_arguments)]
pub fn run(args: &Args, site: &Site, spec: &Spec, title: &str, image: Option<image::Image>, socket: &str, started: Instant, env_file: Vec<(String, String)>) -> Result<u8, String> {
    let spec = &Spec { cpus: cpus_for(args, site, spec)?, ..spec.clone() };
    let (mut vm, mut p) = restore(site, spec, image, None, true)?;
    let activity = Activity::new(false);
    let info = crate::run::site_spec(site)?.0;
    let host = Arc::new(machine::host(&vm.board, site, &spec.network, machine::Net::from_args(args, Some(&info["tunnels"]))?, &activity));
    // -p: each connection a TCP connection from the guest's router to the guest port, as for a site
    // with a kernel
    for f in args.all("forward") {
        let (addr, listen, guest) = crate::run::forward(&f)?;
        let l = std::net::TcpListener::bind((addr.as_str(), listen)).map_err(|e| format!("{addr}:{listen}: {e}"))?;
        let host = host.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                host.forward(stream, guest);
            }
        });
    }
    crate::log::event("restored", json!({ "ms": started.elapsed().as_millis() as u64, "user_mode": true }));
    // SNOWGLOBE_USER_TRACE=1: every syscall of the program, on stderr (a run that isn't detached)
    p.trace = std::env::var_os("SNOWGLOBE_USER_TRACE").is_some();
    if std::env::var_os("SNOWGLOBE_TIMING").is_some() {
        eprintln!("timing: restored in {:.0} ms (user mode)", started.elapsed().as_secs_f64() * 1e3);
    }

    let shared = Arc::new(Shared::default());

    // A job (--workspace, a bundle as a job runner): the workspace in, the command run beside the
    // program, out/ back and its status the run's, as with a kernel
    if let Some(ws) = args.get("workspace") {
        let command = args.get("cmd").ok_or("--workspace needs --cmd COMMAND")?.to_string();
        let mut env = args
            .all("env")
            .iter()
            .map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect::<Option<Vec<_>>>()
            .ok_or("--env takes NAME=VALUE")?;
        env.extend(env_file);
        let timeout = job::timeout_flag(args.get("timeout"))?;
        let dir = PathBuf::from(ws);
        let req = job::Request { files: job::files(&dir)?, command, env, timeout, home: false };
        let rx = ask_job(&shared, req);
        std::thread::spawn(move || {
            let code = match rx.recv() {
                Ok(Ok(done)) => {
                    for (rel, data) in &done.out {
                        let dest = dir.join("out").join(rel);
                        let _ = std::fs::create_dir_all(dest.parent().unwrap_or(&dir));
                        if let Err(e) = std::fs::write(&dest, data) {
                            eprintln!("snowglobe: {}: {e}", dest.display());
                        }
                    }
                    let mut out = std::io::stdout();
                    let _ = out.write_all(&done.output);
                    let _ = out.flush();
                    if done.status.is_none() && !done.cancelled {
                        eprintln!("snowglobe: the job ran out of time ({}s)", timeout.as_secs_f64());
                    }
                    job::exit_code(done.status.map(i64::from))
                },
                Ok(Err(e)) => {
                    eprintln!("snowglobe: {e}");
                    1
                },
                Err(_) => 1,
            };
            std::process::exit(driver::end("end", code) as i32);
        });
        let ended = drive(&mut vm, &mut p, &shared);
        eprintln!("snowglobe: the program stopped before its job ended: {ended}");
        return Ok(driver::end("guest-stopped", 1));
    }

    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket).map_err(|e| format!("{socket}: {e}"))?;
    listen(shared.clone(), host.clone(), listener);
    let secs = started.elapsed().as_secs_f64();
    if args.has("detached") {
        println!("restored {title} in {secs:.1}s (user mode)");
        let _ = std::io::stdout().flush();
    } else if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        // The program's terminal is this one: keys in, screen out, its size followed
        eprint!("\x1b[2m{title}: restored in {secs:.1}s · user mode · ctrl-] quits\x1b[0m\r\n");
        term::raw();
        if let Some((cols, rows)) = term::size() {
            p.resize(cols, rows);
        }
        shared.io.lock().unwrap().watchers.push(Box::new(|b| {
            let mut out = std::io::stdout();
            out.write_all(b).and_then(|_| out.flush()).is_ok()
        }));
        let s = shared.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut last = term::size();
            loop {
                let n = std::io::stdin().read(&mut buf).unwrap_or(0);
                if n == 0 || buf[..n].contains(&DETACH_KEY) {
                    term::restore();
                    std::process::exit(driver::end("end", 0) as i32);
                }
                let size = term::size();
                let mut io = s.io.lock().unwrap();
                if size != last {
                    io.resize = size;
                    last = size;
                }
                io.input.extend(&buf[..n]);
                s.changed.notify_all();
            }
        });
    } else {
        // Piped (`printf 'cmd\n' | snowglobe run site`, as CI checks a site): each line is typed
        // as a job's is, once the answer to the one before is in, and what it printed goes to
        // stdout as with a kernel (run's command_output): the screen it drew, without the line's
        // echo and the prompt after it. The run ends after the last answer
        let s = shared.clone();
        std::thread::spawn(move || {
            // The program's prompt: the last line it drew before the first command, then the
            // last line of each answer
            let mut prompt = {
                let io = s.io.lock().unwrap();
                shown(&io.output).rsplit('\n').next().unwrap_or_default().trim().to_string()
            };
            let mut out = std::io::stdout();
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let mut io = s.io.lock().unwrap();
                let mark = io.output.len();
                io.input.extend(line.as_bytes());
                io.input.push_back(b'\n');
                io.waiting = false;
                s.changed.notify_all();
                let begun = Instant::now();
                loop {
                    let quiet = io.last_output.is_some_and(|t| t.elapsed() >= QUIET);
                    if io.output[mark..].contains(&b'\n') && io.waiting && quiet || io.ended.is_some() {
                        break;
                    }
                    if begun.elapsed() > BUILD_TIMEOUT {
                        eprintln!("snowglobe: no answer to {line:?} after {}s", BUILD_TIMEOUT.as_secs());
                        break;
                    }
                    io = s.changed.wait_timeout(io, QUIET).unwrap().0;
                }
                let printed = shown(&io.output[mark..]);
                drop(io);
                let (answer, next) = crate::run::command_output(&printed, &line, &prompt);
                if let Some(p) = next {
                    prompt = p;
                }
                let _ = out.write_all(&answer);
                let _ = out.flush();
            }
            std::process::exit(driver::end("end", 0) as i32);
        });
    }

    let ended = drive(&mut vm, &mut p, &shared);
    term::restore();
    eprintln!("snowglobe: the program stopped: {ended}");
    Ok(driver::end("guest-stopped", 0))
}

/// The control socket of a site with no kernel, on threads of its own, one per client.
pub fn listen(shared: Arc<Shared>, host: Arc<armless::native::NativeHost>, listener: UnixListener) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (shared, host) = (shared.clone(), host.clone());
            std::thread::spawn(move || serve(&shared, &host, stream));
        }
    });
}

/// The program, until it ends (what it ended with): CPU 0 on this thread, the others on threads
/// of their own; input in, output out, jobs started and answered. A save stops the other CPUs (their
/// threads back in the process), saves, and starts them again.
pub fn drive(vm: &mut Vm<NativePlatform>, p: &mut Process, shared: &Arc<Shared>) -> String {
    let board = vm.board.clone();
    let mut running: Vec<Running> = Vec::new();
    loop {
        let (ended, save) = stretch(vm, p, &board, shared, &mut running);
        if let Some(ended) = ended {
            // The jobs still running end with it
            for j in running {
                let _ = j.answer.send(Err(format!("the program stopped: {ended}")));
            }
            let mut io = shared.io.lock().unwrap();
            io.ended = Some(ended.clone());
            for (_, answer) in io.saves.drain(..) {
                let _ = answer.send(Err(format!("the program stopped: {ended}")));
            }
            shared.changed.notify_all();
            return ended;
        }
        if let Some((path, answer)) = save {
            let _ = answer.send(save_machine(vm, p, &path));
        }
    }
}

/// The program on every CPU until it ends (Some: what with) or a save is asked for (its path and
/// where the answer goes, every thread back in the process).
#[allow(clippy::type_complexity)]
fn stretch(
    vm: &mut Vm<NativePlatform>,
    p: &mut Process,
    board: &Arc<armless::Board>,
    shared: &Arc<Shared>,
    running: &mut Vec<Running>,
) -> (Option<String>, Option<(PathBuf, std::sync::mpsc::Sender<Result<(u64, u64), String>>)>) {
    let smp = Smp::new(p);
    let (first, others) = vm.cpus.split_at_mut(1);
    let workers = others.len();
    let cpu = &mut first[0];
    std::thread::scope(|scope| {
        for (i, c) in others.iter_mut().enumerate() {
            let smp = &smp;
            scope.spawn(move || smp.serve(i + 1, c));
        }
        let out = loop {
            {
                let mut io = shared.io.lock().unwrap();
                if let Some(save) = (!io.saves.is_empty()).then(|| io.saves.remove(0)) {
                    break (None, Some(save));
                }
                let resize = io.resize.take();
                let pending: Vec<u8> = io.input.drain(..).collect();
                let asked = std::mem::take(&mut io.jobs);
                drop(io);
                let mut p = smp.lock();
                if let Some((cols, rows)) = resize {
                    p.resize(cols, rows);
                }
                if !pending.is_empty() {
                    p.input(&pending);
                }
                for a in asked {
                    if job::stopping() {
                        let _ = a.answer.send(Err("the instance is stopping".into()));
                        continue;
                    }
                    match start_job(&mut p, board, &a.req) {
                        Ok(Some((pid, ws, id))) => running.push(Running {
                            id,
                            cancelled: false,
                            pid,
                            ws,
                            begun: Instant::now(),
                            deadline: Instant::now() + a.req.timeout,
                            output: Vec::new(),
                            stopping: None,
                            answer: a.answer,
                        }),
                        // Its shell's files on their way: asked again next time
                        Ok(None) => shared.io.lock().unwrap().jobs.push(a),
                        Err(e) => {
                            let _ = a.answer.send(Err(e));
                        },
                    }
                }
                running.retain_mut(|j| !follow_job(&mut p, board, j));
            }
            smp.poke();
            let status = smp.run(0, cpu, Duration::from_millis(10));
            let out = smp.lock().take_output();
            let mut io = shared.io.lock().unwrap();
            if !out.is_empty() {
                io.output.extend_from_slice(&out);
                io.last_output = Some(Instant::now());
                io.waiting = false;
                io.watchers.retain_mut(|w| w(&out));
                shared.changed.notify_all();
            }
            match status {
                Status::Exited(c) => break (Some(format!("exited ({c})")), None),
                Status::Fault(f) => break (Some(f), None),
                Status::Idle(wake) => {
                    // Waiting for input: not busy reading files whose contents are still on their
                    // way, nor asleep in the middle of a command (time.sleep)
                    let (waiting, blobs) = {
                        let p = smp.lock();
                        (p.waiting_for_input(), p.waiting_on_blobs())
                    };
                    if !io.waiting && waiting {
                        io.waiting = true;
                        shared.changed.notify_all();
                    }
                    // Until a deadline, or input. A file's contents on their way (a page touched
                    // for the first time, as the first command after a restore does many times)
                    // come from the site's directory in about a millisecond: look again that soon,
                    // not in 50; a job running is looked at every 10
                    let most = Duration::from_millis(if blobs { 1 } else if running.is_empty() { 50 } else { 10 });
                    let wait = wake.map_or(most, |w| w.saturating_duration_since(Instant::now())).min(most);
                    if io.input.is_empty() && io.resize.is_none() && io.jobs.is_empty() && io.saves.is_empty() {
                        let _ = shared.changed.wait_timeout(io, wait);
                    }
                },
                Status::Running => {},
            }
        };
        // Every thread back in the process (for a save), and the other CPUs' threads end
        smp.pause(workers);
        smp.stop();
        out
    })
}

/// A job as a process of its own beside the program (`Process::spawn`), a shell running the job's
/// script as a machine with a kernel runs it on its serial shell (`job::scripts`): its files in
/// /sgjob/<id>, the image's environment, its workspace or the home directory. Its pid and
/// workspace, or None while the shell's files are on their way.
fn start_job(p: &mut Process, board: &armless::Board, req: &job::Request) -> Result<Option<(i64, String, String)>, String> {
    let id = job::token();
    let ws = format!("/sgjob/{id}");
    let (_, cmd) = job::scripts(&id, &ws, &req.env, &req.command, req.home)?;
    for (rel, data, mode) in &req.files {
        // However it is spelled (`/out/x`, `./out/x`), nothing goes in the job's own directories
        let first = rel.split('/').find(|c| !c.is_empty() && *c != ".");
        if matches!(first, Some(".sg" | "out")) || rel.split('/').any(|c| c == "..") {
            continue;
        }
        board.fs_write_file(&format!("{ws}/{rel}"), data, *mode)?;
    }
    board.fs_mkdir(&format!("{ws}/in"))?;
    board.fs_mkdir(&format!("{ws}/out"))?;
    board.fs_write_file(&format!("{ws}/.sg/cmd"), cmd.as_bytes(), 0o755)?;
    let argv = ["/bin/sh".to_string(), format!("{ws}/.sg/cmd")];
    let env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string(), "HOME=/root".to_string()];
    match p.spawn(&argv, &env, &ws, None) {
        Ok(pid) => {
            p.spawn_close_input(pid);
            crate::log::event(
                "job_start",
                json!({
                    "job": id,
                    "cmd": req.command,
                    // Names only: values can be secrets
                    "env": req.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
                    "files": req.files.len(),
                    "timeout": req.timeout.as_secs_f64(),
                }),
            );
            job::begun_beside();
            Ok(Some((pid, ws, id)))
        },
        Err(ExecError::Need(_)) => Ok(None),
        Err(e) => Err(format!("the job's shell: {e}")),
    }
}

/// What a running job printed, its time kept, and its end: true once it has ended and been
/// answered (its out/ files taken back, as a machine with a kernel's job's are).
fn follow_job(p: &mut Process, board: &armless::Board, j: &mut Running) -> bool {
    let Some(r) = p.spawn_poll(j.pid) else {
        let _ = j.answer.send(Err("the job is gone".into()));
        return true;
    };
    j.output.extend(r.stdout);
    j.output.extend(r.stderr);
    let now = Instant::now();
    // The instance stopping (its max runtime, a stop file, snowglobe stop): the job is stopped
    // as one out of time is, and says it was cancelled
    if job::stopping() && j.stopping.is_none() && r.exit.is_none() {
        p.spawn_kill(j.pid, 15);
        j.stopping = Some(now);
        j.cancelled = true;
        return false;
    }
    match (r.exit, j.stopping) {
        (Some(status), stopping) => {
            // Stopped: what it started goes with it, even what ignores TERM (as a kernel's job
            // launcher kills its session). One that ended by itself leaves what it started running
            if stopping.is_some() {
                p.spawn_kill(j.pid, 9);
            }
            p.spawn_release(j.pid);
            let mut done = job::Done {
                output: std::mem::take(&mut j.output),
                ms: j.begun.elapsed().as_millis() as u64,
                ..Default::default()
            };
            if stopping.is_some() {
                done.timed_out = !j.cancelled;
                done.cancelled = j.cancelled;
                done.killed = true;
            } else {
                done.status = Some(status);
                done.out = board
                    .fs_read_tree(&format!("{}/out", j.ws))
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(rel, _)| !rel.split('/').any(|c| c == ".."))
                    .collect();
            }
            let shown = &done.output[..done.output.len().min(64 << 10)];
            crate::log::event(
                "job_end",
                json!({
                    "job": j.id,
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
            let _ = j.answer.send(Ok(done));
            job::ended_beside();
            true
        },
        // Out of time: what it started is told to stop, then killed
        (None, None) if now >= j.deadline => {
            p.spawn_kill(j.pid, 15);
            j.stopping = Some(now);
            false
        },
        (None, Some(at)) if now >= at + JOB_KILL_GRACE => {
            p.spawn_kill(j.pid, 9);
            false
        },
        (None, _) => false,
    }
}

/// One console client: an exec types its command and a newline, and is answered with what the
/// program printed until it waits for input again; a job runs in a shell of its own beside the
/// program (`start_job`); an attach streams the terminal both ways.
/// A job for the program's thread to run (`drive`): where its answer comes.
pub fn ask_job(shared: &Arc<Shared>, req: job::Request) -> std::sync::mpsc::Receiver<Result<job::Done, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    shared.io.lock().unwrap().jobs.push(Asked { req, answer: tx });
    shared.changed.notify_all();
    rx
}

fn serve(shared: &Arc<Shared>, host: &Arc<armless::native::NativeHost>, stream: UnixStream) {
    let Ok(mut writer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let mut header = Vec::new();
    if reader.read_until(b'\n', &mut header).is_err() {
        return;
    }
    let request: serde_json::Value = serde_json::from_slice(&header).unwrap_or(json!({}));
    let mode = request["mode"].as_str().unwrap_or("");
    if mode == "attach" {
        let mut io = shared.io.lock().unwrap();
        if let (Some(rows), Some(cols)) = (request["rows"].as_u64(), request["cols"].as_u64()) {
            io.resize = Some((cols as u16, rows as u16));
        }
        let Ok(mut w) = writer.try_clone() else { return };
        let _ = w.set_write_timeout(Some(Duration::from_secs(5)));
        io.watchers.push(Box::new(move |b| w.write_all(b).is_ok()));
        drop(io);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    shared.io.lock().unwrap().input.extend(&buf[..n]);
                    shared.changed.notify_all();
                },
            }
        }
        return;
    }
    match mode {
        // The whole machine, and the process, to a file (and its .user beside it), from which a
        // fork server starts a machine again
        "save" => {
            let answer = match request["path"].as_str() {
                Some(path) => {
                    let (tx, rx) = std::sync::mpsc::channel();
                    shared.io.lock().unwrap().saves.push((PathBuf::from(path), tx));
                    shared.changed.notify_all();
                    match rx.recv() {
                        Ok(Ok((bytes, ms))) => json!({ "saved": path, "bytes": bytes, "ms": ms }),
                        Ok(Err(e)) => json!({ "error": e }),
                        Err(_) => json!({ "error": "the program stopped" }),
                    }
                },
                None => json!({ "error": "save: a path" }),
            };
            let _ = writer.write_all(format!("{answer}\n").as_bytes());
            return;
        },
        // Where the guest's connections to other machines go (a fleet's links)
        "links" => {
            let answer = match crate::run::links(&request["links"]) {
                Ok(l) => {
                    let n = l.len();
                    host.set_links(l);
                    json!({ "links": n })
                },
                Err(e) => json!({ "error": e }),
            };
            let _ = writer.write_all(format!("{answer}\n").as_bytes());
            return;
        },
        // A connection to a guest port (a service's, a forwarded one's), as for a machine with a
        // kernel: the client waits for this answer before it sends
        "connect" => {
            let Some(port) = request["port"].as_u64().and_then(|p| u16::try_from(p).ok()).filter(|&p| p > 0) else {
                let _ = writer.write_all(format!("{}\n", json!({ "error": "connect: a port" })).as_bytes());
                return;
            };
            if !reader.buffer().is_empty() {
                let _ = writer.write_all(format!("{}\n", json!({ "error": "connect: send nothing before the answer" })).as_bytes());
                return;
            }
            if writer.write_all(format!("{}\n", json!({ "connected": port })).as_bytes()).is_err() {
                return;
            }
            host.forward(std::net::TcpStream::from(std::os::fd::OwnedFd::from(reader.into_inner())), port);
            return;
        },
        _ => {},
    }
    if mode == "job" {
        // A job: a shell of its own beside the program (`start_job`), answered as a machine with
        // a kernel answers one
        let answer = match job::from_json(&request) {
            Err(e) => json!({ "error": e }),
            Ok(req) => {
                let wait = req.timeout + JOB_KILL_GRACE + Duration::from_secs(30);
                let (tx, rx) = std::sync::mpsc::channel();
                {
                    let mut io = shared.io.lock().unwrap();
                    io.jobs.push(Asked { req, answer: tx });
                    shared.changed.notify_all();
                }
                match rx.recv_timeout(wait) {
                    Ok(Ok(done)) => job::to_json(&done),
                    Ok(Err(e)) => json!({ "error": e }),
                    Err(_) => json!({ "error": "the job did not end" }),
                }
            },
        };
        let _ = writer.write_all(format!("{answer}\n").as_bytes());
        return;
    }
    let command = match mode {
        "exec" => request["command"].as_str(),
        _ => {
            let _ = writer.write_all(format!("{}\n", json!({ "error": format!("{mode}: not in user mode") })).as_bytes());
            return;
        },
    }
    .unwrap_or("")
    .to_string();
    let timeout = Duration::from_secs_f64(request["timeout"].as_f64().unwrap_or(300.0));
    let begun = Instant::now();
    let mut io = shared.io.lock().unwrap();
    let mark = io.output.len();
    // The prompt it waits at: the last line it drew before this command (a long run's last
    // screenful is enough)
    let prompt = shown(&io.output[mark.saturating_sub(4096)..]).rsplit('\n').next().unwrap_or_default().trim().to_string();
    io.input.extend(command.as_bytes());
    io.input.push_back(b'\n');
    io.waiting = false;
    shared.changed.notify_all();
    // Done when it printed a newline (a REPL redraws the line it reads with none, then handles
    // Enter: a newline, its answer and its prompt), then waited for input for a while
    let output = loop {
        let quiet = io.last_output.is_some_and(|t| t.elapsed() >= QUIET);
        if io.output[mark..].contains(&b'\n') && io.waiting && quiet {
            break Some(io.output[mark..].to_vec());
        }
        if io.ended.is_some() || begun.elapsed() > timeout {
            break (io.output.len() > mark).then(|| io.output[mark..].to_vec());
        }
        io = shared.changed.wait_timeout(io, Duration::from_millis(50)).unwrap().0;
    };
    drop(io);
    // What the command printed, as with a kernel: without the line's echo and the prompt after it
    let (answer, _) = crate::run::command_output(&shown(&output.unwrap_or_default()), &command, &prompt);
    let _ = writer.write_all(&answer);
}

/// Program output as the screen shows it, in plain text: lines as a terminal leaves them (a REPL
/// redraws the line it reads at every key), no colours or terminal queries.
fn shown(b: &[u8]) -> String {
    String::from_utf8_lossy(&crate::text::plain(&crate::text::rendered(&crate::text::without_queries(b)))).into_owned()
}
