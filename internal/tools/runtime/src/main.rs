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

mod b64;
mod job;
mod machine;
mod profile;
mod run;
mod sandbox;
mod serve;
mod site;
mod snapshot;
mod term;
mod text;

use std::process::ExitCode;

const SOCKET: &str = "/tmp/snowglobe.sock";

fn usage() -> ExitCode {
    eprintln!(
        "usage:
  snowglobe-vm snapshot <system dir> [--memory MB] [--cpus N] [--network none|fetch]
                        [--ready TEXT] [--exercise COMMAND ...]
                        [--tunnel [HOST:]PORT=URL ...] [--allow-private]
  snowglobe-vm run <site dir> [--blobs DIR] [--detached] [--socket PATH] [--forward PORT:GUEST ...]
                   [--tunnel [HOST:]PORT=URL ...] [--allow-private] [--record-reads FILE]
                   [--workspace DIR --cmd COMMAND [--env K=V ...] [--env-file JSON] [--timeout SECS]]
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
    fn parse(args: &[String], with_value: &[&str]) -> Result<Args, String> {
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

const RUN_FLAGS: &[&str] = &["blobs", "socket", "forward", "tunnel", "record-reads", "workspace", "cmd", "env", "env-file", "timeout", "serve", "jobs-root", "max-jobs", "server"];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
        "snapshot" => Args::parse(rest, &["memory", "cpus", "build-cpus", "network", "ready", "exercise", "cols", "rows", "tunnel"])
            .and_then(|a| snapshot::main(&a)),
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
