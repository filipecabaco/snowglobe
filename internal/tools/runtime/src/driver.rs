//! A run driven from outside, by a program rather than a person: it ends when told to or when its
//! time is up, whatever the guest is doing, and says why.
//!
//! - `--max-runtime SECS`: the run ends after this long (exit 124)
//! - `--stop-file PATH` (repeatable): the run ends once PATH exists (exit 143); a driver creates it
//!   to stop the run, from anywhere, without a socket or a signal
//!
//! Either way the running job is killed in the guest (its whole session: `job`), what the run
//! learned is saved, a `stop` event with the reason and exit status goes to the logs (`log`), and
//! the process exits. Ends of other kinds are logged the same way (`finish`).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::{job, log, term, Args};

pub const EXIT_MAX_RUNTIME: u8 = 124;
pub const EXIT_STOPPED: u8 = 143;
/// How often the stop file and the clock are looked at
const POLL: Duration = Duration::from_millis(200);
/// How long a stop waits for the running job to be killed
const JOB_GRACE: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct Controls {
    pub stop_files: Vec<PathBuf>,
    pub max_runtime: Option<Duration>,
}

impl Controls {
    pub fn from_args(args: &Args) -> Result<Controls, String> {
        let max_runtime = match args.get("max-runtime") {
            Some(s) => {
                let secs: f64 = s.parse().map_err(|_| format!("--max-runtime {s}: seconds"))?;
                if !(secs > 0.0 && secs.is_finite()) {
                    return Err(format!("--max-runtime {s}: more than 0 seconds"));
                }
                Some(Duration::from_secs_f64(secs))
            },
            None => None,
        };
        let stop_files = args
            .all("stop-file")
            .iter()
            .map(|p| std::path::absolute(p).map_err(|e| format!("--stop-file {p}: {e}")))
            .collect::<Result<_, _>>()?;
        Ok(Controls { stop_files, max_runtime })
    }

    /// Why the run must end now, if it must: the reason and the exit status.
    pub fn due(&self, started: Instant) -> Option<(&'static str, u8)> {
        if self.stop_files.iter().any(|p| p.exists()) {
            return Some(("stop-file", EXIT_STOPPED));
        }
        if self.max_runtime.is_some_and(|m| started.elapsed() >= m) {
            return Some(("max-runtime", EXIT_MAX_RUNTIME));
        }
        None
    }

    /// The directories the sandbox must let the run look in for the stop files.
    pub fn read_paths(&self) -> Vec<PathBuf> {
        self.stop_files.iter().filter_map(|p| p.parent().map(|d| d.to_path_buf())).collect()
    }

    pub fn active(&self) -> bool {
        !self.stop_files.is_empty() || self.max_runtime.is_some()
    }
}

static STOPPED: OnceLock<(&'static str, u8)> = OnceLock::new();
type OnStop = Box<dyn FnOnce() + Send>;
static ON_STOP: Mutex<Vec<OnStop>> = Mutex::new(Vec::new());

/// The reason and exit status the run was stopped with, once it has been.
pub fn stopped() -> Option<(&'static str, u8)> {
    STOPPED.get().copied()
}

/// Something to do before a stop exits (save what the run learned).
pub fn on_stop(f: OnStop) {
    ON_STOP.lock().unwrap().push(f);
}

/// Log how the run ended and return its exit status.
pub fn finish(reason: &str, code: u8) -> u8 {
    log::event("stop", json!({ "reason": reason, "exit": code }));
    if let Some(l) = log::get() {
        l.sync();
    }
    code
}

/// The run ends of itself (`reason`): logged, unless a stop is under way, which is the end that
/// counts (this thread then waits for it to exit the process).
pub fn end(reason: &str, code: u8) -> u8 {
    if stopped().is_some() {
        loop {
            std::thread::park();
        }
    }
    finish(reason, code)
}

/// End the run now: kill the running job, save, log, exit.
pub fn stop(reason: &'static str, code: u8) -> ! {
    if STOPPED.set((reason, code)).is_ok() {
        job::stop_all();
        if !job::wait_idle(JOB_GRACE) {
            log::event("stop_job_stuck", json!({ "waited_s": JOB_GRACE.as_secs() }));
        }
        for f in std::mem::take(&mut *ON_STOP.lock().unwrap()) {
            f();
        }
        finish(reason, code);
        term::restore();
        eprintln!("snowglobe: stopped ({reason})");
        std::process::exit(code as i32);
    }
    // Another thread is stopping the run already
    loop {
        std::thread::park();
    }
}

/// Watch the stop files and the clock from a thread of its own.
pub fn watch(c: Controls, started: Instant) {
    if !c.active() {
        return;
    }
    std::thread::spawn(move || loop {
        if let Some((reason, code)) = c.due(started) {
            stop(reason, code);
        }
        std::thread::sleep(POLL);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        Args::parse(&v, crate::RUN_FLAGS).unwrap()
    }

    #[test]
    fn a_stop_file_appearing_ends_the_run() {
        let dir = std::env::temp_dir().join(format!("sgstop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("stop");
        let _ = std::fs::remove_file(&file);
        let c = Controls::from_args(&args(&["--stop-file", file.to_str().unwrap()])).unwrap();
        assert!(c.active());
        assert_eq!(c.read_paths(), vec![dir.clone()]);
        let started = Instant::now();
        assert_eq!(c.due(started), None);
        std::fs::write(&file, "").unwrap();
        assert_eq!(c.due(started), Some(("stop-file", EXIT_STOPPED)));
    }

    #[test]
    fn max_runtime_ends_the_run_when_its_time_is_up() {
        let c = Controls::from_args(&args(&["--max-runtime", "0.2"])).unwrap();
        let started = Instant::now();
        assert_eq!(c.due(started), None);
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(c.due(started), Some(("max-runtime", EXIT_MAX_RUNTIME)));
    }

    #[test]
    fn a_run_that_ends_by_itself_exits_with_its_own_status() {
        assert_eq!(stopped(), None);
        assert_eq!(finish("end", 3), 3);
        assert_eq!(end("guest-stopped", 0), 0);
        // Nothing to watch: no thread that could end the run
        watch(Controls::default(), Instant::now());
        assert_eq!(stopped(), None);
    }

    #[test]
    fn controls_are_checked() {
        for bad in ["0", "-1", "soon", "inf", "NaN"] {
            assert!(Controls::from_args(&args(&["--max-runtime", bad])).is_err(), "{bad}");
        }
        assert!(!Controls::from_args(&args(&[])).unwrap().active());
        // A relative stop file is the same file wherever the run looks from
        let c = Controls::from_args(&args(&["--stop-file", "rel/stop"])).unwrap();
        assert!(c.stop_files[0].is_absolute());
    }
}
