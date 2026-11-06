//! snowglobe-vm: snowglobe's machine runtime, on the armless AArch64 machine.
//!
//!   snowglobe-vm snapshot <system dir> [--memory MB] [--cpus N] [--network none|fetch]
//!                         [--ready TEXT] [--exercise COMMAND ...]
//!   snowglobe-vm run <site dir> [--blobs DIR] [--detached] [--socket PATH] [--forward PORT:GUEST ...]
//!   snowglobe-vm exec [--socket PATH] <command>
//!   snowglobe-vm attach [--socket PATH]
//!
//! `snapshot` boots a built site's filesystem until the app is up and writes the snapshot the
//! page restores (and what the page and the warm pack need besides). `run` restores a built
//! site headlessly and connects its app console to the terminal, a pipe, or the control socket
//! `exec` and `attach` talk to.

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod b64;
mod driver;
mod image;
mod job;
mod lifeline;
mod log;
mod machine;
mod profile;
mod run;
mod sandbox;
mod serve;
mod site;
mod snapshot;
#[allow(unsafe_code)]
mod sys;
mod term;
mod text;

use std::process::ExitCode;

const SOCKET: &str = "/tmp/snowglobe.sock";

fn usage() -> ExitCode {
    eprintln!(
        "usage:
  snowglobe-vm snapshot <system dir> [--memory MB] [--cpus N] [--network none|fetch]
                        [--ready TEXT] [--exercise COMMAND ...]
                        [--tunnel [HOST:]PORT=URL ...] [--egress none|internet|private] [--allow-private]
  snowglobe-vm run <site dir> [--blobs DIR] [--detached] [--socket PATH] [--forward PORT:GUEST ...]
                   [--tunnel [HOST:]PORT=URL ...] [--egress none|internet|private] [--allow-private] [--record-reads FILE]
                   [--workspace DIR --cmd COMMAND [--env K=V ...] [--env-file JSON] [--timeout SECS]]
                   [--max-runtime SECS] [--stop-file PATH ...] [--log-dir DIR]
                   [--serve SOCKET --jobs-root DIR [--max-jobs N]]   (jobs forked from one restore)
                   [--server SOCKET --workspace DIR --cmd COMMAND ...]  (a job for --serve)
  (a bundle takes run's flags itself: ./site --workspace DIR --cmd COMMAND)
  snowglobe-vm exec [--socket PATH] <command>
  snowglobe-vm attach [--socket PATH]"
    );
    ExitCode::from(2)
}

/// Flags and positional arguments, in any order.
pub struct Args {
    pub positional: Vec<String>,
    pub flags: Vec<(String, String)>,
    pub switches: Vec<String>,
}

impl Args {
    pub fn parse(args: &[String], with_value: &[&str]) -> Result<Args, String> {
        let mut a = Args {
            positional: Vec::new(),
            flags: Vec::new(),
            switches: Vec::new(),
        };
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            if let Some(name) = arg.strip_prefix("--") {
                if with_value.contains(&name) {
                    let v = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
                    a.flags.push((name.to_string(), v.clone()));
                } else {
                    a.switches.push(name.to_string());
                }
            } else {
                a.positional.push(arg.clone());
            }
        }
        Ok(a)
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.flags.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn all(&self, name: &str) -> Vec<String> {
        self.flags.iter().filter(|(k, _)| k == name).map(|(_, v)| v.clone()).collect()
    }

    pub fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name)
    }
}

pub const RUN_FLAGS: &[&str] = &["egress", "max-runtime", "stop-file", "log-dir", "blobs", "socket", "forward", "tunnel", "record-reads", "workspace", "cmd", "env", "env-file", "timeout", "serve", "jobs-root", "max-jobs", "max-machines", "state", "server"];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // What started this (the daemon, a build) may have tied this process to its own life: taken
    // now, before any thread, and watched where each command can (lifeline.rs)
    lifeline::take_inherited();
    // A bundle runs the site it carries: its arguments are run's (exec and attach still work)
    if let Some(site) = site::Site::this_bundle() {
        if !matches!(args.first().map(String::as_str), Some("exec" | "attach")) {
            return finish(Args::parse(&args, RUN_FLAGS).and_then(|a| run::main(&a, Some(site))));
        }
    }
    let Some((command, rest)) = args.split_first() else {
        return usage();
    };
    let result = match command.as_str() {
        "snapshot" => {
            // A build's boot: it ends with the build that started it, however that ends
            if let Some(line) = lifeline::inherited() {
                lifeline::watch(line, || lifeline::stop("the build that started this snapshot"));
            }
            Args::parse(rest, &["memory", "cpus", "build-cpus", "network", "ready", "exercise", "cols", "rows", "tunnel"])
                .and_then(|a| snapshot::main(&a))
        },
        "run" => Args::parse(rest, RUN_FLAGS).and_then(|a| run::main(&a, None)),
        "sandbox-check" => sandbox::check(rest.iter().any(|a| a == "--forked")),
        "exec" => {
            // Everything after the flags is the command, as typed
            let (socket, words) = match rest.first().map(String::as_str) {
                Some("--socket") if rest.len() >= 2 => (rest[1].clone(), &rest[2..]),
                _ => (SOCKET.to_string(), rest),
            };
            run::client_exec(&socket, &words.join(" "))
        },
        "attach" => Args::parse(rest, &["socket"])
            .and_then(|a| run::client_attach(a.get("socket").unwrap_or(SOCKET))),
        "-h" | "--help" | "help" => return usage(),
        _ => return usage(),
    };
    finish(result)
}

fn finish(result: Result<u8, String>) -> ExitCode {
    match result {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            term::restore();
            eprintln!("snowglobe-vm: {e}");
            ExitCode::from(1)
        },
    }
}

/// What the tests of several modules share: scratch directories, a site, a machine that is made
/// but never started (its devices, filesystem and CPUs are there; no guest code runs).
#[cfg(test)]
mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use crate::machine::{self, Spec};
    use crate::site::Site;

    /// A filesystem.json with nothing in it
    pub const EMPTY_FS: &[u8] = br#"{"version":3,"size":0,"fsroot":[]}"#;

    /// A fresh, empty directory for one test.
    pub fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sgtest-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Write `files` (paths relative to `root`), making their directories.
    pub fn write(root: &Path, files: &[(&str, &[u8])]) {
        for (rel, data) in files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, data).unwrap();
        }
    }

    /// A site directory with its own blobs and `files` besides.
    pub fn site(name: &str, files: &[(&str, &[u8])]) -> (PathBuf, Site) {
        let root = tmp(name);
        std::fs::create_dir_all(root.join("system/filesystem")).unwrap();
        write(&root, files);
        let site = Site::dir(&root, None).unwrap();
        (root, site)
    }

    /// The smallest machine, never started.
    pub fn machine(name: &str) -> (Arc<armless::Board>, armless::runner::Runner) {
        let (_, site) = site(name, &[("system/filesystem.json", EMPTY_FS)]);
        let spec = Spec { memory_mb: 16, cpus: 1, network: "none".into() };
        let (vm, clock) = machine::new_vm_jit(&spec, &site, false).unwrap();
        let board = vm.board.clone();
        (board, armless::runner::Runner::new(vm, clock, false))
    }

    /// What has been typed into the machine's serial line since the last look.
    pub fn typed(board: &armless::Board) -> String {
        String::from_utf8_lossy(&board.devices.lock().uart.input.drain(..).collect::<Vec<u8>>()).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_switches_and_positionals_parse_in_any_order() {
        let a = Args::parse(&strings(&["--detached", "site", "--socket", "/s", "--forward", "1:2", "--forward", "3:4"]), RUN_FLAGS)
            .unwrap();
        assert_eq!(a.positional, ["site"]);
        assert!(a.has("detached"));
        assert!(!a.has("socket"), "a flag with a value is not a switch");
        assert_eq!(a.get("socket"), Some("/s"));
        assert_eq!(a.all("forward"), ["1:2", "3:4"]);
        assert_eq!(a.get("blobs"), None);
        assert!(a.all("blobs").is_empty());
    }

    #[test]
    fn the_last_of_a_repeated_flag_wins() {
        let a = Args::parse(&strings(&["--socket", "/a", "--socket", "/b"]), RUN_FLAGS).unwrap();
        assert_eq!(a.get("socket"), Some("/b"));
    }

    #[test]
    fn a_flag_without_its_value_is_an_error() {
        let e = Args::parse(&strings(&["site", "--socket"]), RUN_FLAGS).err().unwrap();
        assert_eq!(e, "--socket needs a value");
        // A value that looks like a flag is still the value
        let a = Args::parse(&strings(&["--cmd", "--version"]), RUN_FLAGS).unwrap();
        assert_eq!(a.get("cmd"), Some("--version"));
    }

    #[test]
    fn a_failed_command_exits_1_and_a_finished_one_with_its_code() {
        assert_eq!(finish(Ok(7)), ExitCode::from(7));
        assert_eq!(finish(Err("nope".into())), ExitCode::from(1));
        assert_eq!(usage(), ExitCode::from(2));
    }
}
