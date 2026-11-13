//! `snowglobe-vm snapshot`: boot the site's filesystem until the app is up on the virtio
//! console, then save the snapshot the browser restores straight into the running app.
//!
//! Reads <system>/filesystem.json + filesystem/; writes into <system>:
//! - state.bin.zst  the snapshot (zstd)
//! - console.bin    the app's console output so far, which the page replays into the terminal
//! - run-meta.json  boot time and sizes
//! - reads.json     every file the guest fetched while booting; then, from the snapshot on (with
//!   the file cache emptied, as a visitor's tab starts), while it settled and while it ran each
//!   --exercise command typed in: what a restored machine reads, what a visitor would otherwise
//!   wait on the network for. Each list in the order the guest first fetched its files, which is
//!   the order the warm pack streams them in
//! - transcript.json  what each exercise command printed
//!
//! The serial port (ttyS0) carries boot logs and a root shell used for housekeeping; the app
//! runs on the virtio console (hvc0), which the page shows.
//!
//! --build-cpus boots on more CPUs than the site ships with (--cpus), so a one-CPU site boots
//! as fast as a many-CPU one. Before the snapshot the guest takes the extra CPUs offline and
//! the snapshot keeps only the first --cpus; the exercises then run on those alone.


use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use armless::runner::Runner;
use armless::vm::BootError;
use serde_json::json;

use crate::machine::{self, Activity, Reads, Spec};
use crate::text;
use crate::Args;

const TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// A boot that has printed, fetched and computed nothing for this long, before its app is ready,
/// has stalled (SNOWGLOBE_BOOT_STALL_SECS says otherwise; 0 turns it off): its CPUs' state is
/// printed and it ends with BOOT_STALLED, which the build answers by booting once more.
const STALL: Duration = Duration::from_secs(5 * 60);
const BOOT_STALLED: u8 = 75;
/// Without --ready, the app counts as ready once its console has been quiet this long.
const QUIET: Duration = Duration::from_secs(5);
/// An exercise command is done once the guest has neither printed nor fetched a file for this
/// long (or after the cap): a runtime can go quiet while it loads modules.
const EXERCISE_QUIET: Duration = Duration::from_millis(2500);
pub(crate) const EXERCISE_CAP: Duration = Duration::from_secs(180);
/// After the snapshot, before the first exercise, the machine runs on its own as a restored one
/// does until the visitor types: what it fetches then (its services waking, timers firing) is
/// recorded until it has been quiet this long, or for at most SETTLE_CAP.
const SETTLE_QUIET: Duration = Duration::from_millis(2500);
const SETTLE_CAP: Duration = Duration::from_secs(10);
/// Sooner, once it has printed its app's prompt again (the screen's last line before it was
/// typed) and been quiet this long: what a REPL or shell prints when a command is done. An app
/// whose prompt changes (`iex(2)>`) waits for EXERCISE_QUIET.
const PROMPT_QUIET: Duration = Duration::from_millis(300);
/// The console size the app starts with, unless --cols/--rows say otherwise: fits an embedded
/// panel or a small window. The page replays the snapshot's screen at this size, then resizes.
const COLS: u16 = 90;
const ROWS: u16 = 30;

pub fn main(args: &Args) -> Result<u8, String> {
    let system = PathBuf::from(args.positional.first().ok_or("snapshot needs the system directory")?);
    let cpus: usize = args.get("cpus").unwrap_or("1").parse().map_err(|_| "--cpus: not a number")?;
    let build_cpus: usize = match args.get("build-cpus") {
        Some(n) => n.parse().map_err(|_| "--build-cpus: not a number")?,
        None => cpus,
    };
    if build_cpus < cpus {
        return Err(format!("--build-cpus {build_cpus} is fewer than --cpus {cpus}"));
    }
    let spec = Spec {
        memory_mb: args.get("memory").unwrap_or("512").parse().map_err(|_| "--memory: not a number")?,
        cpus: build_cpus,
        network: args.get("network").unwrap_or("none").to_string(),
    };
    let ready = args.get("ready").map(str::to_string);
    let exercises = args.all("exercise");
    let blobs = system.join("filesystem");
    let cols = args.get("cols").map_or(Ok(COLS), str::parse).map_err(|_| "--cols: not a number")?;
    let rows = args.get("rows").map_or(Ok(ROWS), str::parse).map_err(|_| "--rows: not a number")?;

    // A site with no kernel (snowglobe build --kernel none): the program runs on its own, nothing to boot
    let user = args.all("user");
    if !user.is_empty() {
        return crate::user::snapshot(args, &system, &spec, ready.as_deref(), &user);
    }
    let site = crate::site::Site::system(&system);
    let (mut vm, clock) = machine::new_vm(&spec, &site)?;
    vm.board.console_resize(cols, rows);

    eprintln!("Booting, please stand by ...");
    let started = Instant::now();
    // The kernel and initramfs: read from the filesystem to boot, but never by the guest after
    // a restore, so they are not "boot reads"
    loop {
        match vm.boot_from_fs(machine::CMDLINE) {
            Ok(_) => break,
            Err(BootError::Need(names)) => {
                for n in names {
                    let data = std::fs::read(blobs.join(&n)).map_err(|e| format!("{n}: {e}"))?;
                    vm.board.provide_blob(&n, data)?;
                }
            },
            Err(BootError::Fail(e)) => return Err(e),
        }
    }

    let activity = Activity::new(true);
    *activity.reads.lock().unwrap() = Some(Reads::new());
    let board = vm.board.clone();
    let _host = machine::host(&board, &site, &spec.network, machine::Net::from_args(args, None)?, &activity);
    let mut runner = Runner::new(vm, clock, false);
    runner.start();

    // Up: a root shell on the serial port, and the app on the console
    let mut boot_seconds = 0.0;
    let mut app_ready = false;
    let mut stall = stall_after(std::env::var("SNOWGLOBE_BOOT_STALL_SECS").ok().as_deref())?
        .map(|after| Stall::new(after, Instant::now()));
    let mut load = machine::Load::new(&runner);
    let mut sampled = Instant::now();
    loop {
        if let Some(s) = runner.stopped() {
            return Err(format!("the guest stopped while booting: {s:?}"));
        }
        if started.elapsed() > TIMEOUT {
            dump_cpus(&runner, build_cpus);
            return Err(format!("app not ready after {}s", TIMEOUT.as_secs()));
        }
        if let Some(stall) = stall.as_mut().filter(|_| !app_ready && sampled.elapsed() >= Duration::from_secs(1)) {
            sampled = Instant::now();
            let output = activity.serial_total() + activity.screen.lock().unwrap().total();
            // A request still open to the outside is waiting on it, not stalled
            let busy = load.busy(&runner) || activity.connected();
            if stall.observe(sampled, output, activity.idle_for(), busy) {
                eprintln!(
                    "\nsnowglobe-vm: the boot stalled: nothing printed, fetched or computed for {}s, \
                     {:.0}s in. Its CPUs, 2 s apart:",
                    stall.after.as_secs(),
                    started.elapsed().as_secs_f64()
                );
                dump_cpus(&runner, build_cpus);
                std::thread::sleep(Duration::from_secs(2));
                dump_cpus(&runner, build_cpus);
                return Ok(BOOT_STALLED);
            }
        }
        if !app_ready {
            app_ready = is_ready(&activity, ready.as_deref());
            if app_ready {
                boot_seconds = started.elapsed().as_secs_f64();
                eprintln!("\nApp ready on hvc0 after {boot_seconds:.1}s");
            }
        }
        if app_ready && shell_up(&activity) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // --sandbox: a snapshot for running natively rather than in a page. Size matters less than
    // the first command's speed there, so the app is exercised before the snapshot rather than
    // after it (what it loaded on first use is loaded already, its code compiled) and the guest
    // keeps its page cache (the files it read stay read).
    let sandbox = args.has("sandbox");
    let mut transcript = Vec::new();
    let mut exercise_reads = Vec::new();
    if sandbox {
        exercise(&board, &runner, &activity, &exercises, &mut transcript, &mut exercise_reads);
    } else {
        // Drop the page cache so boot-time file contents aren't baked into the snapshot. The
        // marker is computed by the shell, so the echoed command line itself can't match it
        activity.serial.lock().unwrap().clear();
        board.serial_input(b"sync; echo 3 > /proc/sys/vm/drop_caches; echo CACHES_$((40+2))\n");
        if !activity.wait_serial(Duration::from_secs(120), |s| s.windows(9).any(|w| w == b"CACHES_42")) {
            return Err("the guest did not drop its caches".into());
        }
    }
    let boot_reads = activity.reads.lock().unwrap().take().unwrap_or_default();

    // Back to the CPUs the site ships with: Linux moves every task and interrupt off the rest,
    // and each ends in PSCI CPU_OFF, so the snapshot can leave them out
    if build_cpus > cpus {
        activity.serial.lock().unwrap().clear();
        let (offline, marker) = offline(cpus, build_cpus);
        board.serial_input(offline.as_bytes());
        if !activity.wait_serial(Duration::from_secs(120), |s| s.windows(marker.len()).any(|w| w == marker.as_bytes())) {
            return Err(format!("the guest did not take CPUs {cpus}-{} offline", build_cpus - 1));
        }
        eprintln!("Booted on {build_cpus} CPUs, saving {cpus}");
    }

    let state = runner.save_state_cpus(cpus)?;
    let console = activity.screen.lock().unwrap().buf.clone();
    save(&system, &state, boot_seconds, &console)?;
    drop(state);

    // What the JIT compiled up to the snapshot: the profile with --sandbox, or if there are no
    // exercises to take one from
    let saved_profile = runner.jit_profile();
    let mut restore_reads = Vec::new();
    if !sandbox {
        // A restore starts with no compiled code: start the exercises the same way, so that what
        // the JIT compiles for them is what a restored machine needs first. Typed in from a cold
        // file cache, as a visitor's tab starts
        runner.jit_flush();
        board.forget_blobs();
        restore_reads = settle(&runner, &activity);
        exercise(&board, &runner, &activity, &exercises, &mut transcript, &mut exercise_reads);
    }
    write_json(&system.join("reads.json"), &reads_json(boot_reads.into_vec(), restore_reads, &exercise_reads))?;
    write_json(&system.join("transcript.json"), &serde_json::Value::Array(transcript))?;
    // The code a run compiles at once after its restore (`run`), instead of interpreting it until
    // it gets hot: guest physical addresses, so the same for every host
    let profile = if sandbox || exercises.is_empty() { saved_profile } else { runner.jit_profile() };
    std::fs::write(system.join("jit-profile.bin"), armless::jit::profile::write(&profile))
        .map_err(|e| format!("jit-profile.bin: {e}"))?;
    eprintln!("JIT profile: {} pages", profile.len());
    runner.shutdown();
    let _ = std::io::stdout().flush();
    Ok(0)
}

/// Whether the app is ready: its --ready text is on the screen, or without one, its console has
/// been quiet a while.
fn is_ready(activity: &Activity, ready: Option<&str>) -> bool {
    match ready {
        Some(r) => activity.screen.lock().unwrap().buf.windows(r.len()).any(|w| w == r.as_bytes()),
        None => activity.last_console.lock().unwrap().is_some_and(|t| t.elapsed() >= QUIET),
    }
}

/// Whether the root shell on the serial port is up.
fn shell_up(activity: &Activity) -> bool {
    activity.serial.lock().unwrap().windows(2).any(|w| w == b"# ")
}

/// What takes CPUs `cpus` to `build_cpus - 1` offline, and the marker it ends with (computed by
/// the guest, so the echoed command line can't match it).
fn offline(cpus: usize, build_cpus: usize) -> (String, String) {
    let command = format!(
        "for c in $(seq {cpus} {}); do echo 0 > /sys/devices/system/cpu/cpu$c/online; done; echo CPUS_$(nproc)_OFF\n",
        build_cpus - 1
    );
    (command, format!("CPUS_{cpus}_OFF"))
}

/// Write the snapshot into the system directory: the machine's state compressed, its sizes and
/// boot time, and the console the page replays (what the screen shows, without the terminal
/// queries and progress reports).
pub(crate) fn save(system: &std::path::Path, state: &[u8], boot_seconds: f64, console: &[u8]) -> Result<(), String> {
    eprintln!("\nCompressing {} MB snapshot ...", state.len() >> 20);
    let compressed = compress(state)?;
    let out = system.join("state.bin.zst");
    std::fs::write(&out, &compressed).map_err(|e| e.to_string())?;
    write_json(
        &system.join("run-meta.json"),
        &json!({ "bootSeconds": boot_seconds, "stateBytes": state.len(), "snapshotBytes": compressed.len() }),
    )?;
    let replay = text::without_progress_reports(&text::without_queries(text::since_last_clear(console)));
    std::fs::write(system.join("console.bin"), replay).map_err(|e| e.to_string())?;
    eprintln!("Saved {} ({} MB)", out.display(), compressed.len() >> 20);
    Ok(())
}

fn compress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut e = zstd::stream::Encoder::new(Vec::with_capacity(data.len() / 4), 19).map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()) as u32;
    e.multithread(threads).map_err(|e| e.to_string())?;
    e.include_contentsize(true).map_err(|e| e.to_string())?;
    e.set_pledged_src_size(Some(data.len() as u64)).map_err(|e| e.to_string())?;
    e.write_all(data).map_err(|e| e.to_string())?;
    e.finish().map_err(|e| e.to_string())
}

/// SNOWGLOBE_BOOT_STALL_SECS: how long a boot may do nothing (None: as long as it likes).
fn stall_after(var: Option<&str>) -> Result<Option<Duration>, String> {
    match var.map(str::trim) {
        None | Some("") => Ok(Some(STALL)),
        Some(s) => match s.parse::<u64>() {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some(Duration::from_secs(n))),
            Err(_) => Err(format!("SNOWGLOBE_BOOT_STALL_SECS={s}: seconds, or 0 for no limit")),
        },
    }
}

/// Whether a boot has stalled: no output, file fetch or network traffic, and no CPU busy, for
/// `after`.
struct Stall {
    after: Duration,
    output: usize,
    since: Instant,
}

impl Stall {
    fn new(after: Duration, now: Instant) -> Stall {
        Stall { after, output: 0, since: now }
    }

    /// Look again at `now`: the output so far (bytes printed, all told), how long since a file
    /// fetch or network traffic, and whether the guest was busy (computing, or with a request
    /// open). True once it has stalled.
    fn observe(&mut self, now: Instant, output: usize, quiet_for: Duration, busy: bool) -> bool {
        let since_activity = now.checked_sub(quiet_for).unwrap_or(now);
        if output != self.output || busy {
            self.output = output;
            self.since = now;
        }
        if since_activity > self.since {
            self.since = since_activity;
        }
        now.duration_since(self.since) >= self.after
    }
}

/// One line per CPU: where it is, its IRQ mask bit (DAIF.I), how far it has run, and when its
/// timers fire (ms from now; "off" when disabled, "masked" when the timer's own output is masked).
///
/// Reading two dumps 2 s apart: a healthy idle guest has every CPU at the kernel's idle WFI with
/// I=1 (arm64 Linux idles with IRQs masked; WFI still wakes), instruction counts creeping up as
/// timer ticks are handled, and each `cntv` a few ms to seconds ahead. A lost wakeup shows a
/// timer deadline far in the past with the count standing still; a guest stuck spinning (a
/// deadlock in the kernel) shows its PC and count moving with nothing printed.
#[allow(clippy::too_many_arguments)]
fn describe_cpu(i: usize, c: &armless::cpu::SysRegs, pc: u64, lr: u64, el: u8, daif: u32, insns: u64, now: u64) -> String {
    let timer = |ctl: u64, cval: u64| -> String {
        if ctl & 1 == 0 {
            return "off".into();
        }
        let ms = (cval as i128 - now as i128) as f64 / (armless::board::TIMER_FREQ_HZ as f64 / 1000.0);
        format!("{ms:+.1}ms{}", if ctl & 2 != 0 { " masked" } else { "" })
    };
    format!(
        "cpu{i}: pc={pc:#018x} lr={lr:#018x} el{el} I={} insns={insns} cntv={} cntp={}",
        u8::from(daif & (1 << 7) != 0),
        timer(c.cntv_ctl, c.cntv_cval),
        timer(c.cntp_ctl, c.cntp_cval),
    )
}

/// Every CPU's state, for a boot that stalled or timed out.
fn dump_cpus(runner: &Runner, cpus: usize) {
    for i in 0..cpus {
        let line = runner.with_cpu(i, |c| {
            let now = c.counter();
            describe_cpu(i, &c.sys, c.pc, c.x[30], c.el, c.daif, c.insn_count, now)
        });
        eprintln!("{line}");
    }
}

/// reads.json: `boot`, `restore` (fetched while the machine settled after the snapshot) and
/// `exercises` ([{command, reads}], in the order typed, a command typed twice twice), each list
/// in first-fetched order; `exercise` is the same by command (a command typed twice: what either
/// time fetched), for older readers.
pub(crate) fn reads_json(boot: Vec<String>, restore: Vec<String>, exercises: &[(String, Vec<String>)]) -> serde_json::Value {
    let mut by_command: Vec<(String, Reads)> = Vec::new();
    for (command, reads) in exercises {
        match by_command.iter_mut().find(|(c, _)| c == command) {
            Some((_, r)) => r.extend(reads.iter().cloned()),
            None => {
                let mut r = Reads::new();
                r.extend(reads.iter().cloned());
                by_command.push((command.clone(), r));
            },
        }
    }
    let exercise: serde_json::Map<String, serde_json::Value> =
        by_command.into_iter().map(|(c, r)| (c, json!(r.into_vec()))).collect();
    let ordered: Vec<serde_json::Value> =
        exercises.iter().map(|(c, r)| json!({ "command": c, "reads": r })).collect();
    json!({ "boot": boot, "restore": restore, "exercises": ordered, "exercise": exercise })
}

/// Let the restored machine run on its own a while, as a visitor's does before they type, and
/// record what it fetches: done once it has fetched, printed and computed nothing for
/// SETTLE_QUIET (an open request counts as busy), or after SETTLE_CAP.
fn settle(runner: &Runner, activity: &std::sync::Arc<Activity>) -> Vec<String> {
    *activity.reads.lock().unwrap() = Some(Reads::new());
    activity.touch();
    let begun = Instant::now();
    let mut load = machine::Load::new(runner);
    loop {
        std::thread::sleep(Duration::from_millis(100));
        if load.busy(runner) {
            activity.touch();
        }
        let idle = if activity.connected() { Duration::ZERO } else { activity.idle_for() };
        if idle >= SETTLE_QUIET || begun.elapsed() >= SETTLE_CAP {
            break;
        }
    }
    let reads = activity.reads.lock().unwrap().take().unwrap_or_default();
    eprint!("\nSettled after the snapshot ({} files, {:.1}s)", reads.len(), begun.elapsed().as_secs_f64());
    reads.into_vec()
}

pub(crate) fn write_json(path: &std::path::Path, v: &serde_json::Value) -> Result<(), String> {
    std::fs::write(path, serde_json::to_vec(v).unwrap()).map_err(|e| format!("{}: {e}", path.display()))
}

/// Type each command into the app as a visitor would, and record what it fetches and prints.
fn exercise(
    board: &armless::Board,
    runner: &Runner,
    activity: &std::sync::Arc<Activity>,
    exercises: &[String],
    transcript: &mut Vec<serde_json::Value>,
    exercise_reads: &mut Vec<(String, Vec<String>)>,
) {
    for command in exercises {
        let boot_reads = activity.reads.lock().unwrap().take();
        *activity.reads.lock().unwrap() = Some(Reads::new());
        let begun = Instant::now();
        let (from, prompt) = {
            let s = activity.screen.lock().unwrap();
            (s.total(), prompt(&s.buf))
        };
        eprint!("\nExercising: {command}");
        board.console_input(format!("{command}\r").as_bytes());
        activity.touch();
        // Done once it has printed nothing, fetched nothing and computed nothing for a while
        let mut load = machine::Load::new(runner);
        loop {
            std::thread::sleep(Duration::from_millis(100));
            if load.busy(runner) {
                activity.touch();
            }
            let idle = if activity.connected() { Duration::ZERO } else { activity.idle_for() };
            let done = {
                let s = activity.screen.lock().unwrap();
                exercised(s.since(from), prompt.as_deref(), idle)
            };
            if done || begun.elapsed() >= EXERCISE_CAP {
                break;
            }
        }
        let reads = activity.reads.lock().unwrap().take().unwrap_or_default();
        // Exercised before the snapshot (--sandbox), what a command reads still counts as booting
        if let Some(mut boot) = boot_reads {
            boot.extend(reads.iter().cloned());
            *activity.reads.lock().unwrap() = Some(boot);
        }
        eprint!(" ({} files, {:.1}s)", reads.len(), begun.elapsed().as_secs_f64());
        let output = String::from_utf8_lossy(activity.screen.lock().unwrap().since(from)).into_owned();
        transcript.push(json!({ "command": command, "output": output }));
        exercise_reads.push((command.clone(), reads.into_vec()));
    }
    if !exercises.is_empty() {
        eprintln!();
    }
}

/// The app's prompt: the screen's last line, if it has one worth waiting for.
pub(crate) fn prompt(screen: &[u8]) -> Option<Vec<u8>> {
    let start = screen.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let line = &screen[start..];
    let line = &line[line.iter().take_while(|&&b| b == b'\r').count()..];
    let visible = line.iter().filter(|b| b.is_ascii_graphic()).count();
    (visible > 0 && line.len() <= 256).then(|| line.to_vec())
}

/// Whether an exercise command is done: `output` printed since it was typed, `idle` how long
/// the guest has printed, fetched and computed nothing (zero with a request open).
pub(crate) fn exercised(output: &[u8], prompt: Option<&[u8]>, idle: Duration) -> bool {
    let prompted = prompt.is_some_and(|p| output.len() > p.len() && output.ends_with(p));
    idle >= EXERCISE_QUIET || (prompted && idle >= PROMPT_QUIET)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{self, tmp, write, EMPTY_FS};
    use armless::dev::Event;
    use std::sync::Arc;

    fn args(v: &[&str]) -> Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        Args::parse(&v, &["memory", "cpus", "build-cpus", "network", "ready", "exercise", "cols", "rows", "tunnel"]).unwrap()
    }

    #[test]
    fn snapshot_refuses_bad_arguments_before_it_boots() {
        let system = tmp("snapshot-args");
        write(&system, &[("filesystem.json", EMPTY_FS)]);
        let dir = system.display().to_string();
        let err = |v: &[&str]| main(&args(v)).err().unwrap();
        assert_eq!(err(&[]), "snapshot needs the system directory");
        assert_eq!(err(&[&dir, "--cpus", "two"]), "--cpus: not a number");
        assert_eq!(err(&[&dir, "--build-cpus", "x"]), "--build-cpus: not a number");
        assert_eq!(err(&[&dir, "--cpus", "4", "--build-cpus", "2"]), "--build-cpus 2 is fewer than --cpus 4");
        assert_eq!(err(&[&dir, "--memory", "lots"]), "--memory: not a number");
        assert_eq!(err(&[&dir, "--cols", "wide"]), "--cols: not a number");
        assert_eq!(err(&[&dir, "--rows", "-1"]), "--rows: not a number");
        assert_eq!(err(&[&dir, "--memory", "1"]), "memory size must be between 16 MiB and 3.5 GiB");
        // A machine is made, but there is no kernel in its filesystem to boot
        assert!(err(&[&dir, "--memory", "16"]).contains("no kernel"));
        assert_eq!(err(&[&tmp("snapshot-empty").display().to_string(), "--memory", "16"]), "system/filesystem.json: not in the site");
    }

    #[test]
    fn the_app_is_ready_at_its_text_or_after_a_quiet_console() {
        let a = Activity::new(false);
        assert!(!is_ready(&a, Some("Listening")));
        assert!(!is_ready(&a, None), "nothing printed yet");
        a.observe(&Event::Console(b"booting\r\n".to_vec()));
        assert!(!is_ready(&a, None), "printed just now");
        *a.last_console.lock().unwrap() = Some(Instant::now() - QUIET);
        assert!(is_ready(&a, None));
        a.observe(&Event::Console(b"Listen".to_vec()));
        a.observe(&Event::Console(b"ing on :4000".to_vec()));
        assert!(is_ready(&a, Some("Listening")), "across console chunks");
        assert!(!shell_up(&a));
        a.observe(&Event::Serial(b"login\r\n# ".to_vec()));
        assert!(shell_up(&a));
    }

    #[test]
    fn extra_cpus_go_offline_and_say_how_many_are_left() {
        let (command, marker) = offline(1, 4);
        assert!(command.starts_with("for c in $(seq 1 3); do echo 0 > /sys/devices/system/cpu/cpu$c/online; done;"));
        assert!(command.ends_with("echo CPUS_$(nproc)_OFF\n"));
        assert_eq!(marker, "CPUS_1_OFF");
        // The typed line's echo doesn't hold the marker
        assert!(!command.contains(&marker));
    }

    #[test]
    fn a_snapshot_is_saved_compressed_with_its_sizes_and_screen() {
        let system = tmp("snapshot-save");
        let state: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let console = b"kernel noise\x1b[2Jiex(1)> \x1b[6n=PROGRESS REPORT==== x\r\n\r\nready";
        save(&system, &state, 12.5, console).unwrap();
        let compressed = std::fs::read(system.join("state.bin.zst")).unwrap();
        assert!(compressed.len() < state.len() / 10);
        // A zstd frame with its size in it, as a restore streams it
        assert_eq!(zstd::stream::decode_all(&compressed[..]).unwrap(), state);
        assert_eq!(zstd::zstd_safe::get_frame_content_size(&compressed).ok(), Some(Some(state.len() as u64)));
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(system.join("run-meta.json")).unwrap()).unwrap();
        assert_eq!(meta, json!({ "bootSeconds": 12.5, "stateBytes": 300_000, "snapshotBytes": compressed.len() }));
        assert_eq!(std::fs::read(system.join("console.bin")).unwrap(), b"iex(1)> ready");
        // Nowhere to write it
        assert!(save(&system.join("missing"), &state, 0.0, b"").is_err());
        assert!(write_json(&system.join("missing/x.json"), &json!({})).err().unwrap().contains("missing/x.json"));
    }

    /// An app on a machine that never runs, played by the test: each command typed is answered
    /// by fetching `fetch` and printing the next answer.
    fn app(board: Arc<armless::Board>, activity: Arc<Activity>, answers: Vec<(&'static str, &'static [u8])>) {
        std::thread::spawn(move || {
            let mut typed = 0;
            for (fetch, answer) in answers {
                let begun = Instant::now();
                while board.console_pending() == typed {
                    assert!(begun.elapsed() < Duration::from_secs(10), "nothing typed");
                    std::thread::sleep(Duration::from_millis(2));
                }
                typed = board.console_pending();
                activity.observe(&Event::Blob(fetch.into()));
                activity.observe(&Event::Console(answer.to_vec()));
            }
        });
    }

    #[test]
    fn exercises_record_what_each_command_printed_and_fetched() {
        let (board, runner) = testing::machine("snapshot-exercise");
        let activity = Activity::new(false);
        activity.observe(&Event::Console(b"welcome\r\n~ $ ".to_vec()));
        app(board.clone(), activity.clone(), vec![("a", b"ls\r\nbin\r\n~ $ "), ("b", b"pwd\r\n/root\r\n~ $ ")]);
        let (mut transcript, mut reads) = (Vec::new(), Vec::new());
        let begun = Instant::now();
        exercise(&board, &runner, &activity, &["ls".into(), "pwd".into()], &mut transcript, &mut reads);
        // Done at the prompt, not after the long quiet
        assert!(begun.elapsed() < EXERCISE_QUIET * 2, "{:?}", begun.elapsed());
        assert_eq!(
            transcript,
            [json!({ "command": "ls", "output": "ls\r\nbin\r\n~ $ " }), json!({ "command": "pwd", "output": "pwd\r\n/root\r\n~ $ " })]
        );
        assert_eq!(reads, [("ls".to_string(), vec!["a".to_string()]), ("pwd".to_string(), vec!["b".to_string()])]);
        // After the snapshot nothing records reads but the exercises
        assert!(activity.reads.lock().unwrap().is_none());
    }

    #[test]
    fn exercised_before_the_snapshot_what_they_fetch_counts_as_booting_too() {
        let (board, runner) = testing::machine("snapshot-exercise-sandbox");
        let activity = Activity::new(false);
        activity.observe(&Event::Console(b"~ $ ".to_vec()));
        let mut boot = Reads::new();
        boot.insert("boot".to_string());
        *activity.reads.lock().unwrap() = Some(boot);
        app(board.clone(), activity.clone(), vec![("lib", b"x\r\n~ $ ")]);
        let (mut transcript, mut reads) = (Vec::new(), Vec::new());
        exercise(&board, &runner, &activity, &["x".into()], &mut transcript, &mut reads);
        assert_eq!(reads, [("x".to_string(), vec!["lib".to_string()])]);
        let boot: Vec<String> = activity.reads.lock().unwrap().iter().flatten().cloned().collect();
        assert_eq!(boot, ["boot", "lib"]);
        // No exercises: nothing to do
        exercise(&board, &runner, &activity, &[], &mut transcript, &mut reads);
        assert_eq!(transcript.len(), 1);
    }

    #[test]
    fn reads_json_keeps_first_fetched_order_and_every_exercise_in_turn() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let exercises = vec![
            ("ls".to_string(), v(&["z", "a"])),
            ("pwd".to_string(), v(&["m"])),
            ("ls".to_string(), v(&["b", "a"])),
        ];
        let doc = reads_json(v(&["k2", "k1"]), v(&["r"]), &exercises);
        assert_eq!(
            doc,
            json!({
                "boot": ["k2", "k1"],
                "restore": ["r"],
                "exercises": [
                    { "command": "ls", "reads": ["z", "a"] },
                    { "command": "pwd", "reads": ["m"] },
                    { "command": "ls", "reads": ["b", "a"] },
                ],
                // By command, a command typed twice keeping what each time fetched
                "exercise": { "ls": ["z", "a", "b"], "pwd": ["m"] },
            })
        );
    }

    #[test]
    fn settling_records_what_the_machine_fetches_on_its_own_until_it_is_quiet() {
        let (board, runner) = testing::machine("snapshot-settle");
        let activity = Activity::new(false);
        let a = activity.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            a.observe(&Event::Blob("wal".into()));
            a.observe(&Event::Blob("stats".into()));
            a.observe(&Event::Blob("wal".into()));
        });
        let begun = Instant::now();
        assert_eq!(settle(&runner, &activity), ["wal", "stats"]);
        assert!(begun.elapsed() >= SETTLE_QUIET && begun.elapsed() < SETTLE_CAP, "{:?}", begun.elapsed());
        assert!(activity.reads.lock().unwrap().is_none(), "recording stops");
        drop(board);
    }

    #[test]
    fn the_prompt_is_the_screens_last_line() {
        assert_eq!(prompt(b"motd\r\n~ $ "), Some(b"~ $ ".to_vec()));
        assert_eq!(prompt(b"\x1b[2J\r\niex(1)> "), Some(b"iex(1)> ".to_vec()));
        // A screen ending in a new line, or with nothing on its last one: no prompt to wait for
        assert_eq!(prompt(b"loading\r\n"), None);
        assert_eq!(prompt(b""), None);
    }

    #[test]
    fn an_exercise_is_done_at_its_prompt_or_after_a_quiet_while() {
        let p = Some(&b"~ $ "[..]);
        let ms = Duration::from_millis;
        // Back at the prompt, and quiet a moment
        assert!(exercised(b"echo hi\r\nhi\r\n~ $ ", p, ms(300)));
        assert!(!exercised(b"echo hi\r\nhi\r\n~ $ ", p, ms(100)));
        // Not back at it (still running, or only the echo so far): the long quiet
        assert!(!exercised(b"sleep 9; echo hi\r\n", p, ms(2000)));
        assert!(exercised(b"sleep 9; echo hi\r\n", p, ms(2500)));
        // A prompt that changes: the long quiet
        assert!(!exercised(b"1 + 1\r\n2\r\niex(2)> ", Some(&b"iex(1)> "[..]), ms(1000)));
        assert!(exercised(b"x", None, ms(2500)));
    }

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn a_boot_that_does_nothing_for_long_enough_has_stalled() {
        let t0 = Instant::now();
        let mut s = Stall::new(secs(300), t0);
        // Printing, then nothing: stalled 300 s after the last output
        assert!(!s.observe(t0 + secs(10), 500, secs(10), false));
        assert!(!s.observe(t0 + secs(309), 500, secs(309), false));
        assert!(s.observe(t0 + secs(310), 500, secs(310), false));
    }

    #[test]
    fn output_fetches_traffic_and_busy_cpus_are_progress() {
        let t0 = Instant::now();
        let mut s = Stall::new(secs(300), t0);
        // A file fetched or network traffic 100 s ago: 200 s quiet, not 400
        assert!(!s.observe(t0 + secs(400), 0, secs(100), false));
        // Computing silently (a JVM starting) is not a stall, however long
        assert!(!s.observe(t0 + secs(1000), 0, secs(1000), true));
        assert!(!s.observe(t0 + secs(1200), 0, secs(1200), false));
        assert!(s.observe(t0 + secs(1300), 0, secs(1300), false));
        // New output starts the count again
        assert!(!s.observe(t0 + secs(1301), 1, secs(1301), false));
    }

    #[test]
    fn the_stall_limit_is_seconds_and_0_turns_it_off() {
        assert_eq!(stall_after(None), Ok(Some(STALL)));
        assert_eq!(stall_after(Some("")), Ok(Some(STALL)));
        assert_eq!(stall_after(Some("20")), Ok(Some(secs(20))));
        assert_eq!(stall_after(Some("0")), Ok(None));
        assert!(stall_after(Some("5m")).is_err());
    }

    #[test]
    fn a_cpu_line_says_where_it_is_and_when_its_timers_fire() {
        let mut sys = armless::cpu::SysRegs::default();
        let tick_ms = armless::board::TIMER_FREQ_HZ / 1000;
        sys.cntv_ctl = 1; // on
        sys.cntv_cval = 1_000_000 + 4 * tick_ms;
        sys.cntp_ctl = 0b11; // on, masked
        sys.cntp_cval = 1_000_000 - tick_ms;
        let line = describe_cpu(2, &sys, 0xffff_8000_1234_5678, 0xffff_8000_0000_0010, 1, 0, 42, 1_000_000);
        assert_eq!(
            line,
            "cpu2: pc=0xffff800012345678 lr=0xffff800000000010 el1 I=0 insns=42 cntv=+4.0ms cntp=-1.0ms masked"
        );
        sys.cntv_ctl = 0;
        assert!(describe_cpu(0, &sys, 0, 0, 0, 1 << 7, 0, 0).contains("I=1 insns=0 cntv=off"));
    }
}
