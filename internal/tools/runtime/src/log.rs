//! Durable logs (`--log-dir DIR`), for whoever drives the run: they outlive it, a crash included.
//!
//! - `console.log`: everything the app's terminal (hvc0) printed, as printed
//! - `serial.log`: the guest's serial line (ttyS0): the kernel's messages (an OOM kill, a panic)
//!   and the job shell; with no kernel, what the jobs printed
//! - `events.jsonl`: one JSON object a line, each with `t` (Unix seconds) and `event`: `start`,
//!   `restored`, `job_start`, `job_end` (status, timed_out, cancelled, killed, ms, output), `stop`
//!   (reason, exit)
//!
//! Each file is appended to as things happen (an event is also synced to disk) and rotated at
//! `MAX_BYTES`: `x.log` becomes `x.log.1`, `x.log.1` becomes `x.log.2`, up to `KEEP` old files.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub const MAX_BYTES: u64 = 8 << 20;
pub const KEEP: usize = 3;

/// One append-only file, rotated by size.
pub struct Rotating {
    path: PathBuf,
    file: File,
    size: u64,
    max: u64,
    keep: usize,
}

impl Rotating {
    pub fn open(path: &Path, max: u64, keep: usize) -> Result<Rotating, String> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Rotating { path: path.to_path_buf(), file, size, max, keep })
    }

    fn old(&self, n: usize) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(format!(".{n}"));
        p.into()
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        let _ = std::fs::remove_file(self.old(self.keep));
        for n in (1..self.keep).rev() {
            let _ = std::fs::rename(self.old(n), self.old(n + 1));
        }
        if self.keep > 0 {
            std::fs::rename(&self.path, self.old(1))?;
        } else {
            std::fs::remove_file(&self.path)?;
        }
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.size = 0;
        Ok(())
    }

    /// Append, rotating first if this would take the file past its size (a write bigger than
    /// that goes into a file of its own).
    pub fn write(&mut self, b: &[u8]) {
        if self.size > 0 && self.size + b.len() as u64 > self.max && self.rotate().is_err() {
            return;
        }
        if self.file.write_all(b).is_ok() {
            self.size += b.len() as u64;
        }
    }

    pub fn sync(&self) {
        let _ = self.file.sync_data();
    }
}

pub struct Logs {
    console: Mutex<Rotating>,
    serial: Mutex<Rotating>,
    events: Mutex<Rotating>,
}

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

impl Logs {
    pub fn open(dir: &Path) -> Result<Logs, String> {
        Logs::open_sized(dir, MAX_BYTES, KEEP)
    }

    pub fn open_sized(dir: &Path, max: u64, keep: usize) -> Result<Logs, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Logs {
            console: Mutex::new(Rotating::open(&dir.join("console.log"), max, keep)?),
            serial: Mutex::new(Rotating::open(&dir.join("serial.log"), max, keep)?),
            events: Mutex::new(Rotating::open(&dir.join("events.jsonl"), max, keep)?),
        })
    }

    pub fn console(&self, b: &[u8]) {
        self.console.lock().unwrap().write(b);
    }

    pub fn serial(&self, b: &[u8]) {
        self.serial.lock().unwrap().write(b);
    }

    /// An event: `fields` (an object) with `t` and `event` added, on a line of its own, on disk
    /// before this returns.
    pub fn event(&self, event: &str, fields: Value) {
        let mut v = match fields {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        v.insert("t".into(), Value::from((now() * 1000.0).round() / 1000.0));
        v.insert("event".into(), Value::from(event));
        let mut line = Value::Object(v).to_string();
        line.push('\n');
        let mut f = self.events.lock().unwrap();
        f.write(line.as_bytes());
        f.sync();
    }

    pub fn sync(&self) {
        self.console.lock().unwrap().sync();
        self.serial.lock().unwrap().sync();
        self.events.lock().unwrap().sync();
    }
}

static LOGS: OnceLock<Arc<Logs>> = OnceLock::new();

/// The run's logs, once `install`ed.
pub fn get() -> Option<&'static Arc<Logs>> {
    LOGS.get()
}

pub fn install(logs: Logs) -> &'static Arc<Logs> {
    let _ = LOGS.set(Arc::new(logs));
    LOGS.get().unwrap()
}

/// An event, if there are logs.
pub fn event(event: &str, fields: Value) {
    if let Some(l) = get() {
        l.event(event, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sglog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotates_by_size_and_keeps_a_few() {
        let d = tmp("rotate");
        let p = d.join("x.log");
        let mut r = Rotating::open(&p, 10, 2).unwrap();
        for chunk in ["aaaaaa", "bbbbbb", "cccccc", "dddddd"] {
            r.write(chunk.as_bytes());
        }
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "dddddd");
        assert_eq!(std::fs::read_to_string(d.join("x.log.1")).unwrap(), "cccccc");
        assert_eq!(std::fs::read_to_string(d.join("x.log.2")).unwrap(), "bbbbbb");
        assert!(!d.join("x.log.3").exists(), "only KEEP old files");
        // Fits: no rotation
        r.write(b"eeee");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "ddddddeeee");
    }

    #[test]
    fn keeping_none_starts_the_file_over() {
        let d = tmp("keep0");
        let p = d.join("x.log");
        let mut r = Rotating::open(&p, 4, 0).unwrap();
        r.write(b"aaa");
        r.write(b"bbb");
        r.sync();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "bbb");
        assert!(!d.join("x.log.1").exists());
        // A write bigger than the limit goes into a file of its own
        r.write(b"cccccccc");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "cccccccc");
    }

    #[test]
    fn each_stream_has_its_file() {
        let d = tmp("streams");
        let l = Logs::open(&d).unwrap();
        l.console(b"app");
        l.serial(b"kernel");
        // Not an object: the event alone
        l.event("restored", Value::Null);
        l.sync();
        assert_eq!(std::fs::read_to_string(d.join("console.log")).unwrap(), "app");
        assert_eq!(std::fs::read_to_string(d.join("serial.log")).unwrap(), "kernel");
        let e: Value = serde_json::from_str(std::fs::read_to_string(d.join("events.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(e["event"], "restored");
        assert_eq!(e.as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_log_dir_that_cant_be_made_is_an_error() {
        let d = tmp("notadir");
        std::fs::write(d.join("file"), b"").unwrap();
        assert!(Logs::open(&d.join("file")).err().unwrap().contains("file"));
        assert!(Logs::open(&d.join("file/sub")).is_err());
    }

    #[test]
    fn appends_across_opens() {
        let d = tmp("append");
        Logs::open(&d).unwrap().console(b"one ");
        Logs::open(&d).unwrap().console(b"two");
        assert_eq!(std::fs::read_to_string(d.join("console.log")).unwrap(), "one two");
    }

    #[test]
    fn events_are_json_lines() {
        let d = tmp("events");
        let l = Logs::open(&d).unwrap();
        l.event("job_start", serde_json::json!({ "job": "abc", "cmd": "echo \"hi\"\nls" }));
        l.event("stop", serde_json::json!({ "reason": "stop-file", "exit": 143 }));
        let text = std::fs::read_to_string(d.join("events.jsonl")).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["event"], "job_start");
        assert_eq!(lines[0]["cmd"], "echo \"hi\"\nls");
        assert!(lines[0]["t"].as_f64().unwrap() > 1.6e9);
        assert_eq!(lines[1]["exit"], 143);
    }
}
