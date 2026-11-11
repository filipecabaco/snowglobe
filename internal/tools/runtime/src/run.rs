//! `snowglobe-vm run`: restore a built site headlessly and connect its app console.
//!
//! - On a terminal: raw keys in, the screen out, ctrl-] quits.
//! - Piped: each line of stdin is typed into the app in turn, waiting for it to go quiet, and
//!   what it printed is written out; the run ends after the last one.
//! - Detached: nothing local; clients join over the control socket (`exec`, `attach`).
//!
//! The control socket takes one JSON line, then: {"mode":"exec","command":...} answers with
//! what the command printed; {"mode":"attach","rows":R,"cols":C} replays the screen and
//! streams the session both ways; {"mode":"links","links":[{host,port,url}]} replaces the
//! machine's links (names its guest reaches at a unix:// or tcp:// address the daemon chose).

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use armless::native::NativeHost;
use armless::runner::Runner;
use armless::Board;
use serde_json::json;

use crate::machine::{self, Activity, Spec};
use crate::image;
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
    blank_digits(s.split_whitespace().last().unwrap_or_default())
}

fn blank_digits(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect()
}

/// Whether what a command printed so far ends at a prompt of this shape. The command's own echo
/// ends with the prompt too: only a line after it counts.
fn at_prompt(printed: &[u8], shape: &str) -> bool {
    let line = printed.rsplit(|&b| b == b'\n').next().unwrap_or_default();
    let line = blank_digits(String::from_utf8_lossy(&text::plain(line)).trim());
    printed.contains(&b'\n') && line.ends_with(shape)
}

/// What a command printed, from everything the terminal showed after it was typed: the echoed
/// command line and the prompt left waiting after it are the terminal's, not the command's, so
/// they're cut. Also the prompt now waiting, when it isn't `prompt` any more.
fn command_output(output: &str, command: &str, prompt: &str) -> (Vec<u8>, Option<String>) {
    // Line editors echo the command (wrapped at the terminal's width when it is long) and
    // often redraw it with the prompt (IEx, Node): the leading lines that end with the
    // command are that echo. Ending with it as a word: `ls` printing "tools" is output. After
    // the echo, only a redraw (with the prompt before the command) is: `echo ls` prints "ls"
    let mut lines: Vec<&str> = output.split('\n').collect();
    let typed = command.trim();
    let mut first = true;
    loop {
        let mut echoed = String::new();
        let mut cut = 0;
        for (k, line) in lines.iter().enumerate().take(lines.len().saturating_sub(1).min(16)) {
            echoed.push_str(&String::from_utf8_lossy(&text::plain(line.as_bytes())));
            let before = echoed.trim_end().strip_suffix(typed).filter(|_| !typed.is_empty());
            if before.is_some_and(|b| b.chars().next_back().map_or(first, |c| !c.is_alphanumeric())) {
                cut = k + 1;
                break;
            }
        }
        if cut == 0 {
            break;
        }
        lines.drain(..cut);
        first = false;
    }
    // The prompt now waiting for the next command. Output that didn't end its line (printf,
    // curl -w) shares that line: keep what comes before the prompt. A last line that doesn't
    // end with the prompt is a new prompt (IEx counts, a shell shows the directory)
    let mut new_prompt = None;
    if let Some(last) = lines.pop() {
        let last = String::from_utf8_lossy(&text::plain(last.as_bytes())).into_owned();
        let last = last.trim();
        let rest = match last.strip_suffix(prompt) {
            Some(rest) if !prompt.is_empty() => rest,
            _ => {
                new_prompt = Some(last.to_string());
                ""
            },
        };
        if !rest.is_empty() {
            let mut out = lines.join("\n");
            if !out.is_empty() {
                out.push('\n');
            }
            return ((out + rest + "\n").into_bytes(), new_prompt);
        }
    }
    let out = if lines.is_empty() { Vec::new() } else { (lines.join("\n") + "\n").into_bytes() };
    (out, new_prompt)
}

/// A running machine as its control socket serves it: exec, attach, jobs, connections to its ports.
pub(crate) struct Session {
    board: Arc<Board>,
    runner: Arc<Runner>,
    /// The host side of its network: what a `connect` is handed to
    host: Arc<NativeHost>,
    /// The app's prompt, as exec last saw it on a line of its own
    prompt: Mutex<Option<String>>,
    activity: Arc<Activity>,
    /// The console output saved with the snapshot
    persisted: Vec<u8>,
    exec_lock: Mutex<()>,
}

impl Session {
    pub(crate) fn new(board: Arc<Board>, runner: Arc<Runner>, host: Arc<NativeHost>, activity: Arc<Activity>, site: &Site) -> Arc<Session> {
        Arc::new(Session {
            board,
            runner,
            host,
            prompt: Mutex::new(None),
            activity,
            persisted: site.file("system/console.bin").map(|c| c.into_owned()).unwrap_or_default(),
            exec_lock: Mutex::new(()),
        })
    }

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
            if !shape.is_empty() && at_prompt(self.activity.screen.lock().unwrap().since(from), &shape) {
                break;
            }
            if !busy && idle >= quiet {
                break;
            }
        }
    }

    /// Type one command into the app and return what it printed (`command_output`).
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
        let (output, new_prompt) = command_output(&String::from_utf8_lossy(&output), command, &prompt);
        if new_prompt.is_some() {
            *self.prompt.lock().unwrap() = new_prompt;
        }
        output
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
        if let Some(line) = crate::lifeline::inherited() {
            crate::lifeline::watch(line, || crate::lifeline::stop("what started this job"));
        }
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
    machine::choose_jit(&info, args.get("jit"))?;
    let socket = args.get("socket").unwrap_or(SOCKET).to_string();

    let env_file = args.get("env-file").map(env_file).transpose()?.unwrap_or_default();

    let controls = driver::Controls::from_args(args)?;
    let log_dir = args.get("log-dir").map(std::path::absolute).transpose().map_err(|e| format!("--log-dir: {e}"))?;

    // Confine this process before anything starts a thread: what follows reads the site (mapped
    // already, if bundled), makes the control socket, listens on the forwarded ports, keeps the
    // JIT profile and the logs, and looks for the stop files; nothing else
    // The snapshot's RAM, shared with every other machine restored from it: opened (made, the
    // first time) before the sandbox, which then needn't reach the cache's images
    let image = image::open(&site, spec.memory_mb << 20);
    let sandboxed = sandbox::apply(&policy(args, &site, &controls, log_dir.as_deref(), &socket, spec.network == "fetch"))?;
    // Tied to what started it, if that asked: watched once confined, from a thread of its own
    if let Some(line) = crate::lifeline::inherited() {
        crate::lifeline::watch(line, || crate::lifeline::stop("what started this run"));
    }

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
    // A site with no kernel restores its program instead (snowglobe build --kernel none)
    if crate::user::is_user(&site) {
        return crate::user::run(args, &site, &spec, &title, image, &socket, started);
    }
    if std::env::var_os("ARMLESS_JIT_CODE_MB").is_none() {
        std::env::set_var("ARMLESS_JIT_CODE_MB", "64");
    }
    let (ram, without_pages) = image.map(|i| (i.ram, i.state)).unzip();
    let (vm, clock) = machine::new_vm_on(&spec, &site, true, ram)?;
    let board = vm.board.clone();
    let mut runner = Runner::new(vm, clock, false);
    match without_pages {
        Some(state) => runner.load_state(&state)?,
        None => {
            let state = site.need("system/state.bin.zst")?;
            let mut reader = zstd::stream::read::Decoder::with_buffer(&state[..]).map_err(|e| e.to_string())?;
            runner.load_state_from(&mut reader)?;
        }
    }
    let timing = std::env::var_os("SNOWGLOBE_TIMING").is_some();
    if timing {
        eprintln!("timing: {sandboxed}");
        eprintln!("timing: restored in {:.0} ms", started.elapsed().as_secs_f64() * 1e3);
    }
    // Code that earlier runs of this snapshot compiled (and the build, booting it) is compiled
    // now, while the app waits for its first command, instead of interpreted until it gets hot.
    // The profile learns from every run, so it follows what runs actually do.
    // ARMLESS_JIT_PREWARM=off skips it, as does a run without the JIT
    let learned = if machine::jit_wanted() && std::env::var("ARMLESS_JIT_PREWARM").map_or(true, |v| v != "off") {
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

    let session = Session::new(board.clone(), runner.clone(), host.clone(), activity.clone(), &site);

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
        let timeout = job::timeout_flag(args.get("timeout"))?;
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
            jit_stats(&runner);
        }
        if let Some(learned) = &learned {
            learned.learn(&runner);
        }
        if done.status.is_none() && !done.cancelled {
            eprintln!("snowglobe: the job ran out of time ({}s)", w.timeout.as_secs_f64());
        }
        return Ok(driver::end("end", job::exit_code(done.status.map(i64::from))));
    }

    // The control socket: attach and exec from other sessions
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|e| format!("{socket}: {e}"))?;
    listen(session.clone(), listener);

    // Port forwarding: host -> container -> guest. Each connection becomes a TCP connection from
    // the guest's router to the guest port, through the same network the guest's own requests use
    for spec in args.all("forward") {
        let (addr, listen, guest) = forward(&spec)?;
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

    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
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

/// What a run may touch (`sandbox`): it reads the site and looks for its stop files; it writes
/// the JIT profile cache, its logs, a job's workspace and the reads it records; it makes its
/// control socket and listens on the ports it forwards.
fn policy(args: &Args, site: &Site, controls: &driver::Controls, log_dir: Option<&std::path::Path>, socket: &str, network: bool) -> sandbox::Policy {
    let mut write: Vec<PathBuf> = profile::cache_path(site).and_then(|p| sandbox::parent_of(&p)).into_iter().collect();
    write.extend(log_dir.map(PathBuf::from));
    // A job's workspace: its files go in, out/ comes back
    if let Some(ws) = args.get("workspace") {
        write.push(PathBuf::from(ws));
    }
    if let Some(p) = args.get("record-reads") {
        write.extend(sandbox::parent_of(std::path::Path::new(p)));
    }
    sandbox::Policy {
        read: [site.read_paths(), controls.read_paths()].concat(),
        write,
        socket_dir: sandbox::parent_of(std::path::Path::new(socket)),
        bind: args.all("forward").iter().filter_map(|f| forward(f).ok()).map(|(_, listen, _)| listen).collect(),
        network,
    }
}

/// `--env-file`: variables from a file, a JSON object of strings.
fn env_file(p: &str) -> Result<Vec<(String, String)>, String> {
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{p}: {e}"))?).map_err(|e| format!("{p}: {e}"))?;
    v.as_object()
        .ok_or_else(|| format!("{p}: not a JSON object"))?
        .iter()
        .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
        .collect::<Option<_>>()
        .ok_or_else(|| format!("{p}: values must be strings"))
}

/// `--forward [ADDRESS:]PORT:GUEST_PORT` (all addresses by default): where to listen, and the
/// guest's port.
fn forward(spec: &str) -> Result<(String, u16, u16), String> {
    let (addr, rest) = match spec.matches(':').count() {
        2 => spec.split_once(':').unwrap(),
        _ => ("0.0.0.0", spec),
    };
    let (listen, guest) = rest
        .split_once(':')
        .and_then(|(l, g)| Some((l.parse::<u16>().ok()?, g.parse::<u16>().ok()?)))
        .ok_or_else(|| format!("--forward {spec}: use [ADDRESS:]PORT:GUEST_PORT"))?;
    Ok((addr.to_string(), listen, guest))
}

/// Save a running machine's state to `path` (zstd, as a site's state.bin.zst): its CPUs pause
/// while it is taken. The bytes written and the milliseconds it took.
pub(crate) fn save_machine(runner: &Runner, path: &std::path::Path) -> Result<(u64, u64), String> {
    let begun = Instant::now();
    let state = runner.save_state();
    let mut e = zstd::stream::Encoder::new(Vec::with_capacity(state.len() / 4), 3).map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()) as u32;
    e.multithread(threads).map_err(|e| e.to_string())?;
    e.include_contentsize(true).map_err(|e| e.to_string())?;
    e.set_pledged_src_size(Some(state.len() as u64)).map_err(|e| e.to_string())?;
    e.write_all(&state).map_err(|e| e.to_string())?;
    let data = e.finish().map_err(|e| e.to_string())?;
    drop(state);
    // Whole or not at all: a reader never sees half a state
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, &data).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((data.len() as u64, begun.elapsed().as_millis() as u64))
}

/// Serve the control socket on threads of its own, one per client.
pub(crate) fn listen(session: Arc<Session>, listener: UnixListener) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let session = session.clone();
            std::thread::spawn(move || serve(&session, stream));
        }
    });
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
                // Out of descriptors: this client goes, the machine stays
                let mut w = match writer.try_clone() {
                    Ok(w) => w,
                    Err(e) => {
                        let _ = writer.write_all(format!("snowglobe: can't attach: {e}\n").as_bytes());
                        return;
                    },
                };
                // Every console event waits on this write: a client that stops reading is let go
                // rather than stalling the machine
                let _ = w.set_write_timeout(Some(ATTACH_STALL));
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
            // Let go of its socket now, not at the app's next output
            session.activity.unwatch_done();
        },
        Some("save") => {
            // The whole machine (RAM, CPUs, devices, the files its guest wrote) to a file, from
            // which a fork server can start a machine again (`spawn` with a `state`)
            let answer = match request["path"].as_str() {
                Some(path) => match save_machine(&session.runner, std::path::Path::new(path)) {
                    Ok((bytes, ms)) => json!({ "saved": path, "bytes": bytes, "ms": ms }),
                    Err(e) => json!({ "error": e }),
                },
                None => json!({ "error": "save: a path" }),
            };
            let _ = writer.write_all(format!("{answer}\n").as_bytes());
        },
        Some("links") => {
            let answer = match links(&request["links"]) {
                Ok(l) => {
                    let n = l.len();
                    session.host.set_links(l);
                    json!({ "links": n })
                },
                Err(e) => json!({ "error": e }),
            };
            let _ = writer.write_all(format!("{answer}\n").as_bytes());
        },
        Some("connect") => {

            // A connection to a guest port: what a forwarded port is, for whoever holds the host's
            // listener (a fork's sandbox may bind no TCP port itself). The client waits for this
            // answer before it sends, so nothing of the connection is in the reader's buffer
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
            // The host pumps a socket's reads and writes into the guest's connection: a Unix
            // socket does all of that as a TCP one does (only TCP options fail, and are ignored)
            let stream = std::net::TcpStream::from(std::os::fd::OwnedFd::from(reader.into_inner()));
            session.host.forward(stream, port);
            return;
        },
        _ => {
            let _ = writer.write_all(b"snowglobe: unknown request\n");
        },
    }
    let _ = writer.shutdown(std::net::Shutdown::Both);
}

/// A links request's links: each a name (or none, for any) and port the guest connects to, and
/// the tcp://HOST:PORT its connections go to instead.
fn links(v: &serde_json::Value) -> Result<Vec<armless::native::Tunnel>, String> {
    let Some(list) = v.as_array() else { return Err("links: a list of {host, port, url}".into()) };
    list.iter()
        .map(|l| {
            let port = l["port"].as_u64().and_then(|p| u16::try_from(p).ok()).filter(|&p| p > 0).ok_or("links: each needs a port")?;
            let t = armless::native::Tunnel { host: l["host"].as_str().filter(|h| !h.is_empty()).map(str::to_string), port, url: l["url"].as_str().unwrap_or("").to_string() };
            if t.tcp_address().is_none() && t.unix_path().is_none() {
                return Err(format!("links: {}: a unix:///PATH or tcp://HOST:PORT url", t.url));
            }
            Ok(t)
        })
        .collect()
}

/// How long an attached client may leave the console's output unread before it is let go
const ATTACH_STALL: Duration = Duration::from_secs(2);

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
    let output = if std::io::stdout().is_terminal() { output } else { text::plain(&output) };
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
    if std::io::stdin().is_terminal() {
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
        top.sort_by_key(|(_, (n, _))| std::cmp::Reverse(*n));
        for (pattern, (n, sample)) in top.into_iter().take(30) {
            eprintln!("timing: helper {pattern:08x} {:>8.2}M  e.g. {sample:08x}", n as f64 / 1e6);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_names_and_ports_to_tcp_addresses() {
        let l = links(&json!([{"host": "db", "port": 5432, "url": "tcp://127.0.0.1:40000"}, {"port": 6379, "url": "tcp://127.0.0.1:40001"}])).unwrap();
        assert_eq!((l[0].host.as_deref(), l[0].port), (Some("db"), 5432));
        assert_eq!((l[1].host.as_deref(), l[1].tcp_address()), (None, Some(("127.0.0.1".into(), 40001))));
        assert!(links(&json!([])).unwrap().is_empty());
        assert_eq!(links(&json!([{"host": "db", "port": 1, "url": "unix:///tmp/s/l.sock"}])).unwrap()[0].unix_path(), Some("/tmp/s/l.sock"));
        for bad in [json!(null), json!([{"host": "db", "url": "tcp://127.0.0.1:1"}]), json!([{"port": 1, "url": "wss://x"}])] {
            assert!(links(&bad).is_err(), "{bad}");
        }
    }
    use crate::testing::{self, site, tmp, write};
    use armless::dev::Event;

    fn args(v: &[&str]) -> Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        Args::parse(&v, crate::RUN_FLAGS).unwrap()
    }

    fn out(output: &str, command: &str, prompt: &str) -> (String, Option<String>) {
        let (o, p) = command_output(output, command, prompt);
        (String::from_utf8(o).unwrap(), p)
    }

    #[test]
    fn a_prompts_shape_is_its_last_word_without_numbers() {
        assert_eq!(prompt_shape("~ $"), "$");
        assert_eq!(prompt_shape("/tmp/x $ "), "$");
        assert_eq!(prompt_shape("iex(12)>"), "iex(##)>");
        assert_eq!(prompt_shape("   "), "");
    }

    #[test]
    fn a_command_is_at_its_prompt_only_on_a_line_after_its_echo() {
        // The echo alone ends with the prompt's shape: not done yet
        assert!(!at_prompt(b"iex(1)> 1 + 1", "iex(#)>"));
        assert!(!at_prompt(b"1 + 1\r\n2", "iex(#)>"));
        assert!(at_prompt(b"1 + 1\r\n2\r\n\x1b[1miex(2)>\x1b[0m ", "iex(#)>"));
        assert!(at_prompt(b"ls\r\nbin\r\n~ $ ", "$"));
        assert!(!at_prompt(b"", "$"));
    }

    #[test]
    fn a_shells_echo_and_prompt_are_cut() {
        assert_eq!(out("ls\r\nbin  etc\r\n~ $ ", "ls", "~ $"), ("bin  etc\r\n".into(), None));
        // Nothing printed
        assert_eq!(out("true\r\n~ $ ", "true", "~ $"), ("".into(), None));
        // Colours and carriage returns don't hide the prompt
        assert_eq!(out("echo hi\r\nhi\r\n\x1b[32m~ $\x1b[0m ", "echo hi", "~ $"), ("hi\r\n".into(), None));
    }

    #[test]
    fn output_without_a_newline_keeps_what_came_before_the_prompt() {
        assert_eq!(out("printf ok\r\nok~ $ ", "printf ok", "~ $"), ("ok\n".into(), None));
        assert_eq!(out("x\r\nline\r\npart~ $ ", "x", "~ $"), ("line\r\npart\n".into(), None));
    }

    #[test]
    fn a_new_prompt_is_learned_from_the_last_line() {
        // cd: the shell shows the new directory
        assert_eq!(out("cd /tmp\r\n/tmp $ ", "cd /tmp", "~ $"), ("".into(), Some("/tmp $".into())));
        // IEx counts its prompts
        assert_eq!(out("1 + 1\r\n2\r\niex(2)> ", "1 + 1", "iex(1)>"), ("2\r\n".into(), Some("iex(2)>".into())));
        // No prompt known yet
        assert_eq!(out("x\r\ny\r\n> ", "x", ""), ("y\r\n".into(), Some(">".into())));
    }

    #[test]
    fn a_line_editors_redraw_and_wrapping_are_echo_too() {
        // IEx and Node echo the line, then redraw it after the prompt
        assert_eq!(out("1 + 1\r\niex(1)> 1 + 1\r\n2\r\niex(2)> ", "1 + 1", "iex(1)>").0, "2\r\n");
        // A long command wrapped at the terminal's width
        assert_eq!(out("echo aaaa\r\nbbbb\r\naaaabbbb\r\n$ ", "echo aaaabbbb", "$").0, "aaaabbbb\r\n");
    }

    #[test]
    fn output_that_ends_like_the_command_is_not_its_echo() {
        // `ls` listing a directory whose last entry ends in "ls": its output, not an echo
        assert_eq!(out("ls\r\nbin  tools\r\n~ $ ", "ls", "~ $").0, "bin  tools\r\n");
        assert_eq!(out("ls\r\na\r\nb\r\ncontrols\r\n~ $ ", "ls", "~ $").0, "a\r\nb\r\ncontrols\r\n");
        // A command that prints itself
        assert_eq!(out("echo ls\r\nls\r\n~ $ ", "echo ls", "~ $").0, "ls\r\n");
    }

    #[test]
    fn a_sites_run_json_says_what_machine_it_runs_on() {
        let (_, s) = site("run-spec", &[("run.json", br#"{"memory_mb":1024,"cpus":2,"network":"fetch","title":"T","tunnels":[]}"#)]);
        let (info, spec, title) = site_spec(&s).unwrap();
        assert_eq!((spec.memory_mb, spec.cpus, spec.network.as_str(), title.as_str()), (1024, 2, "fetch", "T"));
        assert!(info["tunnels"].is_array());
        let (_, s) = site("run-spec-default", &[("run.json", b"{}")]);
        let (_, spec, title) = site_spec(&s).unwrap();
        assert_eq!((spec.memory_mb, spec.cpus, spec.network.as_str(), title.as_str()), (512, 1, "none", "snowglobe"));
    }

    #[test]
    fn a_directory_that_isnt_a_built_site_is_refused() {
        let (root, s) = site("run-spec-none", &[]);
        assert_eq!(site_spec(&s).err().unwrap(), format!("{} isn't a built snowglobe site", root.display()));
        write(&root, &[("run.json", b"{nope")]);
        assert!(site_spec(&s).err().unwrap().starts_with("run.json: "));
    }

    #[test]
    fn an_env_file_is_an_object_of_strings() {
        let d = tmp("run-env-file");
        write(&d, &[("ok.json", br#"{"A":"1","B":"two words"}"#), ("num.json", br#"{"A":1}"#), ("arr.json", b"[]"), ("bad.json", b"{")]);
        let path = |n: &str| d.join(n).display().to_string();
        let mut env = env_file(&path("ok.json")).unwrap();
        env.sort();
        assert_eq!(env, [("A".to_string(), "1".to_string()), ("B".to_string(), "two words".to_string())]);
        assert!(env_file(&path("num.json")).err().unwrap().ends_with("values must be strings"));
        assert!(env_file(&path("arr.json")).err().unwrap().ends_with("not a JSON object"));
        assert!(env_file(&path("bad.json")).is_err());
        assert!(env_file(&path("missing.json")).is_err());
    }

    #[test]
    fn a_forward_listens_on_all_addresses_unless_given_one() {
        assert_eq!(forward("8080:80"), Ok(("0.0.0.0".into(), 8080, 80)));
        assert_eq!(forward("127.0.0.1:8080:80"), Ok(("127.0.0.1".into(), 8080, 80)));
        for bad in ["8080", "8080:", "a:80", "8080:70000", "1:2:3:4", ""] {
            assert_eq!(forward(bad).err().unwrap(), format!("--forward {bad}: use [ADDRESS:]PORT:GUEST_PORT"));
        }
    }

    #[test]
    fn a_run_may_touch_its_site_stop_files_workspace_logs_and_socket() {
        let (dir, site) = site("run-policy", &[]);
        let a = args(&[
            "--stop-file", "/drv/stop", "--workspace", "/ws", "--record-reads", "/rec/reads.json",
            "--forward", "8080:80", "--forward", "127.0.0.1:9000:90", "--forward", "nonsense",
        ]);
        let controls = driver::Controls::from_args(&a).unwrap();
        let p = policy(&a, &site, &controls, Some(std::path::Path::new("/logs")), "/run/sg.sock", false);
        assert_eq!(p.read, [dir.clone(), dir.join("system"), dir.join("system/filesystem"), PathBuf::from("/drv")]);
        // The profile cache comes first, when there is one (this site has no snapshot to name it)
        assert_eq!(p.write, [PathBuf::from("/logs"), PathBuf::from("/ws"), PathBuf::from("/rec")]);
        assert_eq!(p.socket_dir, Some(PathBuf::from("/run")));
        assert_eq!(p.bind, [8080, 9000]);
        assert!(!p.network);
        let p = policy(&args(&[]), &site, &driver::Controls::default(), None, "sg.sock", true);
        assert!(p.write.is_empty());
        assert_eq!(p.socket_dir, Some(PathBuf::from(".")));
        assert!(p.network);
    }

    #[test]
    fn run_refuses_what_it_cant_run_before_it_starts_anything() {
        let err = |a: &[&str]| main(&args(a), None).err().unwrap();
        assert_eq!(err(&[]), "run needs a site directory");
        let (root, _) = site("run-main", &[]);
        let dir = root.display().to_string();
        assert!(err(&[&dir]).contains("isn't a built snowglobe site"));
        write(&root, &[("run.json", b"{}")]);
        assert!(err(&[&dir, "--env-file", "/nonexistent/env.json"]).starts_with("/nonexistent/env.json: "));
        assert!(err(&[&dir, "--max-runtime", "0"]).starts_with("--max-runtime 0"));
        // Pooled, without its blobs store
        let bare = tmp("run-main-bare");
        assert!(err(&[&bare.display().to_string()]).contains("--blobs"));
    }

    /// A session on a machine that never runs, its app played by the test: each command typed
    /// is answered with the next of `answers`.
    fn session(name: &str, persisted: &[u8], answers: Vec<&'static [u8]>) -> Arc<Session> {
        let (board, runner) = testing::machine(name);
        let activity = Activity::new(false);
        let (_, site) = testing::site(&format!("{name}-host"), &[("system/filesystem.json", testing::EMPTY_FS)]);
        let host = Arc::new(machine::host(&board, &site, "none", machine::Net::default(), &activity));
        let s = Arc::new(Session {
            board: board.clone(),
            runner: Arc::new(runner),
            host,
            prompt: Mutex::new(None),
            activity: activity.clone(),
            persisted: persisted.to_vec(),
            exec_lock: Mutex::new(()),
        });
        std::thread::spawn(move || {
            let mut typed = 0;
            for answer in answers {
                let begun = Instant::now();
                while board.console_pending() == typed {
                    assert!(begun.elapsed() < Duration::from_secs(10), "nothing typed");
                    std::thread::sleep(Duration::from_millis(2));
                }
                typed = board.console_pending();
                activity.observe(&Event::Console(answer.to_vec()));
            }
        });
        s
    }

    #[test]
    fn exec_types_a_command_and_returns_what_it_printed() {
        let s = session(
            "run-exec",
            b"boot noise\x1b[2J\x1b[Hwelcome\r\n~ $ ",
            vec![b"echo hi\r\nhi\r\n~ $ ", b"cd /tmp\r\n/tmp $ ", b"pwd\r\n/tmp\r\n/tmp $ "],
        );
        // The screen is what follows the last clear
        assert_eq!(s.screen(), b"\x1b[Hwelcome\r\n~ $ ");
        assert_eq!(s.exec("echo hi\n"), b"hi\r\n");
        assert_eq!(s.prompt.lock().unwrap().as_deref(), Some("~ $"));
        assert_eq!(s.exec("cd /tmp"), b"");
        // The prompt it learned from the last command's last line
        assert_eq!(s.prompt.lock().unwrap().as_deref(), Some("/tmp $"));
        assert_eq!(s.exec("pwd"), b"/tmp\r\n");
    }

    #[test]
    fn the_control_socket_answers_exec_job_attach_and_nonsense() {
        let s = session("run-socket", b"~ $ ", vec![b"echo hi\r\nhi\r\n~ $ "]);
        let connect = |request: &str| {
            let (mut client, server) = UnixStream::pair().unwrap();
            let s = s.clone();
            let t = std::thread::spawn(move || serve(&s, server));
            client.write_all(request.as_bytes()).unwrap();
            (client, t)
        };
        let ask = |request: &str| -> Vec<u8> {
            let (mut client, t) = connect(request);
            let mut answer = Vec::new();
            client.read_to_end(&mut answer).unwrap();
            t.join().unwrap();
            answer
        };
        assert_eq!(ask("{\"mode\":\"exec\",\"command\":\"echo hi\"}\n"), b"hi\r\n");
        let job: serde_json::Value = serde_json::from_slice(&ask("{\"mode\":\"job\"}\n")).unwrap();
        assert_eq!(job["error"], "no cmd");
        assert_eq!(ask("{\"mode\":\"what\"}\n"), b"snowglobe: unknown request\n");
        assert_eq!(ask("not json\n"), b"snowglobe: unknown request\n");
        // Attach replays the screen, then what is typed goes to the app and what it prints
        // comes back, until the client goes
        let before = s.board.console_pending();
        let (mut client, t) = connect("{\"mode\":\"attach\",\"rows\":24,\"cols\":80}\nls\r");
        let screen = b"~ $ echo hi\r\nhi\r\n~ $ ";
        let mut got = vec![0u8; screen.len()];
        client.read_exact(&mut got).unwrap();
        assert_eq!(got, screen);
        let begun = Instant::now();
        while s.board.console_pending() < before + 3 {
            assert!(begun.elapsed() < Duration::from_secs(10), "what was typed never reached the app");
            std::thread::sleep(Duration::from_millis(2));
        }
        s.activity.observe(&Event::Console(b"bin\r\n".to_vec()));
        let mut got = [0u8; 5];
        client.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"bin\r\n");
        drop(client);
        t.join().unwrap();
    }

    #[test]
    fn connect_hands_the_socket_to_a_guest_port_after_answering() {
        let s = session("run-connect", b"~ $ ", vec![]);
        let ask = |request: &[u8]| -> (String, Vec<u8>) {
            let (mut client, server) = UnixStream::pair().unwrap();
            client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let s = s.clone();
            let t = std::thread::spawn(move || serve(&s, server));
            client.write_all(request).unwrap();
            let mut r = BufReader::new(client);
            let mut answer = String::new();
            r.read_line(&mut answer).unwrap();
            // Then the connection itself: this guest has no network, so it ends at once
            let mut rest = Vec::new();
            r.read_to_end(&mut rest).unwrap();
            t.join().unwrap();
            (answer, rest)
        };
        let (answer, rest) = ask(b"{\"mode\":\"connect\",\"port\":8000}\n");
        assert_eq!(answer, "{\"connected\":8000}\n");
        assert!(rest.is_empty());
        for (bad, why) in [
            (&b"{\"mode\":\"connect\"}\n"[..], "connect: a port"),
            (b"{\"mode\":\"connect\",\"port\":0}\n", "connect: a port"),
            (b"{\"mode\":\"connect\",\"port\":70000}\n", "connect: a port"),
            // Data before the answer would be lost in the reader's buffer: refused
            (b"{\"mode\":\"connect\",\"port\":80}\nGET / HTTP/1.0\r\n\r\n", "connect: send nothing before the answer"),
        ] {
            let (answer, _) = ask(bad);
            assert_eq!(answer, format!("{}\n", json!({ "error": why })), "{}", String::from_utf8_lossy(bad));
        }
    }

    /// An attach client: the session's screen read, then `then` done with the connection.
    fn attached(s: &Arc<Session>) -> (UnixStream, std::thread::JoinHandle<()>) {
        let (mut client, server) = UnixStream::pair().unwrap();
        let session = s.clone();
        let t = std::thread::spawn(move || serve(&session, server));
        client.write_all(b"{\"mode\":\"attach\"}\n").unwrap();
        let mut screen = vec![0u8; s.screen().len()];
        client.read_exact(&mut screen).unwrap();
        (client, t)
    }

    #[test]
    fn an_attach_client_that_stops_reading_doesnt_stop_the_machine() {
        let s = session("run-attach-stuck", b"~ $ ", vec![]);
        let (_client, _t) = attached(&s);
        // The app prints far more than a socket buffers; the client reads none of it. Every
        // console event goes through the watchers: they must not wait on the client for good
        let activity = s.activity.clone();
        let (done, printed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..64 {
                activity.observe(&armless::dev::Event::Console(vec![b'x'; 64 << 10]));
            }
            let _ = done.send(());
        });
        assert!(printed.recv_timeout(Duration::from_secs(20)).is_ok(), "the console is stuck behind the attach client");
    }

    #[test]
    fn an_attach_client_that_goes_is_let_go_at_once() {
        let s = session("run-attach-gone", b"~ $ ", vec![]);
        let (mut client, t) = attached(&s);
        // Done typing: the session ends, and the client sees it end without the app printing
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        t.join().unwrap();
        let mut rest = Vec::new();
        assert!(client.read_to_end(&mut rest).is_ok(), "the session's socket is still open");
    }

    #[test]
    fn a_client_reaches_a_listening_instance() {
        let path = tmp("run-connect").join("s.sock");
        let _l = UnixListener::bind(&path).unwrap();
        assert!(connect(path.to_str().unwrap()).is_ok());
    }
}
