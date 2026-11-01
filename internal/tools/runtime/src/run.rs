//! `snowglobe-vm run`: restore a built site headlessly and connect its app console.
//!
//! - On a terminal: raw keys in, the screen out, ctrl-] quits.
//! - Piped: each line of stdin is typed into the app in turn, waiting for it to go quiet, and
//!   what it printed is written out; the run ends after the last one.
//! - Detached: nothing local; clients join over the control socket (`exec`, `attach`).
//!
//! The control socket takes one JSON line, then: {"mode":"exec","command":...} answers with
//! what the command printed; {"mode":"attach","rows":R,"cols":C} replays the screen and
//! streams the session both ways.

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use armless::runner::Runner;
use armless::Board;
use serde_json::json;

use crate::machine::{self, Activity, Spec};
use crate::job;
use crate::driver;
use crate::log;
use crate::profile;
use crate::sandbox;
use crate::site::Site;
use crate::{term, text, Args, SOCKET};

const DETACH_KEY: u8 = 0x1d; // ctrl-]
/// A command is done once the app has neither printed, fetched a file nor had a connection
/// open for this long
const QUIET: Duration = Duration::from_millis(1200);
const COMMAND_CAP: Duration = Duration::from_secs(300);
/// Once the prompt is back, how long the app must stay quiet for the command to count as done
const PROMPT_SETTLE: Duration = Duration::from_millis(80);
/// How often a command's end is looked for, besides whenever the app prints
const POLL: Duration = Duration::from_millis(20);

/// How long a command that should end at a prompt may stay silent before it counts as done anyway
const QUIET_AWAITING_PROMPT: Duration = Duration::from_secs(10);

/// What every prompt of an app ends with: its last word, numbers blanked out. A shell's
/// "~ $" and "/tmp $" are both "$", IEx's iex(1)> and iex(2)> both "iex(#)>"
fn prompt_shape(s: &str) -> String {
    let last = s.split_whitespace().last().unwrap_or_default();
    last.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect()
}

struct Session {
    board: Arc<Board>,
    runner: Arc<Runner>,
    /// The app's prompt, as exec last saw it on a line of its own
    prompt: Mutex<Option<String>>,
    activity: Arc<Activity>,
    /// The console output saved with the snapshot
    persisted: Vec<u8>,
    exec_lock: Mutex<()>,
}

impl Session {
    /// What the screen shows now: everything after the last clear.
    fn screen(&self) -> Vec<u8> {
        let mut all = self.persisted.clone();
        all.extend_from_slice(&self.activity.screen.lock().unwrap().buf);
        text::since_last_clear(&all).to_vec()
    }

    /// Wait for the command to finish: its prompt is back and nothing is printing. Without a
    /// prompt to go by, once the app has printed, fetched and computed nothing for a while.
    fn quiet(&self, prompt: &str, from: usize) {
        let begun = Instant::now();
        let shape = prompt_shape(prompt);
        // With a prompt to wait for, silence alone (sleep, a slow request) isn't the end
        let quiet = if shape.is_empty() { QUIET } else { QUIET_AWAITING_PROMPT };
        let mut load = machine::Load::new(&self.runner);
        // The CPUs' load is sampled every 100 ms (counting instructions stops every CPU briefly)
        let mut busy = false;
        let mut sampled = Instant::now();
        loop {
            {
                // Woken by output (the prompt coming back), else every POLL
                let screen = self.activity.screen.lock().unwrap();
                let _ = self.activity.screen_cv.wait_timeout(screen, POLL).unwrap();
            }
            if sampled.elapsed() >= Duration::from_millis(100) {
                busy = load.busy(&self.runner);
                sampled = Instant::now();
            }
            if begun.elapsed() >= COMMAND_CAP {
                break;
            }
            let idle = self.activity.idle_for();
            if self.activity.connected() || idle < PROMPT_SETTLE {
                continue;
            }
            if !shape.is_empty() {
                let screen = self.activity.screen.lock().unwrap();
                let printed = screen.since(from);
                let line = printed.rsplit(|&b| b == b'\n').next().unwrap_or_default();
                // The command's own echo ends with the prompt too: only a line after it counts
                let line: String = String::from_utf8_lossy(&text::plain(line))
                    .trim()
                    .chars()
                    .map(|c| if c.is_ascii_digit() { '#' } else { c })
                    .collect();
                if printed.contains(&b'\n') && line.ends_with(&shape) {
                    break;
                }
            }
            if !busy && idle >= quiet {
                break;
            }
        }
    }

    /// Type one command into the app and return what it printed: the echoed command line and
    /// the prompt left waiting after it are the terminal's, not the command's, so they're cut.
    fn exec(&self, command: &str) -> Vec<u8> {
        let _one_at_a_time = self.exec_lock.lock().unwrap();
        // The app's prompt: learned from the screen the snapshot left (a ready app waits at its
        // prompt), then from the lines each command ends with
        let prompt = {
            let mut p = self.prompt.lock().unwrap();
            if p.is_none() {
                let screen = self.screen();
                let line = screen.rsplit(|&b| b == b'\n').next().unwrap_or_default();
                *p = Some(String::from_utf8_lossy(&text::plain(line)).trim().to_string());
            }
            p.clone().unwrap_or_default()
        };
        let from = self.activity.screen.lock().unwrap().total();
        self.board
            .console_input(format!("{}\r", command.trim_end_matches('\n')).as_bytes());
        self.activity.touch();
        self.quiet(&prompt, from);
        let output = text::without_queries(self.activity.screen.lock().unwrap().since(from));
        let output = String::from_utf8_lossy(&output).into_owned();
        // Line editors echo the command (wrapped at the terminal's width when it is long) and
        // often redraw it with the prompt (IEx, Node): the leading lines that end with the
        // command are that echo
        let mut lines: Vec<&str> = output.split('\n').collect();
        let typed = command.trim();
        loop {
            let mut echoed = String::new();
            let mut cut = 0;
            for (k, line) in lines.iter().enumerate().take(lines.len().saturating_sub(1).min(16)) {
                echoed.push_str(&String::from_utf8_lossy(&text::plain(line.as_bytes())));
                if !typed.is_empty() && echoed.trim_end().ends_with(typed) {
                    cut = k + 1;
                    break;
                }
            }
            if cut == 0 {
                break;
            }
            lines.drain(..cut);
        }
        // The prompt now waiting for the next command. Output that didn't end its line (printf,
        // curl -w) shares that line: keep what comes before the prompt. A last line that doesn't
        // end with the prompt is a new prompt (IEx counts, a shell shows the directory)
        if let Some(last) = lines.pop() {
            let last = String::from_utf8_lossy(&text::plain(last.as_bytes())).into_owned();
            let last = last.trim();
            let rest = match last.strip_suffix(prompt.as_str()) {
                Some(rest) if !prompt.is_empty() => rest,
                _ => {
                    *self.prompt.lock().unwrap() = Some(last.to_string());
                    ""
                },
            };
            if !rest.is_empty() {
                let mut out = lines.join("\n");
                if !out.is_empty() {
                    out.push('\n');
                }
                return (out + rest + "\n").into_bytes();
            }
        }
        if lines.is_empty() {
            Vec::new()
        } else {
            (lines.join("\n") + "\n").into_bytes()
        }
    }
}

/// A site's run.json, the machine it describes, and its title.
pub fn site_spec(site: &Site) -> Result<(serde_json::Value, Spec, String), String> {
    let info: serde_json::Value = serde_json::from_slice(
        &site.file("run.json").ok_or_else(|| format!("{} isn't a built snowglobe site", site.describe()))?,
    )
    .map_err(|e| format!("run.json: {e}"))?;
    let spec = Spec {
        memory_mb: info["memory_mb"].as_u64().unwrap_or(512) as usize,
        cpus: info["cpus"].as_u64().unwrap_or(1) as usize,
        network: info["network"].as_str().unwrap_or("none").to_string(),
    };
    let title = info["title"].as_str().unwrap_or("snowglobe").to_string();
    Ok((info, spec, title))
}

/// `run <site dir>`, or (`bundled`) the site this executable carries.
pub fn main(args: &Args, bundled: Option<Site>) -> Result<u8, String> {
    // A job for a serving process: no machine here
    if let Some(socket) = args.get("server") {
        return crate::serve::client(args, socket);
    }
    let site = match bundled {
        Some(site) => site,
        None => {
            let dir = PathBuf::from(args.positional.first().ok_or("run needs a site directory")?);
            // A pooled site keeps its blobs in a store shared with its neighbours (--blobs)
            Site::dir(&dir, args.get("blobs").map(std::path::Path::new))?
        },
    };
    // Jobs from one restore, each a fork of it
    if let Some(socket) = args.get("serve") {
        return crate::serve::main(args, site, socket);
    }
    let (info, spec, title) = site_spec(&site)?;
    let socket = args.get("socket").unwrap_or(SOCKET).to_string();

    let env_file: Vec<(String, String)> = match args.get("env-file") {
        Some(p) => {
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{p}: {e}"))?)
                .map_err(|e| format!("{p}: {e}"))?;
            v.as_object()
                .ok_or_else(|| format!("{p}: not a JSON object"))?
                .iter()
                .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect::<Option<_>>()
                .ok_or_else(|| format!("{p}: values must be strings"))?
        },
        None => Vec::new(),
    };

    let controls = driver::Controls::from_args(args)?;
    let log_dir = args.get("log-dir").map(std::path::absolute).transpose().map_err(|e| format!("--log-dir: {e}"))?;

    // Confine this process before anything starts a thread: what follows reads the site (mapped
    // already, if bundled), makes the control socket, listens on the forwarded ports, keeps the
    // JIT profile and the logs, and looks for the stop files; nothing else
    let sandboxed = {
        let mut write: Vec<PathBuf> = profile::cache_path(&site).and_then(|p| sandbox::parent_of(&p)).into_iter().collect();
        write.extend(log_dir.clone());
        // A job's workspace: its files go in, out/ comes back
        if let Some(ws) = args.get("workspace") {
            write.push(PathBuf::from(ws));
        }
        if let Some(p) = args.get("record-reads") {
            write.extend(sandbox::parent_of(std::path::Path::new(p)));
        }
        let bind = args
            .all("forward")
            .iter()
            .filter_map(|f| f.rsplit(':').nth(1)?.parse().ok())
            .collect();
        sandbox::apply(&sandbox::Policy {
            read: [site.read_paths(), controls.read_paths()].concat(),
            write,
            socket_dir: sandbox::parent_of(std::path::Path::new(&socket)),
            bind,
            network: spec.network == "fetch",
        })?
    };

    let started = Instant::now();
    if let Some(dir) = &log_dir {
        log::install(log::Logs::open(dir)?).event(
            "start",
            json!({
                "site": site.describe(),
                "pid": std::process::id(),
                "sandbox": sandboxed,
                "max_runtime": controls.max_runtime.map(|d| d.as_secs_f64()),
                "stop_files": controls.stop_files,
            }),
        );
    }
    // From here on, the run ends when its driver says so, whatever it is doing
    driver::watch(controls, started);
    // A run compiles its profile's code on top of what it gets hot: room for both, or the JIT
    // fills up and starts over mid-run (ARMLESS_JIT_CODE_MB still says otherwise)
    if std::env::var_os("ARMLESS_JIT_CODE_MB").is_none() {
        std::env::set_var("ARMLESS_JIT_CODE_MB", "64");
    }
    let (vm, clock) = machine::new_vm(&spec, &site)?;
    let board = vm.board.clone();
    let mut runner = Runner::new(vm, clock, false);
    let state = site.need("system/state.bin.zst")?;
    let mut reader = armless::zstd::reader(&state[..]).map_err(|e| e.to_string())?;
    runner.load_state_from(&mut reader)?;
    drop(reader);
    let timing = std::env::var_os("SNOWGLOBE_TIMING").is_some();
    if timing {
        eprintln!("timing: {sandboxed}");
        eprintln!("timing: restored in {:.0} ms", started.elapsed().as_secs_f64() * 1e3);
    }
    // Code that earlier runs of this snapshot compiled (and the build, booting it) is compiled
    // now, while the app waits for its first command, instead of interpreted until it gets hot.
    // The profile learns from every run, so it follows what runs actually do.
    // ARMLESS_JIT_PREWARM=off skips it
    let learned = if std::env::var("ARMLESS_JIT_PREWARM").map_or(true, |v| v != "off") {
        let learned = profile::Learned::open(&site);
        let queued = runner.jit_prewarm(&learned.prewarm());
        if timing {
            eprintln!(
                "timing: {} profiled pages, {queued} queued by {:.0} ms",
                learned.pages(),
                started.elapsed().as_secs_f64() * 1e3
            );
        }
        Some(Arc::new(learned))
    } else {
        None
    };

    let activity = Activity::new(false);
    // Every file the guest fetches from the restore on, written out as it grows (a detached run
    // ends when its container is stopped) in the reads.json shape `snowglobe warm` merges
    if let Some(path) = args.get("record-reads").map(PathBuf::from) {
        *activity.reads.lock().unwrap() = Some(BTreeSet::new());
        let activity = activity.clone();
        std::thread::spawn(move || {
            let mut written = None;
            loop {
                let names: Vec<String> = activity.reads.lock().unwrap().iter().flatten().cloned().collect();
                if written != Some(names.len()) {
                    let doc = json!({ "boot": [], "exercise": { "run": names } });
                    if std::fs::write(&path, serde_json::to_vec(&doc).unwrap()).is_ok() {
                        written = Some(names.len());
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }
    let net = machine::Net::from_args(args, Some(&info["tunnels"]))?;
    let host = Arc::new(machine::host(&board, &site, &spec.network, net, &activity));
    runner.start();
    let runner = Arc::new(runner);
    if let Some(learned) = &learned {
        learned.keep_learning(runner.clone());
        // A stop saves what the run learned too
        let (learned, runner) = (learned.clone(), runner.clone());
        driver::on_stop(Box::new(move || learned.learn(&runner)));
    }
    log::event("restored", json!({ "ms": started.elapsed().as_millis() as u64 }));

    let session = Arc::new(Session {
        board: board.clone(),
        runner: runner.clone(),
        prompt: Mutex::new(None),
        activity: activity.clone(),
        persisted: site.file("system/console.bin").map(|c| c.into_owned()).unwrap_or_default(),
        exec_lock: Mutex::new(()),
    });

    // A job: the workspace in, the command run, out/ back, then the end (--workspace)
    if let Some(ws) = args.get("workspace") {
        let command = args.get("cmd").ok_or("--workspace needs --cmd COMMAND")?.to_string();
        let mut env = args
            .all("env")
            .iter()
            .map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect::<Option<Vec<_>>>()
            .ok_or("--env takes NAME=VALUE")?;
        // Variables from a file (a JSON object of strings): secrets, which a command line would
        // show to everyone on the machine. Read before the sandbox takes the file away
        env.extend(env_file);
        let timeout = Duration::from_secs_f64(args.get("timeout").map_or(Ok(300.0), str::parse).map_err(|_| "--timeout: seconds")?);
        let w = job::Workspace { dir: PathBuf::from(ws), command, env, timeout };
        let begun = Instant::now();
        let (done, out_files) = job::run_workspace(&board, &activity, &w)?;
        let mut out = std::io::stdout();
        let _ = out.write_all(&done.output);
        let _ = out.flush();
        if timing {
            eprintln!(
                "timing: job {:?} in {:.0} ms ({} files to out/), {:.0} ms in all",
                done.status,
                begun.elapsed().as_secs_f64() * 1e3,
                out_files,
                started.elapsed().as_secs_f64() * 1e3
            );
        }
        if timing {
            jit_stats(&runner);
        }
        if let Some(learned) = &learned {
            learned.learn(&runner);
        }
        let code = match done.status {
            Some(s) => s.clamp(0, 255) as u8,
            None => {
                if !done.cancelled {
                    eprintln!("snowglobe: the job ran out of time ({}s)", w.timeout.as_secs_f64());
                }
                124
            },
        };
        return Ok(driver::end("end", code));
    }

    // The control socket: attach and exec from other sessions
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|e| format!("{socket}: {e}"))?;
    {
        let session = session.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let session = session.clone();
                std::thread::spawn(move || serve(&session, stream));
            }
        });
    }

    // Port forwarding: host -> container -> guest. Each connection becomes a TCP connection from
    // the guest's router to the guest port, through the same network the guest's own requests use
    for spec in args.all("forward") {
        // [ADDRESS:]PORT:GUEST_PORT (all addresses by default)
        let (addr, rest) = match spec.matches(':').count() {
            2 => spec.split_once(':').map(|(a, r)| (a.to_string(), r.to_string())).unwrap(),
            _ => ("0.0.0.0".to_string(), spec.clone()),
        };
        let (listen, guest) = rest
            .split_once(':')
            .and_then(|(l, g)| Some((l.parse::<u16>().ok()?, g.parse::<u16>().ok()?)))
            .ok_or_else(|| format!("--forward {spec}: use [ADDRESS:]PORT:GUEST_PORT"))?;
        let l = TcpListener::bind((addr.as_str(), listen)).map_err(|e| format!("{addr}:{listen}: {e}"))?;
        let host = host.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                host.forward(stream, guest);
            }
        });
    }

    let secs = started.elapsed().as_secs_f64();
    if args.has("detached") {
        println!("restored {title} in {secs:.1}s ({sandboxed})");
        let _ = std::io::stdout().flush();
        let stopped = runner.wait(None);
        eprintln!("snowglobe: the guest stopped ({stopped:?})");
        return Ok(driver::end("guest-stopped", 0));
    }

    if term::is_tty(0) && term::is_tty(1) {
        eprint!("\x1b[2m{title}: restored in {secs:.1}s · {sandboxed} · ctrl-] quits\x1b[0m\r\n");
        term::raw();
        let mut out = std::io::stdout();
        let _ = out.write_all(&session.screen());
        let _ = out.flush();
        activity.watch(Box::new(|b| {
            let mut out = std::io::stdout();
            out.write_all(b).and_then(|_| out.flush()).is_ok()
        }));
        // Follow the terminal's size
        {
            let board = board.clone();
            std::thread::spawn(move || {
                let mut last = None;
                loop {
                    let size = term::size();
                    if size != last {
                        if let Some((cols, rows)) = size {
                            board.console_resize(cols, rows);
                        }
                        last = size;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
        }
        // The guest powering off ends the session
        {
            let runner = runner.clone();
            let learned = learned.clone();
            std::thread::spawn(move || {
                runner.wait(None);
                if let Some(learned) = &learned {
                    learned.learn(&runner);
                }
                term::restore();
                std::process::exit(driver::end("guest-stopped", 0) as i32);
            });
        }
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            let n = stdin.read(&mut buf).unwrap_or(0);
            if n == 0 || buf[..n].contains(&DETACH_KEY) {
                break;
            }
            board.console_input(&buf[..n]);
        }
        term::restore();
        if let Some(learned) = &learned {
            learned.learn(&runner);
        }
        return Ok(driver::end("end", 0));
    }

    // Piped: each line is a command; print what it printed, then end after the last one
    let mut out = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let begun = Instant::now();
        let output = session.exec(&line);
        if timing {
            // Until the command's last output, not until exec judged it done
            let last = activity.last_console.lock().unwrap().unwrap_or(begun);
            eprintln!("timing: {:>6.0} ms  {line}", last.saturating_duration_since(begun).as_secs_f64() * 1e3);
        }
        let _ = out.write_all(&text::plain(&output));
        let _ = out.flush();
    }
    if let Some(learned) = &learned {
        learned.learn(&runner);
    }
    if timing {
        jit_stats(&runner);
    }
    Ok(driver::end("end", 0))
}

/// One control-socket client.
fn serve(session: &Session, stream: UnixStream) {
    let Ok(writer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let mut header = Vec::new();
    if reader.read_until(b'\n', &mut header).is_err() {
        return;
    }
    let request: serde_json::Value = serde_json::from_slice(&header).unwrap_or(json!({}));
    let mut writer = writer;
    match request["mode"].as_str() {
        Some("exec") => {
            let output = session.exec(request["command"].as_str().unwrap_or(""));
            let _ = writer.write_all(&output);
        },
        Some("job") => {
            // A job on the serial shell: answered with one JSON line
            let answer = match job::from_json(&request).and_then(|r| job::run(&session.board, &session.activity, &r)) {
                Ok(done) => job::to_json(&done),
                Err(e) => json!({ "error": e }),
            };
            let _ = writer.write_all(format!("{answer}\n").as_bytes());
        },
        Some("attach") => {
            if let (Some(rows), Some(cols)) = (request["rows"].as_u64(), request["cols"].as_u64()) {
                session.board.console_resize(cols as u16, rows as u16);
            }
            if writer.write_all(&session.screen()).is_err() {
                return;
            }
            let closed = Arc::new(AtomicBool::new(false));
            {
                let closed = closed.clone();
                let mut w = writer.try_clone().unwrap();
                session.activity.watch(Box::new(move |b| {
                    !closed.load(Ordering::SeqCst) && w.write_all(b).is_ok()
                }));
            }
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => session.board.console_input(&buf[..n]),
                }
            }
            closed.store(true, Ordering::SeqCst);
        },
        _ => {
            let _ = writer.write_all(b"snowglobe: unknown request\n");
        },
    }
    let _ = writer.shutdown(std::net::Shutdown::Both);
}

/// How long exec and attach wait for a detached instance that is still restoring
const RESTORE_WAIT: Duration = Duration::from_secs(120);

fn connect(socket: &str) -> Result<UnixStream, String> {
    let begun = Instant::now();
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => return Ok(s),
            // Not listening yet: the instance is still restoring its snapshot
            Err(e)
                if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused)
                    && begun.elapsed() < RESTORE_WAIT =>
            {
                std::thread::sleep(Duration::from_millis(200))
            },
            Err(e) => return Err(format!("can't reach the instance ({e}); did it stop?")),
        }
    }
}

/// `exec`: type one command into the app, print what it printed.
pub fn client_exec(socket: &str, command: &str) -> Result<u8, String> {
    let mut s = connect(socket)?;
    s.write_all(format!("{}\n", json!({ "mode": "exec", "command": command })).as_bytes())
        .map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    s.read_to_end(&mut output).map_err(|e| e.to_string())?;
    // Colours for a terminal; plain text for a pipe or an agent reading the output
    let output = if term::is_tty(1) { output } else { text::plain(&output) };
    let mut out = std::io::stdout();
    let _ = out.write_all(&output);
    let _ = out.flush();
    Ok(0)
}

/// `attach`: join the session; ctrl-] detaches and leaves it running.
pub fn client_attach(socket: &str) -> Result<u8, String> {
    let mut s = connect(socket)?;
    let (cols, rows) = term::size().unwrap_or((0, 0));
    s.write_all(format!("{}\n", json!({ "mode": "attach", "rows": rows, "cols": cols })).as_bytes())
        .map_err(|e| e.to_string())?;
    let mut from = s.try_clone().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        let mut buf = [0u8; 4096];
        loop {
            match from.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = out.write_all(&buf[..n]);
                    let _ = out.flush();
                },
            }
        }
        term::restore();
        std::process::exit(0);
    });
    if term::is_tty(0) {
        term::raw();
    }
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 4096];
    loop {
        let n = stdin.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        if buf[..n].contains(&DETACH_KEY) {
            term::restore();
            eprint!("\r\nsnowglobe: detached; the instance keeps running\r\n");
            return Ok(0);
        }
        if s.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    term::restore();
    Ok(0)
}

/// What the JIT did (SNOWGLOBE_TIMING): how much ran compiled, and how much fell back to the
/// interpreter from inside compiled code.
fn jit_stats(runner: &Runner) {
    let (flushes, compiled, invalidated, bytes, (n, ns), insns, block_insns, helpers) = runner.with_cpu(0, |c| {
        (
            c.jit.flushes,
            c.jit.compiled,
            c.jit.page_invalidations,
            c.native_jit_code_bytes(),
            c.native_jit_stats(),
            c.insn_count,
            c.jit.block_insns,
            c.jit.helper_interps,
        )
    });
    eprintln!(
        "timing: jit {compiled} modules ({n} compiled in {:.0} ms), {invalidated} page invalidations, {flushes} flushes, {} KB code",
        ns as f64 / 1e6,
        bytes >> 10
    );
    let _ = block_insns;
    eprintln!(
        "timing: {:.0}M instructions, {:.1}M of them handed to the interpreter by compiled code",
        insns as f64 / 1e6,
        helpers as f64 / 1e6
    );
    let hist = runner.with_cpu(0, |c| c.jit.helper_hist.clone());
    if let Some(h) = hist {
        let mut top: Vec<_> = h.into_iter().collect();
        top.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        for (pattern, (n, sample)) in top.into_iter().take(30) {
            eprintln!("timing: helper {pattern:08x} {:>8.2}M  e.g. {sample:08x}", n as f64 / 1e6);
        }
    }
}
