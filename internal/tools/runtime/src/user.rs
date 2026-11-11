//! Sites with no kernel (`snowglobe build --kernel none`): the app is one static aarch64 Linux
//! executable, run on armless with no guest kernel (armless user mode, `armless_user`). The build
//! runs it to its ready text and saves the machine (state.bin.zst, as any site) and the process
//! (system/user.bin); a run restores both.
//!
//! There is no shell, so a job is a line typed into the program's stdin, done at the next line it
//! prints. `snapshot --user PROGRAM --user ARG ...` builds one; a site with system/user.bin runs
//! this way.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use armless::vm::BootError;
use armless_user::{Process, Status};
use serde_json::json;

use crate::machine::{self, Spec};
use crate::site::Site;
use crate::{driver, image, Args};

const BUILD_TIMEOUT: Duration = Duration::from_secs(300);
const ENV: [&str; 2] = ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/root"];

/// Whether a site runs in user mode.
pub fn is_user(site: &Site) -> bool {
    site.need("system/user.bin").is_ok()
}

/// `snapshot` in user mode: run the program until it printed `ready` (or, without one, printed
/// something and went quiet), then save the machine and the process.
pub fn snapshot(system: &Path, spec: &Spec, ready: Option<&str>, argv: &[String]) -> Result<u8, String> {
    let site = Site::system(system);
    let spec = Spec { cpus: 1, ..spec.clone() };
    let (mut vm, _clock) = machine::new_vm(&spec, &site)?;
    let blobs = system.join("filesystem");
    let elf = loop {
        match vm.board.read_file(&argv[0]) {
            Ok(data) => break data,
            Err(BootError::Need(names)) => {
                for n in names {
                    let data = std::fs::read(blobs.join(&n)).map_err(|e| format!("{n}: {e}"))?;
                    vm.board.provide_blob(&n, data)?;
                }
            },
            Err(BootError::Fail(e)) => return Err(e),
        }
    };
    let env: Vec<String> = ENV.iter().map(|s| s.to_string()).collect();
    eprintln!("Starting {} in user mode (no kernel) ...", argv.join(" "));
    let started = Instant::now();
    let mut p = Process::exec(&mut vm.cpus[0], &elf, argv, &env)?;
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
                let wait = wake.map_or(Duration::from_millis(20), |w| w.saturating_duration_since(Instant::now()));
                std::thread::sleep(wait.min(Duration::from_millis(20)));
            },
            Status::Running => {},
        }
        if started.elapsed() > BUILD_TIMEOUT {
            return Err(format!("app not ready after {}s", BUILD_TIMEOUT.as_secs()));
        }
    }
    let boot_seconds = started.elapsed().as_secs_f64();
    eprintln!("\nApp ready after {boot_seconds:.2}s (user mode)");
    let process = p.save(&vm.cpus[0]);
    std::fs::write(system.join("user.bin"), &process).map_err(|e| format!("user.bin: {e}"))?;
    let state = vm.save_state();
    // Lines end in CRLF on the page's terminal
    let console: Vec<u8> = console.iter().flat_map(|&b| if b == b'\n' { vec![b'\r', b'\n'] } else { vec![b] }).collect();
    crate::snapshot::save(system, &state, boot_seconds, &console)?;
    crate::snapshot::write_json(&system.join("reads.json"), &json!({ "boot": [], "exercise": {} }))?;
    crate::snapshot::write_json(&system.join("transcript.json"), &json!([]))?;
    std::fs::write(system.join("jit-profile.bin"), armless::jit::profile::write(&[])).map_err(|e| format!("jit-profile.bin: {e}"))?;
    Ok(0)
}

/// What the program's thread and the control socket share.
#[derive(Default)]
struct Shared {
    io: Mutex<Io>,
    changed: Condvar,
}

#[derive(Default)]
struct Io {
    input: VecDeque<u8>,
    /// Everything the program printed since the restore
    output: Vec<u8>,
    ended: Option<String>,
}

/// `run` in user mode, once `run` has confined the process and set up its driver: restore the
/// machine (on the snapshot's RAM image, shared with every machine restored from it, as for any
/// site) and the process, and answer the control socket's jobs.
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
    let mut p = Process::restore(&mut vm.cpus[0], &site.need("system/user.bin")?)?;
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
    if args.has("detached") {
        println!("restored {title} in {:.1}s (user mode)", started.elapsed().as_secs_f64());
        let _ = std::io::stdout().flush();
    }

    // The program, on this thread: input in, output out, until it ends
    let ended = loop {
        let pending: Vec<u8> = shared.io.lock().unwrap().input.drain(..).collect();
        if !pending.is_empty() {
            p.input(&pending);
        }
        let status = p.run(&mut vm.cpus[0], Duration::from_millis(10));
        let out = p.take_output();
        if !out.is_empty() {
            shared.io.lock().unwrap().output.extend_from_slice(&out);
            shared.changed.notify_all();
        }
        match status {
            Status::Exited(c) => break format!("exited ({c})"),
            Status::Fault(f) => break f,
            Status::Idle(wake) => {
                // Until a deadline, or input
                let wait = wake.map_or(Duration::from_millis(50), |w| w.saturating_duration_since(Instant::now())).min(Duration::from_millis(50));
                let io = shared.io.lock().unwrap();
                if io.input.is_empty() {
                    let _ = shared.changed.wait_timeout(io, wait);
                }
            },
            Status::Running => {},
        }
    };
    eprintln!("snowglobe: the program stopped: {ended}");
    shared.io.lock().unwrap().ended = Some(ended);
    shared.changed.notify_all();
    Ok(driver::end("guest-stopped", 0))
}

/// One control-socket client: a job (or exec) is a line to stdin, answered at the next line out.
fn serve(shared: &Shared, stream: std::os::unix::net::UnixStream) {
    let Ok(mut writer) = stream.try_clone() else { return };
    let mut header = Vec::new();
    if BufReader::new(stream).read_until(b'\n', &mut header).is_err() {
        return;
    }
    let request: serde_json::Value = serde_json::from_slice(&header).unwrap_or(json!({}));
    let mode = request["mode"].as_str().unwrap_or("");
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
    shared.changed.notify_all();
    let output = loop {
        if let Some(nl) = io.output[mark..].iter().position(|&b| b == b'\n') {
            break Some(io.output[mark..mark + nl + 1].to_vec());
        }
        if io.ended.is_some() || begun.elapsed() > timeout {
            break None;
        }
        io = shared.changed.wait_timeout(io, Duration::from_millis(100)).unwrap().0;
    };
    drop(io);
    let answer = match mode {
        "exec" => {
            let _ = writer.write_all(&output.unwrap_or_default());
            return;
        },
        _ => json!({
            "status": output.as_ref().map(|_| 0),
            "output": crate::b64::encode(output.as_deref().unwrap_or_default()),
            "out": {},
            "timed_out": output.is_none(),
            "cancelled": false,
            "killed": false,
            "ms": begun.elapsed().as_millis() as u64,
        }),
    };
    let _ = writer.write_all(format!("{answer}\n").as_bytes());
}
