//! What a job may use, past its time limit: every one off unless asked for, the same as a flag of
//! a one-shot job (`./site --workspace DIR --cmd C --disk-limit 256`) and as a field of a request
//! to a serving process (`{"workspace": ..., "disk_limit_mb": 256}`), where each forked job gets
//! its own.
//!
//! | flag | field | what |
//! |---|---|---|
//! | `--disk-limit MB` | `disk_limit_mb` | what the guest's file writes may hold (its filesystem is in this process's memory): past it, ENOSPC (`disk_full`) |
//! | `--max-rss MB` | `max_rss_mb` | this process's (or the forked job's) resident memory: past it the job ends at once (`oom`, exit 137) |
//! | `--memory-limit MB` | `memory_limit_mb` | the command's memory in the guest (cgroup v2 `memory.max`): an OOM kill there ends it with 137 (`oom`) |
//! | `--cpus-limit N` | `cpus_limit` | the command's CPUs in the guest (`cpu.max`, N may be fractional) |
//! | `--pids-limit N` | `pids_limit` | the command's processes and threads in the guest (`pids.max`) |
//! | `--cpu-time S` | `cpu_time_s` | this process's CPU time, every thread of the emulator: past it the job ends (`cpu_time_exceeded`, exit 152), RLIMIT_CPU a little after as the backstop |
//! | `--output-limit BYTES` | `output_limit` | what the command prints: past it it is killed and what it printed cut there (`output_truncated`, exit 153) |
//! | `--copy-limit MB` | `copy_limit_mb` | the workspace copied in and `out/` copied back, each (default 2048) |
//! | `--read-only-in` | `read_only_in` | the workspace's `in/` is mounted read-only in the guest |
//! | `--egress MODE` | `egress` | none, https, internet or private; a forked job's at most its server's |
//!
//! The guest's limits (memory, CPUs, pids, read-only in/) need a kernel built with cgroup v2 (a
//! site built by this snowglobe): a job asking for one on a guest that can't enforce it fails,
//! saying so, rather than running without it. A site with no kernel can't have them at all.

use std::time::Duration;

use serde_json::{json, Value};

use crate::Args;

/// `out/` and the workspace copy, each, unless asked otherwise (MB)
pub const COPY_MB: u64 = 2048;

/// What a job may use (see the module's table). The default is no limit but the copy limit.
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub disk_mb: Option<u64>,
    pub max_rss_mb: Option<u64>,
    pub memory_mb: Option<u64>,
    pub cpus: Option<f64>,
    pub pids: Option<u64>,
    pub cpu_time_s: Option<u64>,
    pub output: Option<u64>,
    pub copy_mb: u64,
    pub read_only_in: bool,
    /// A job's own egress (serve mode; a one-shot job's is its run's, `--egress`)
    pub egress: Option<Egress>,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            disk_mb: None,
            max_rss_mb: None,
            memory_mb: None,
            cpus: None,
            pids: None,
            cpu_time_s: None,
            output: None,
            copy_mb: COPY_MB,
            read_only_in: false,
            egress: None,
        }
    }
}

/// Where a guest's TCP may go, least first: nothing; HTTPS (TCP 443) to public addresses;
/// anything public; anything, private addresses and loopback too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Egress {
    None,
    Https,
    Internet,
    Private,
}

impl Egress {
    pub fn parse(s: &str) -> Result<Egress, String> {
        match s {
            "none" => Ok(Egress::None),
            "https" => Ok(Egress::Https),
            "internet" => Ok(Egress::Internet),
            "private" => Ok(Egress::Private),
            other => Err(format!("egress {other}: none, https, internet or private")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Egress::None => "none",
            Egress::Https => "https",
            Egress::Internet => "internet",
            Egress::Private => "private",
        }
    }
}

/// The flags of a job's limits that take a value (`RUN_FLAGS` has them)
#[cfg(test)]
const FLAGS: &[&str] = &[
    "disk-limit",
    "max-rss",
    "memory-limit",
    "cpus-limit",
    "pids-limit",
    "cpu-time",
    "output-limit",
    "copy-limit",
    "status-file",
];

fn positive(what: &str, v: Option<u64>) -> Result<Option<u64>, String> {
    match v {
        Some(0) => Err(format!("{what}: more than 0")),
        v => Ok(v),
    }
}

impl Limits {
    /// A one-shot job's (or a `--server` client's) limits, from its flags.
    pub fn from_args(a: &Args) -> Result<Limits, String> {
        let num = |flag: &str| -> Result<Option<u64>, String> {
            a.get(flag)
                .map(|v| v.parse::<u64>().map_err(|_| format!("--{flag}: a whole number")))
                .transpose()
                .and_then(|v| positive(&format!("--{flag}"), v))
        };
        let cpus = a
            .get("cpus-limit")
            .map(|v| v.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0).ok_or("--cpus-limit: a number of CPUs, more than 0"))
            .transpose()?;
        Ok(Limits {
            disk_mb: num("disk-limit")?,
            max_rss_mb: num("max-rss")?,
            memory_mb: num("memory-limit")?,
            cpus,
            pids: num("pids-limit")?,
            cpu_time_s: num("cpu-time")?,
            output: num("output-limit")?,
            copy_mb: num("copy-limit")?.unwrap_or(COPY_MB),
            read_only_in: a.has("read-only-in"),
            egress: a.get("egress").map(Egress::parse).transpose().map_err(|e| format!("--{e}"))?,
        })
    }

    /// A request's limits, from its fields (absent or null: none).
    pub fn from_json(v: &Value) -> Result<Limits, String> {
        let num = |key: &str| -> Result<Option<u64>, String> {
            match &v[key] {
                Value::Null => Ok(None),
                n => n.as_u64().map(Some).ok_or_else(|| format!("{key}: a whole number")).and_then(|n| positive(key, n)),
            }
        };
        let cpus = match &v["cpus_limit"] {
            Value::Null => None,
            n => Some(n.as_f64().filter(|n| n.is_finite() && *n > 0.0).ok_or("cpus_limit: a number of CPUs, more than 0")?),
        };
        let read_only_in = match &v["read_only_in"] {
            Value::Null => false,
            b => b.as_bool().ok_or("read_only_in: true or false")?,
        };
        let egress = match &v["egress"] {
            Value::Null => None,
            e => Some(Egress::parse(e.as_str().ok_or("egress: a string")?)?),
        };
        Ok(Limits {
            disk_mb: num("disk_limit_mb")?,
            max_rss_mb: num("max_rss_mb")?,
            memory_mb: num("memory_limit_mb")?,
            cpus,
            pids: num("pids_limit")?,
            cpu_time_s: num("cpu_time_s")?,
            output: num("output_limit")?,
            copy_mb: num("copy_limit_mb")?.unwrap_or(COPY_MB),
            read_only_in,
            egress,
        })
    }

    /// As a request's fields (what `--server` sends): only those set.
    pub fn to_json(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                m.insert(k.into(), v);
            }
        };
        put("disk_limit_mb", self.disk_mb.map(Value::from));
        put("max_rss_mb", self.max_rss_mb.map(Value::from));
        put("memory_limit_mb", self.memory_mb.map(Value::from));
        put("cpus_limit", self.cpus.map(Value::from));
        put("pids_limit", self.pids.map(Value::from));
        put("cpu_time_s", self.cpu_time_s.map(Value::from));
        put("output_limit", self.output.map(Value::from));
        put("copy_limit_mb", (self.copy_mb != COPY_MB).then_some(Value::from(self.copy_mb)));
        put("read_only_in", self.read_only_in.then_some(Value::from(true)));
        put("egress", self.egress.map(|e| Value::from(e.name())));
        m
    }

    /// Whether the guest must enforce any of them (a cgroup of the job's own, or a mount)
    pub fn in_guest(&self) -> bool {
        self.memory_mb.is_some() || self.cpus.is_some() || self.pids.is_some() || self.read_only_in
    }

    /// Whether any is a cgroup's
    pub fn cgroup(&self) -> bool {
        self.memory_mb.is_some() || self.cpus.is_some() || self.pids.is_some()
    }

    /// Whether this process is to watch itself (its memory, its CPU time, the job's output)
    pub fn watched(&self) -> bool {
        self.max_rss_mb.is_some() || self.cpu_time_s.is_some() || self.output.is_some()
    }

    pub fn copy_bytes(&self) -> u64 {
        self.copy_mb.saturating_mul(1 << 20)
    }

    /// The process's own limits that the system enforces: RLIMIT_CPU, a little past the CPU time
    /// the job watches for (`Guard`), which it ends at first, saying so.
    pub fn apply_to_process(&self) -> Result<(), String> {
        if let Some(s) = self.cpu_time_s {
            crate::sys::limit_cpu_time(s + 2, s + 5).map_err(|e| format!("cpu_time_s: RLIMIT_CPU: {e}"))?;
        }
        Ok(())
    }
}

/// Why a job was ended from the host, not by its command or its time
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Abort {
    /// This process's memory went past `max_rss_mb`
    Rss,
    /// Its CPU time went past `cpu_time_s`
    CpuTime,
}

/// What a job's process watches of itself while the job runs.
pub struct Guard {
    max_rss: Option<u64>,
    cpu: Option<Duration>,
    /// A machine's job (`from_now`): CPU time counted from here
    since: Option<Duration>,
}

impl Guard {
    pub fn new(l: &Limits) -> Guard {
        Guard { max_rss: l.max_rss_mb.map(|m| m << 20), cpu: l.cpu_time_s.map(Duration::from_secs), since: None }
    }

    /// A job on a running machine (its control socket), whose process isn't the job's own: its
    /// CPU time counts from now. Its memory is the machine's, at its most (what the sandbox lets a
    /// process see of itself): a machine once past `max_rss_mb` is past it for every later job.
    pub fn from_now(l: &Limits) -> Guard {
        Guard { since: Some(crate::sys::usage().1), ..Guard::new(l) }
    }

    /// Past a limit: which. The memory is the most this process has had resident (getrusage: on
    /// Linux a forked job's counts what it shares with its server, from the fork on); the CPU
    /// time is every thread's since this process began.
    pub fn check(&self) -> Option<Abort> {
        if self.max_rss.is_none() && self.cpu.is_none() {
            return None;
        }
        let (peak, cpu) = crate::sys::usage();
        let cpu = self.since.map_or(cpu, |s| cpu.saturating_sub(s));
        if self.max_rss.is_some_and(|m| peak > m) {
            return Some(Abort::Rss);
        }
        if self.cpu.is_some_and(|c| cpu > c) {
            return Some(Abort::CpuTime);
        }
        None
    }
}

/// What a site with no kernel can't have
pub const NO_KERNEL: &str =
    "memory_limit_mb, cpus_limit, pids_limit and read_only_in need a guest kernel: this site has none (snowglobe build --kernel none)";

/// What a job on a running machine's control socket can't have: an egress of its own. The
/// machine's network is set when it starts (its `--egress`, or its spawn's), and every job on it
/// shares it, so a job may only ask for that one (or none, taking it). Past `max_rss_mb` or
/// `cpu_time_s` such a job is killed and the machine goes on (`Guard::from_now`).
pub fn for_instance(l: &Limits, machine: Egress) -> Result<(), String> {
    match l.egress {
        Some(e) if e != machine => Err(format!(
            "egress {}: this machine's network is {} for every job on it (ask for its egress when it starts)",
            e.name(),
            machine.name()
        )),
        _ => Ok(()),
    }
}

/// A one-shot job's result, unambiguously (`--status-file`): its fields as a serving process's
/// answer has them, and the exit status the run ends with.
pub fn status_json(d: &crate::job::Done, exit: u8) -> Value {
    let mut m = crate::job::result_fields(d);
    m.insert("exit".into(), exit.into());
    Value::Object(m)
}

/// `--status-file`: made (empty) before the sandbox, so the sandbox needn't let the process
/// write where it is, and written once, as the run ends. Left empty, the run ended before its job
/// did (killed from outside).
pub struct StatusFile(std::fs::File);

impl StatusFile {
    pub fn create(path: &std::path::Path) -> Result<StatusFile, String> {
        std::fs::File::create(path).map(StatusFile).map_err(|e| format!("--status-file {}: {e}", path.display()))
    }

    fn put(mut self, v: &Value) {
        use std::io::Write;
        let _ = self.0.write_all(format!("{v}\n").as_bytes());
        let _ = self.0.sync_data();
    }

    /// The job's result
    pub fn done(self, d: &crate::job::Done, exit: u8) {
        self.put(&status_json(d, exit));
    }

    /// A run that failed: `{"error", "exit": 1}`
    pub fn error(self, e: &str) {
        self.put(&json!({ "error": e, "exit": 1 }));
    }
}

/// The run's status file, from where it begins to wherever it ends
static STATUS_FILE: std::sync::Mutex<Option<StatusFile>> = std::sync::Mutex::new(None);

pub fn open_status_file(path: &std::path::Path) -> Result<(), String> {
    *STATUS_FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(StatusFile::create(path)?);
    Ok(())
}

fn take_status_file() -> Option<StatusFile> {
    STATUS_FILE.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// The job's result into the run's status file, if there is one.
pub fn write_status(d: &crate::job::Done, exit: u8) {
    if let Some(f) = take_status_file() {
        f.done(d, exit);
    }
}

/// A run that failed into its status file, if there is one and it hasn't been written.
pub fn write_status_error(e: &str) {
    if let Some(f) = take_status_file() {
        f.error(e);
    }
}

/// Why a job didn't end by itself, on stderr.
pub fn say_why(d: &crate::job::Done, timeout: Duration) {
    if d.status.is_some() {
        if d.oom {
            eprintln!("snowglobe: the job ran out of memory (memory_limit_mb)");
        }
        return;
    }
    if d.oom {
        eprintln!("snowglobe: the job went past its memory (max_rss_mb)");
    } else if d.cpu_time_exceeded {
        eprintln!("snowglobe: the job went past its CPU time (cpu_time_s)");
    } else if d.output_truncated {
        eprintln!("snowglobe: the job printed more than its output limit");
    } else if !d.cancelled {
        eprintln!("snowglobe: the job ran out of time ({}s)", timeout.as_secs_f64());
    }
}

/// The exit status of a run that was a job: the command's own when it ended by itself (a guest
/// OOM kill is its 137), else what ended it: 137 out of memory (`--max-rss`), 152 out of CPU
/// time (128 + SIGXCPU), 153 past its output limit (128 + SIGXFSZ), 124 out of time or stopped.
pub fn exit_code(d: &crate::job::Done) -> u8 {
    if let Some(s) = d.status {
        return s.clamp(0, 255) as u8;
    }
    if d.oom {
        137
    } else if d.cpu_time_exceeded {
        152
    } else if d.output_truncated {
        153
    } else {
        124
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        Args::parse(&v, crate::RUN_FLAGS).unwrap()
    }

    #[test]
    fn every_limit_flag_takes_its_value() {
        for f in FLAGS {
            assert!(crate::RUN_FLAGS.contains(f), "{f}");
        }
    }

    #[test]
    fn the_status_file_has_the_result_or_the_error() {
        let d = crate::testing::tmp("status-file");
        let p = d.join("status.json");
        let f = StatusFile::create(&p).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"", "made empty first");
        f.done(&crate::job::Done { status: Some(4), output_truncated: true, ..crate::job::Done::default() }, 4);
        let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["status"], 4);
        assert_eq!(v["exit"], 4);
        assert_eq!(v["output_truncated"], true);
        for k in ["timed_out", "killed", "oom", "disk_full", "ms"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert!(StatusFile::create(&d.join("missing/status.json")).err().unwrap().starts_with("--status-file "));
        let f = StatusFile::create(&d.join("error.json")).unwrap();
        f.error("no such site");
        let v: Value = serde_json::from_slice(&std::fs::read(d.join("error.json")).unwrap()).unwrap();
        assert_eq!((v["error"].as_str(), v["exit"].as_u64()), (Some("no such site"), Some(1)));
    }

    #[test]
    fn an_instance_job_has_its_machines_egress() {
        assert!(for_instance(&Limits::default(), Egress::Https).is_ok());
        assert!(for_instance(&Limits { max_rss_mb: Some(1), cpu_time_s: Some(1), ..Limits::default() }, Egress::None).is_ok());
        assert!(for_instance(&Limits { egress: Some(Egress::Https), ..Limits::default() }, Egress::Https).is_ok());
        let e = for_instance(&Limits { egress: Some(Egress::None), ..Limits::default() }, Egress::Https).err().unwrap();
        assert!(e.starts_with("egress none: this machine's network is https"), "{e}");
        assert!(for_instance(&Limits { egress: Some(Egress::Internet), ..Limits::default() }, Egress::Https).is_err());
    }

    #[test]
    fn nothing_is_limited_unless_asked_but_the_copy() {
        let l = Limits::from_args(&args(&[])).unwrap();
        assert_eq!(l, Limits::default());
        assert_eq!(l.copy_bytes(), COPY_MB << 20);
        assert!(!l.in_guest() && !l.watched() && !l.cgroup());
        assert_eq!(Limits::from_json(&json!({"cmd": "x"})).unwrap(), Limits::default());
        assert!(l.to_json().is_empty());
    }

    #[test]
    fn flags_and_fields_say_the_same() {
        let a = args(&[
            "--disk-limit", "64", "--max-rss", "512", "--memory-limit", "128", "--cpus-limit", "0.5", "--pids-limit", "32",
            "--cpu-time", "10", "--output-limit", "1000", "--copy-limit", "8", "--read-only-in", "--egress", "https",
        ]);
        let l = Limits::from_args(&a).unwrap();
        let want = Limits {
            disk_mb: Some(64),
            max_rss_mb: Some(512),
            memory_mb: Some(128),
            cpus: Some(0.5),
            pids: Some(32),
            cpu_time_s: Some(10),
            output: Some(1000),
            copy_mb: 8,
            read_only_in: true,
            egress: Some(Egress::Https),
        };
        assert_eq!(l, want);
        assert!(l.in_guest() && l.watched() && l.cgroup());
        // What a client sends is what a server reads
        let sent = Value::Object(l.to_json());
        assert_eq!(sent["disk_limit_mb"], 64);
        assert_eq!(sent["cpus_limit"], 0.5);
        assert_eq!(sent["egress"], "https");
        assert_eq!(Limits::from_json(&sent).unwrap(), want);
    }

    #[test]
    fn bad_limits_say_what_is_wrong() {
        let e = |v: &[&str]| Limits::from_args(&args(v)).err().unwrap();
        assert_eq!(e(&["--disk-limit", "lots"]), "--disk-limit: a whole number");
        assert_eq!(e(&["--disk-limit", "0"]), "--disk-limit: more than 0");
        assert_eq!(e(&["--cpus-limit", "0"]), "--cpus-limit: a number of CPUs, more than 0");
        assert_eq!(e(&["--cpus-limit", "NaN"]), "--cpus-limit: a number of CPUs, more than 0");
        assert_eq!(e(&["--egress", "some"]), "--egress some: none, https, internet or private");
        let j = |v: Value| Limits::from_json(&v).err().unwrap();
        assert_eq!(j(json!({"disk_limit_mb": -1})), "disk_limit_mb: a whole number");
        assert_eq!(j(json!({"output_limit": "10"})), "output_limit: a whole number");
        assert_eq!(j(json!({"pids_limit": 0})), "pids_limit: more than 0");
        assert_eq!(j(json!({"read_only_in": "yes"})), "read_only_in: true or false");
        assert_eq!(j(json!({"egress": 1})), "egress: a string");
    }

    #[test]
    fn egress_goes_from_least_to_most() {
        assert!(Egress::None < Egress::Https && Egress::Https < Egress::Internet && Egress::Internet < Egress::Private);
        for e in [Egress::None, Egress::Https, Egress::Internet, Egress::Private] {
            assert_eq!(Egress::parse(e.name()), Ok(e));
        }
    }

    #[test]
    fn a_job_ended_from_the_host_says_why_in_its_exit_status() {
        use crate::job::Done;
        assert_eq!(exit_code(&Done { status: Some(3), ..Done::default() }), 3);
        // A guest OOM kill is the command's own 137
        assert_eq!(exit_code(&Done { status: Some(137), oom: true, ..Done::default() }), 137);
        assert_eq!(exit_code(&Done { oom: true, killed: true, ..Done::default() }), 137);
        assert_eq!(exit_code(&Done { cpu_time_exceeded: true, ..Done::default() }), 152);
        assert_eq!(exit_code(&Done { output_truncated: true, killed: true, ..Done::default() }), 153);
        assert_eq!(exit_code(&Done { timed_out: true, ..Done::default() }), 124);
        let s = status_json(&Done { status: Some(0), disk_full: true, ms: 5, ..Done::default() }, 0);
        assert_eq!(s["status"], 0);
        assert_eq!(s["disk_full"], true);
        assert_eq!(s["oom"], false);
        assert_eq!(s["output_truncated"], false);
        assert_eq!(s["ms"], 5);
    }

    #[test]
    fn the_guard_sees_this_process() {
        assert_eq!(Guard::new(&Limits::default()).check(), None);
        // This test process has more than 1 MB resident
        assert_eq!(Guard::new(&Limits { max_rss_mb: Some(1), ..Limits::default() }).check(), Some(Abort::Rss));
        assert_eq!(Guard::new(&Limits { max_rss_mb: Some(1 << 30), ..Limits::default() }).check(), None);
        // A machine's job: its CPU time from now, which is next to none yet
        assert_eq!(Guard::from_now(&Limits { cpu_time_s: Some(1), ..Limits::default() }).check(), None);
        assert_eq!(Guard::from_now(&Limits { max_rss_mb: Some(1), ..Limits::default() }).check(), Some(Abort::Rss));
    }
}
