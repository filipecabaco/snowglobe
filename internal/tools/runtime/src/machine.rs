//! The machine a site runs on, and what it is doing (for "is it quiet yet?").

use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use armless::dev::{DeviceConfig, Event};
use armless::native::{Egress, HostOptions, NativeHost, Tunnel};
use armless::platform::{Clock, NativePlatform};
use armless::vm::{Config, Vm};

use crate::site::Site;

/// The guest's kernel command line: the root filesystem is the 9p device.
pub const CMDLINE: &str = "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose \
                           modules=virtio_pci console=ttyS0 init_on_free=on";

/// Everything here must match between the snapshot and every restore of it.
pub struct Spec {
    pub memory_mb: usize,
    pub cpus: usize,
    /// "none" or "fetch"
    pub network: String,
}

pub fn new_vm(spec: &Spec, site: &Site) -> Result<(Vm<NativePlatform>, Arc<Clock>), String> {
    new_vm_jit(spec, site, true)
}

/// Whether the JIT is on (ARMLESS_JIT=off keeps the interpreter anyway).
pub fn jit_wanted() -> bool {
    std::env::var("ARMLESS_JIT").map_or(true, |v| v != "off")
}

/// `new_vm`, with the JIT left off when `jit` is false: its compiler threads would not survive a
/// fork (`serve` turns it on in each child, `enable_jit`).
pub fn new_vm_jit(spec: &Spec, site: &Site, jit: bool) -> Result<(Vm<NativePlatform>, Arc<Clock>), String> {
    let config = Config {
        memory_size: spec.memory_mb << 20,
        cpus: spec.cpus,
        devices: DeviceConfig {
            console: true,
            fs_tag: Some("host9p".into()),
            net: spec.network == "fetch",
            ..Default::default()
        },
    };
    let (mut vm, clock) = armless::runner::new_vm(config)?;
    // Hot guest code is compiled to host code (armless's native JIT): booting, exercising and
    // running a site spend most of their time in emulated code. ARMLESS_JIT=off keeps the
    // interpreter; where the host can't run generated code the CPU stays interpreted anyway.
    if jit && jit_wanted() {
        for cpu in vm.cpus.iter_mut().filter(|c| !c.jit.enabled) {
            cpu.enable_native_jit();
        }
    }
    vm.board.load_filesystem(&site.need("system/filesystem.json")?)?;
    // With a network, the guest's HTTPS ends in the machine's web relay, with certificates from
    // the CA made for this site (which the guest trusts); its requests then go out from here
    if spec.network == "fetch" {
        vm.board.set_tls(&site.need("system/tls.json")?)?;
    }
    Ok((vm, clock))
}

/// The console's output so far (the last MiB of it) and offsets into the whole stream.
#[derive(Default)]
pub struct Screen {
    pub buf: Vec<u8>,
    /// Bytes dropped from the front of `buf`
    pub dropped: usize,
}

impl Screen {
    pub fn total(&self) -> usize {
        self.dropped + self.buf.len()
    }
    /// Everything printed since stream offset `from`.
    pub fn since(&self, from: usize) -> &[u8] {
        &self.buf[from.saturating_sub(self.dropped).min(self.buf.len())..]
    }
}

type Watcher = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// What the machine has been doing, as seen from its events.
pub struct Activity {
    pub screen: Mutex<Screen>,
    pub screen_cv: Condvar,
    pub serial: Mutex<Vec<u8>>,
    /// Bytes dropped from the front of `serial` (it keeps the last few MiB)
    serial_dropped: std::sync::atomic::AtomicUsize,
    pub last: Mutex<Instant>,
    /// When the console last printed (None: never)
    pub last_console: Mutex<Option<Instant>>,
    /// TCP connections open between the guest and the outside
    connections: Mutex<HashSet<u32>>,
    /// Tunnelled destinations: their connections (a database pool, a LISTEN) stay open while
    /// the app idles, so only their traffic counts as activity
    tunnels: Mutex<Vec<Tunnel>>,
    /// Files fetched in the current phase, when recording
    pub reads: Mutex<Option<BTreeSet<String>>>,
    watchers: Mutex<Vec<Watcher>>,
    pub echo_serial: bool,
}

const SCREEN_MAX: usize = 1 << 20;

impl Activity {
    pub fn new(echo_serial: bool) -> Arc<Activity> {
        Arc::new(Activity {
            screen: Mutex::default(),
            screen_cv: Condvar::new(),
            serial: Mutex::default(),
            serial_dropped: Default::default(),
            last: Mutex::new(Instant::now()),
            last_console: Mutex::new(None),
            connections: Mutex::default(),
            tunnels: Mutex::default(),
            reads: Mutex::new(None),
            watchers: Mutex::default(),
            echo_serial,
        })
    }

    /// Whether the guest has TCP connections open.
    pub fn connected(&self) -> bool {
        !self.connections.lock().unwrap().is_empty()
    }

    pub fn touch(&self) {
        *self.last.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last.lock().unwrap().elapsed()
    }

    /// Called with every console chunk until it returns false.
    pub fn watch(&self, w: Watcher) {
        self.watchers.lock().unwrap().push(w);
    }

    /// Drop the watchers that are done now (each is called with nothing printed), rather than at
    /// the next console output.
    pub fn unwatch_done(&self) {
        self.watchers.lock().unwrap().retain_mut(|w| w(&[]));
    }

    pub fn observe(self: &Arc<Self>, e: &Event) {
        match e {
            Event::Console(b) => {
                {
                    let mut s = self.screen.lock().unwrap();
                    s.buf.extend_from_slice(b);
                    if s.buf.len() > SCREEN_MAX * 2 {
                        let cut = s.buf.len() - SCREEN_MAX;
                        s.buf.drain(..cut);
                        s.dropped += cut;
                    }
                }
                self.screen_cv.notify_all();
                self.touch();
                *self.last_console.lock().unwrap() = Some(Instant::now());
                if let Some(l) = crate::log::get() {
                    l.console(b);
                }
                self.watchers.lock().unwrap().retain_mut(|w| w(b));
            },
            Event::Serial(b) => {
                if let Some(l) = crate::log::get() {
                    l.serial(b);
                }
                if self.echo_serial {
                    use std::io::Write;
                    let mut out = std::io::stdout();
                    let _ = out.write_all(b);
                    let _ = out.flush();
                }
                {
                    let mut s = self.serial.lock().unwrap();
                    s.extend_from_slice(b);
                    if s.len() > SCREEN_MAX * 4 {
                        let cut = s.len() - SCREEN_MAX * 2;
                        s.drain(..cut);
                        self.serial_dropped.fetch_add(cut, std::sync::atomic::Ordering::SeqCst);
                    }
                }
                self.screen_cv.notify_all();
            },
            Event::Blob(name) => {
                if let Some(r) = self.reads.lock().unwrap().as_mut() {
                    r.insert(name.clone());
                }
                self.touch();
            },
            Event::TcpOpen { host, port, .. }
                if self.tunnels.lock().unwrap().iter().any(|t| t.matches(host, *port)) =>
            {
                self.touch()
            },
            Event::TcpOpen { id, .. }
            | Event::TcpConnected { id }
            | Event::HttpRequest { id, .. }
            | Event::WsOpen { id, .. } => {
                self.connections.lock().unwrap().insert(*id);
                self.touch();
            },
            Event::TcpClosed { id } => {
                self.connections.lock().unwrap().remove(id);
                self.touch();
            },
            Event::TcpData { .. } | Event::TcpEof { .. } | Event::WsMessage { .. } | Event::WsClose { .. } => {
                self.touch()
            },
        }
    }

    /// Offset of the serial output's end, in the whole stream.
    pub fn serial_total(&self) -> usize {
        let s = self.serial.lock().unwrap();
        self.serial_dropped.load(std::sync::atomic::Ordering::SeqCst) + s.len()
    }

    /// The serial output since stream offset `from`.
    pub fn serial_since(&self, from: usize) -> Vec<u8> {
        let s = self.serial.lock().unwrap();
        let dropped = self.serial_dropped.load(std::sync::atomic::Ordering::SeqCst);
        s[from.saturating_sub(dropped).min(s.len())..].to_vec()
    }

    /// Wait until `test` passes on the serial output (or the timeout).
    pub fn wait_serial(&self, timeout: Duration, test: impl Fn(&[u8]) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut s = self.screen.lock().unwrap();
        loop {
            if test(&self.serial.lock().unwrap()) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            s = self.screen_cv.wait_timeout(s, left.min(Duration::from_millis(200))).unwrap().0;
        }
    }
}

/// Where the guest's TCP goes besides straight out: host-side, so not part of the snapshot.
#[derive(Default)]
pub struct Net {
    /// Destinations carried over WebSockets, as in the page
    pub tunnels: Vec<Tunnel>,
    /// Loopback and private addresses are off limits unless allowed
    pub allow_private: bool,
}

impl Net {
    /// `--tunnel [HOST:]PORT=URL` (repeatable) and `--allow-private`; without --tunnel, the
    /// ones the site was built with (run.json's `tunnels`), if any.
    pub fn from_args(args: &crate::Args, saved: Option<&serde_json::Value>) -> Result<Net, String> {
        let specs = args.all("tunnel");
        let tunnels = if !specs.is_empty() {
            specs
                .iter()
                .map(|s| Tunnel::parse(s).ok_or_else(|| format!("--tunnel {s}: use [HOST:]PORT=ws://... or wss://...")))
                .collect::<Result<_, _>>()?
        } else {
            saved
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
                .map(|t| {
                    Some(Tunnel {
                        host: t["host"].as_str().map(str::to_string),
                        port: u16::try_from(t["port"].as_u64()?).ok()?,
                        url: t["url"].as_str()?.to_string(),
                    })
                })
                .collect::<Option<_>>()
                .ok_or("run.json: tunnels must be { host, port, url }")?
        };
        Ok(Net { tunnels, allow_private: args.has("allow-private") })
    }
}

/// The host side of the machine: the site's blobs, the network if the site has one.
pub fn host(board: &Arc<armless::Board>, site: &Site, network: &str, net: Net, activity: &Arc<Activity>) -> NativeHost {
    *activity.tunnels.lock().unwrap() = net.tunnels.clone();
    let a = activity.clone();
    NativeHost::spawn(
        board.clone(),
        HostOptions {
            blobs: None,
            blob_source: Some(site.blobs()),
            network: network == "fetch",
            // Direct, or through the proxy the environment names: sandboxes that only let HTTPS
            // out through a (TLS-intercepting) proxy work too
            egress: Egress { allow_private: net.allow_private, ..Egress::from_env() },
            tunnels: net.tunnels,
        },
        Box::new(move |e| a.observe(e)),
    )
}

/// Whether the guest's CPUs are working: a command that computes without printing is not done
/// yet. Judged by the instructions run since the last look; an idle Linux guest runs only its
/// timer ticks (well under a million a second), a busy CPU runs tens of millions.
pub struct Load {
    last: u64,
    at: Instant,
}

/// Instructions per second, over all CPUs, above which the guest counts as busy
const BUSY_RATE: f64 = 25_000_000.0;

impl Load {
    pub fn new(runner: &armless::runner::Runner) -> Load {
        Load { last: runner.insn_count(), at: Instant::now() }
    }

    /// Busy since the last call?
    pub fn busy(&mut self, runner: &armless::runner::Runner) -> bool {
        let now = runner.insn_count();
        let secs = self.at.elapsed().as_secs_f64().max(1e-3);
        let rate = now.saturating_sub(self.last) as f64 / secs;
        self.last = now;
        self.at = Instant::now();
        rate > BUSY_RATE
    }
}

/// Turn the JIT on for every CPU of a machine not running yet (after `new_vm_jit(.., false)`).
pub fn enable_jit(runner: &armless::runner::Runner, cpus: usize) {
    if jit_wanted() {
        for i in 0..cpus {
            runner.with_cpu(i, |c| {
                if !c.jit.enabled {
                    c.enable_native_jit();
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{self, site, EMPTY_FS};

    fn args(v: &[&str]) -> crate::Args {
        let v: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        crate::Args::parse(&v, crate::RUN_FLAGS).unwrap()
    }

    fn console(a: &Arc<Activity>, b: &[u8]) {
        a.observe(&Event::Console(b.to_vec()));
    }

    fn serial(a: &Arc<Activity>, b: &[u8]) {
        a.observe(&Event::Serial(b.to_vec()));
    }

    #[test]
    fn the_screen_keeps_the_last_of_the_console_and_counts_what_it_dropped() {
        let a = Activity::new(false);
        assert!(a.last_console.lock().unwrap().is_none());
        console(&a, b"hello ");
        console(&a, b"world");
        assert!(a.last_console.lock().unwrap().is_some());
        {
            let s = a.screen.lock().unwrap();
            assert_eq!(s.total(), 11);
            assert_eq!(s.since(6), b"world");
            assert_eq!(s.since(0), b"hello world");
            assert_eq!(s.since(99), b"");
        }
        // Past twice the limit, it is cut back to the last MiB
        console(&a, &vec![b'x'; SCREEN_MAX * 2]);
        let s = a.screen.lock().unwrap();
        assert_eq!(s.buf.len(), SCREEN_MAX);
        assert_eq!(s.total(), 11 + SCREEN_MAX * 2);
        assert_eq!(s.dropped, 11 + SCREEN_MAX);
        // An offset in what was dropped gives everything kept
        assert_eq!(s.since(3).len(), SCREEN_MAX);
        assert_eq!(s.since(s.total() - 2), b"xx");
    }

    #[test]
    fn watchers_see_the_console_until_they_say_stop() {
        let a = Activity::new(false);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        a.watch(Box::new(move |b| {
            s.lock().unwrap().extend_from_slice(b);
            !b.contains(&b'!')
        }));
        console(&a, b"one ");
        console(&a, b"two!");
        console(&a, b"three");
        serial(&a, b"not the console");
        assert_eq!(*seen.lock().unwrap(), b"one two!");
        // One that is done goes without waiting for output
        let gone = Arc::new(Mutex::new(false));
        let g = gone.clone();
        a.watch(Box::new(move |_| !*g.lock().unwrap()));
        a.unwatch_done();
        assert_eq!(a.watchers.lock().unwrap().len(), 1);
        *gone.lock().unwrap() = true;
        a.unwatch_done();
        assert!(a.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn the_serial_line_is_kept_apart_with_offsets_into_it() {
        let a = Activity::new(false);
        let before = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        serial(&a, b"boot\n");
        assert_eq!(a.serial_total(), 5);
        serial(&a, b"# ");
        assert_eq!(a.serial_since(5), b"# ");
        assert_eq!(a.serial_since(100), b"");
        assert!(a.screen.lock().unwrap().buf.is_empty());
        // Serial output is not activity of the app's
        assert!(*a.last.lock().unwrap() < before + Duration::from_millis(5));
        // Past four MiB it keeps the last two
        serial(&a, &vec![b'x'; SCREEN_MAX * 4]);
        assert_eq!(a.serial.lock().unwrap().len(), SCREEN_MAX * 2);
        assert_eq!(a.serial_total(), 7 + SCREEN_MAX * 4);
        assert_eq!(a.serial_since(0).len(), SCREEN_MAX * 2);
        assert_eq!(a.serial_since(a.serial_total() - 1), b"x");
    }

    #[test]
    fn waiting_on_the_serial_line_ends_when_it_shows_or_in_time() {
        let a = Activity::new(false);
        serial(&a, b"login: ");
        assert!(a.wait_serial(Duration::ZERO, |s| s.ends_with(b"login: ")));
        let begun = Instant::now();
        assert!(!a.wait_serial(Duration::from_millis(50), |s| s.ends_with(b"# ")));
        assert!(begun.elapsed() >= Duration::from_millis(50));
        // Woken by the output it waits for, long before its timeout
        let b = a.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            serial(&b, b"\n# ");
        });
        let begun = Instant::now();
        assert!(a.wait_serial(Duration::from_secs(10), |s| s.ends_with(b"# ")));
        assert!(begun.elapsed() < Duration::from_secs(5));
        t.join().unwrap();
    }

    #[test]
    fn files_fetched_are_recorded_only_when_asked() {
        let a = Activity::new(false);
        a.observe(&Event::Blob("before".into()));
        *a.reads.lock().unwrap() = Some(BTreeSet::new());
        a.observe(&Event::Blob("b".into()));
        a.observe(&Event::Blob("a".into()));
        a.observe(&Event::Blob("a".into()));
        let reads: Vec<String> = a.reads.lock().unwrap().iter().flatten().cloned().collect();
        assert_eq!(reads, ["a", "b"]);
    }

    #[test]
    fn open_connections_keep_the_guest_busy_until_they_close() {
        let a = Activity::new(false);
        assert!(!a.connected());
        a.observe(&Event::TcpOpen { id: 1, host: "example.com".into(), port: 443 });
        a.observe(&Event::HttpRequest { id: 2, method: "GET".into(), url: "/".into(), headers: vec![], body: vec![] });
        a.observe(&Event::WsOpen { id: 3, url: "wss://x".into(), protocols: vec![] });
        a.observe(&Event::TcpConnected { id: 4 });
        for id in [1, 2, 3] {
            a.observe(&Event::TcpClosed { id });
            assert!(a.connected(), "{id}");
        }
        a.observe(&Event::TcpClosed { id: 4 });
        assert!(!a.connected());
        // Closing what was never open is no matter
        a.observe(&Event::TcpClosed { id: 9 });
        assert!(!a.connected());
    }

    #[test]
    fn a_tunnelled_connection_is_activity_but_not_an_open_connection() {
        let a = Activity::new(false);
        *a.tunnels.lock().unwrap() = vec![Tunnel { host: Some("db".into()), port: 5432, url: "wss://x".into() }];
        a.observe(&Event::TcpOpen { id: 1, host: "DB".into(), port: 5432 });
        assert!(!a.connected(), "a pool that stays open isn't a command still running");
        // Another port of the same host is an ordinary connection
        a.observe(&Event::TcpOpen { id: 2, host: "db".into(), port: 5433 });
        assert!(a.connected());
    }

    #[test]
    fn any_traffic_is_activity() {
        let a = Activity::new(false);
        let quiet = |a: &Arc<Activity>| {
            *a.last.lock().unwrap() = Instant::now() - Duration::from_secs(60);
            assert!(a.idle_for() >= Duration::from_secs(60));
        };
        for e in [
            Event::Console(b"x".to_vec()),
            Event::Blob("b".into()),
            Event::TcpOpen { id: 1, host: "h".into(), port: 1 },
            Event::TcpConnected { id: 1 },
            Event::TcpData { id: 1, data: vec![1] },
            Event::TcpEof { id: 1 },
            Event::WsMessage { id: 1, text: true, data: vec![] },
            Event::WsClose { id: 1, code: 1000 },
            Event::TcpClosed { id: 1 },
        ] {
            quiet(&a);
            a.observe(&e);
            assert!(a.idle_for() < Duration::from_secs(1), "{e:?}");
        }
        quiet(&a);
        a.touch();
        assert!(a.idle_for() < Duration::from_secs(1));
    }

    #[test]
    fn tunnels_come_from_the_flags_else_from_run_json() {
        let saved = serde_json::json!([{ "host": "db", "port": 5432, "url": "wss://a/db" }, { "port": 6379, "url": "ws://b" }]);
        let n = Net::from_args(&args(&[]), Some(&saved)).unwrap();
        assert_eq!(n.tunnels.len(), 2);
        assert_eq!(n.tunnels[0].host.as_deref(), Some("db"));
        assert_eq!((n.tunnels[1].host.as_deref(), n.tunnels[1].port), (None, 6379));
        assert!(!n.allow_private);
        // --tunnel replaces the saved ones
        let n = Net::from_args(&args(&["--tunnel", "cache:1=wss://c", "--allow-private"]), Some(&saved)).unwrap();
        assert_eq!(n.tunnels.len(), 1);
        assert_eq!((n.tunnels[0].port, n.tunnels[0].url.as_str()), (1, "wss://c"));
        assert!(n.allow_private);
        // None saved (or null, as a site without tunnels has)
        assert!(Net::from_args(&args(&[]), None).unwrap().tunnels.is_empty());
        assert!(Net::from_args(&args(&[]), Some(&serde_json::Value::Null)).unwrap().tunnels.is_empty());
    }

    #[test]
    fn bad_tunnels_are_refused() {
        for bad in ["5432", "5432=https://x", ":5432=wss://x", "db:0=wss://x"] {
            let e = Net::from_args(&args(&["--tunnel", bad]), None).err().unwrap();
            assert!(e.starts_with(&format!("--tunnel {bad}:")), "{e}");
        }
        for saved in [
            serde_json::json!([{ "port": 70000, "url": "wss://x" }]),
            serde_json::json!([{ "port": 1 }]),
            serde_json::json!([{ "host": "h", "url": "wss://x" }]),
        ] {
            assert!(Net::from_args(&args(&[]), Some(&saved)).is_err(), "{saved}");
        }
    }

    #[test]
    fn a_machine_is_made_from_the_sites_filesystem() {
        let (board, runner) = testing::machine("machine-new");
        board.fs_write_file("/a/b", b"hi", 0o644).unwrap();
        assert_eq!(board.fs_read_tree("/a").unwrap(), Some(vec![("b".to_string(), b"hi".to_vec())]));
        // A machine that never ran is not busy
        let mut load = Load::new(&runner);
        assert!(!load.busy(&runner));
    }

    #[test]
    fn a_machine_needs_its_filesystem_and_with_a_network_its_certificates() {
        let spec = |network: &str| Spec { memory_mb: 16, cpus: 1, network: network.into() };
        let (_, bare) = site("machine-bare", &[]);
        assert_eq!(new_vm_jit(&spec("none"), &bare, false).err().unwrap(), "system/filesystem.json: not in the site");
        let (_, s) = site("machine-net", &[("system/filesystem.json", EMPTY_FS)]);
        assert_eq!(new_vm_jit(&spec("fetch"), &s, false).err().unwrap(), "system/tls.json: not in the site");
        assert!(new_vm_jit(&Spec { memory_mb: 1, ..spec("none") }, &s, false).is_err());
    }
}
