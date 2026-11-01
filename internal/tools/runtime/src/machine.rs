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
    if std::env::var("ARMLESS_JIT").map_or(true, |v| v != "off") {
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
                self.watchers.lock().unwrap().retain_mut(|w| w(b));
            },
            Event::Serial(b) => {
                if self.echo_serial {
                    use std::io::Write;
                    let mut out = std::io::stdout();
                    let _ = out.write_all(b);
                    let _ = out.flush();
                }
                self.serial.lock().unwrap().extend_from_slice(b);
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
