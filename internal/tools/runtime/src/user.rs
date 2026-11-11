//! Sites with no kernel (`snowglobe build --kernel none`): the app is the image's own program, run
//! on armless with no guest kernel (armless user mode, `armless_user`), from the site's filesystem:
//! a static or dynamically linked program, with the image's environment and working directory, on
//! a terminal. The build runs it to its ready text and saves the machine (state.bin.zst, as any
//! site: its RAM and filesystem) and the process (system/user.bin); a run restores both.
//!
//! The program's terminal is the run's console: a terminal `snowglobe run` or an `attach` types
//! into it and sees it. A job (`snowglobe sh`, exec) types its command and a newline, and is done
//! when the program has printed and waits for input again: a REPL's answer, up to its next prompt.
//! `snapshot --user PROGRAM --user ARG ... [--user-env NAME=VALUE ...] [--user-cwd DIR]` builds
//! one; a site with system/user.bin runs this way.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use armless_user::{ExecError, Process, Status};
use serde_json::json;

use crate::machine::{self, Activity, Spec};
use crate::site::Site;
use crate::{driver, image, term, Args};

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
/// a guest), run it until it printed `ready` (or, without one, printed something and went quiet),
/// then save the machine and the process.
pub fn snapshot(args: &Args, system: &Path, spec: &Spec, ready: Option<&str>, argv: &[String]) -> Result<u8, String> {
    let site = Site::system(system);
    let spec = Spec { cpus: 1, ..spec.clone() };
    let (mut vm, _clock) = machine::new_vm(&spec, &site)?;
    let activity = Activity::new(false);
    let _host = machine::host(&vm.board, &site, &spec.network, machine::Net::from_args(args, None)?, &activity);
    let mut env: Vec<String> = args.all("user-env");
    if env.is_empty() {
        env = DEFAULT_ENV.iter().map(|s| s.to_string()).collect();
    }
    if !env.iter().any(|e| e.starts_with("TERM=")) {
        env.push("TERM=xterm-256color".into());
    }
    let cwd = args.get("user-cwd").filter(|c| !c.is_empty()).unwrap_or("/").to_string();
    eprintln!("Starting {} in user mode (no kernel) ...", argv.join(" "));
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
    let mut quiet_since = Instant::now();
    loop {
        let status = p.run(&mut vm.cpus[0], Duration::from_millis(20));
        let out = p.take_output();
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
                let most = Duration::from_millis(if p.waiting_on_blobs() { 1 } else { 20 });
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
        if let Status::Exited(_) | Status::Fault(_) = p.run(&mut vm.cpus[0], Duration::from_millis(20)) {
            break;
        }
        console.extend(p.take_output());
    }
    let boot_seconds = started.elapsed().as_secs_f64();
    eprintln!("\nApp ready after {boot_seconds:.2}s (user mode)");
    let process = p.save(&vm.cpus[0]);
    std::fs::write(system.join("user.bin"), &process).map_err(|e| format!("user.bin: {e}"))?;
    let state = vm.save_state();
    crate::snapshot::save(system, &state, boot_seconds, &console)?;
    crate::snapshot::write_json(&system.join("reads.json"), &json!({ "boot": [], "exercise": {} }))?;
    crate::snapshot::write_json(&system.join("transcript.json"), &json!([]))?;
    std::fs::write(system.join("jit-profile.bin"), armless::jit::profile::write(&[])).map_err(|e| format!("jit-profile.bin: {e}"))?;
    Ok(0)
}

/// What the program's thread and the console's clients share.
#[derive(Default)]
struct Shared {
    io: Mutex<Io>,
    changed: Condvar,
}

/// A place the program's output goes as it comes: false when it is gone
type Watcher = Box<dyn FnMut(&[u8]) -> bool + Send>;

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
}

/// `run` in user mode, once `run` has confined the process and set up its driver: restore the
/// machine (on the snapshot's RAM image, shared with every machine restored from it, as for any
/// site) and the process, serve the site's blobs, and connect the program's terminal to the
/// console's clients.
pub fn run(args: &Args, site: &Site, spec: &Spec, title: &str, image: Option<image::Image>, socket: &str, started: Instant) -> Result<u8, String> {
    let spec = Spec { cpus: 1, ..spec.clone() };
    let (ram, without_pages) = image.map(|i| (i.ram, i.state)).unzip();
    let (mut vm, _clock) = machine::new_vm_on(&spec, site, true, ram)?;
    match without_pages {
        Some(state) => vm.load_state(&state)?,
        None => {
            let state = site.need("system/state.bin.zst")?;
            let raw = zstd::stream::decode_all(&state[..]).map_err(|e| e.to_string())?;
            vm.load_state(&raw)?;
        },
    }
    let activity = Activity::new(false);
    let info = crate::run::site_spec(site)?.0;
    let _host = machine::host(&vm.board, site, &spec.network, machine::Net::from_args(args, Some(&info["tunnels"]))?, &activity);
    let mut p = Process::restore(&mut vm.cpus[0], Some(vm.board.clone()), &site.need("system/user.bin")?)?;
    // SNOWGLOBE_USER_TRACE=1: every syscall of the program, on stderr (a run that isn't detached)
    p.trace = std::env::var_os("SNOWGLOBE_USER_TRACE").is_some();
    if std::env::var_os("SNOWGLOBE_TIMING").is_some() {
        eprintln!("timing: restored in {:.0} ms (user mode)", started.elapsed().as_secs_f64() * 1e3);
    }

    let shared = Arc::new(Shared::default());
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket).map_err(|e| format!("{socket}: {e}"))?;
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let shared = shared.clone();
                std::thread::spawn(move || serve(&shared, stream));
            }
        });
    }
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
    }

    // The program, on this thread: input in, output out, until it ends
    let ended = loop {
        {
            let mut io = shared.io.lock().unwrap();
            if let Some((cols, rows)) = io.resize.take() {
                p.resize(cols, rows);
            }
            let pending: Vec<u8> = io.input.drain(..).collect();
            drop(io);
            if !pending.is_empty() {
                p.input(&pending);
            }
        }
        let status = p.run(&mut vm.cpus[0], Duration::from_millis(10));
        let out = p.take_output();
        let mut io = shared.io.lock().unwrap();
        if !out.is_empty() {
            io.output.extend_from_slice(&out);
            io.last_output = Some(Instant::now());
            io.waiting = false;
            io.watchers.retain_mut(|w| w(&out));
            shared.changed.notify_all();
        }
        match status {
            Status::Exited(c) => break format!("exited ({c})"),
            Status::Fault(f) => break f,
            Status::Idle(wake) => {
                // Waiting for input: not busy reading files whose contents are still on their way,
                // nor asleep in the middle of a command (time.sleep)
                if !io.waiting && p.waiting_for_input() {
                    io.waiting = true;
                    shared.changed.notify_all();
                }
                // Until a deadline, or input. A file's contents on their way (a page touched for the
                // first time, as the first command after a restore does many times) come from the
                // site's directory in about a millisecond: look again that soon, not in 50
                let most = Duration::from_millis(if p.waiting_on_blobs() { 1 } else { 50 });
                let wait = wake.map_or(most, |w| w.saturating_duration_since(Instant::now())).min(most);
                if io.input.is_empty() && io.resize.is_none() {
                    let _ = shared.changed.wait_timeout(io, wait);
                }
            },
            Status::Running => {},
        }
    };
    term::restore();
    eprintln!("snowglobe: the program stopped: {ended}");
    shared.io.lock().unwrap().ended = Some(ended);
    shared.changed.notify_all();
    Ok(driver::end("guest-stopped", 0))
}

/// One console client: a job or exec types its command and a newline, and is answered with what
/// the program printed until it waits for input again; an attach streams the terminal both ways.
fn serve(shared: &Arc<Shared>, stream: UnixStream) {
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
    let command = match mode {
        "job" => request["cmd"].as_str(),
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
    let printed = output.clone().unwrap_or_default();
    if mode == "exec" {
        let _ = writer.write_all(&crate::text::plain(&printed));
        return;
    }
    let answer = json!({
        "status": output.as_ref().map(|_| 0),
        "output": crate::b64::encode(&crate::text::plain(&printed)),
        "out": {},
        "timed_out": output.is_none(),
        "cancelled": false,
        "killed": false,
        "ms": begun.elapsed().as_millis() as u64,
    });
    let _ = writer.write_all(format!("{answer}\n").as_bytes());
}
