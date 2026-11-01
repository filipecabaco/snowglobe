//! The JIT profile a run starts from: what the build compiled booting the site
//! (system/jit-profile.bin), merged with what earlier runs of the same snapshot compiled, kept
//! on this machine. A run adds what it compiles, so the profile follows what runs of the site
//! actually do (an agent trying things nobody listed) rather than a fixed list of commands.
//!
//! Profiles are pages of guest physical memory with a hash of their contents; a page that holds
//! other code in this run than when it was profiled is skipped, so merging runs is safe.

use std::path::PathBuf;

use crate::site::Site;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use armless::jit::profile::{self, Page};
use armless::runner::Runner;

/// Pages a learned profile keeps, the ones most runs compiled
const MAX_PAGES: usize = 4096;
const EVERY: Duration = Duration::from_secs(15);

pub struct Learned {
    /// Where this snapshot's learned profile lives (None: nowhere to keep one)
    pub path: Option<PathBuf>,
    /// The build's profile and the learned one as this run found them
    base: Vec<Page>,
    learned: Vec<Page>,
    saving: Mutex<()>,
}

impl Learned {
    pub fn open(site: &Site) -> Learned {
        let parse = |d: &[u8]| profile::read(d).ok().unwrap_or_default();
        let base = site.file("system/jit-profile.bin").map_or_else(Vec::new, |d| parse(&d));
        let path = cache_path(site);
        let learned = path.as_deref().and_then(|p| std::fs::read(p).ok()).map_or_else(Vec::new, |d| parse(&d));
        Learned { path, base, learned, saving: Mutex::new(()) }
    }

    /// What to compile at once: the pages most runs compiled first, then the build's.
    pub fn prewarm(&self) -> Vec<Page> {
        let mut all = self.learned.clone();
        let mut base = self.base.clone();
        for p in &mut base {
            p.runs = 0;
        }
        profile::merge(&mut all, &base, usize::MAX);
        all
    }

    pub fn pages(&self) -> usize {
        self.learned.len() + self.base.len()
    }

    /// Add what this run has compiled so far to the learned profile (this run counts once,
    /// however often it saves).
    pub fn learn(&self, runner: &Runner) {
        let Some(path) = &self.path else { return };
        let _one = self.saving.lock().unwrap();
        let mut merged = self.learned.clone();
        profile::merge(&mut merged, &runner.jit_profile(), MAX_PAGES);
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::create_dir_all(path.parent().unwrap()).is_ok() && std::fs::write(&tmp, profile::write(&merged)).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// Learn every little while: a detached run ends by being killed.
    pub fn keep_learning(self: &Arc<Self>, runner: Arc<Runner>) {
        let me = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(EVERY);
            me.learn(&runner);
        });
    }
}

/// $SNOWGLOBE_CACHE, else $XDG_CACHE_HOME/snowglobe, else ~/.cache/snowglobe; then
/// jit/<snapshot>.bin, the snapshot named by its size and a hash of its end (a zstd frame
/// ends with its checksum).
pub fn cache_path(site: &Site) -> Option<PathBuf> {
    let root = std::env::var_os("SNOWGLOBE_CACHE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CACHE_HOME").map(|d| PathBuf::from(d).join("snowglobe")))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache/snowglobe")))?;
    let state = site.file("system/state.bin.zst")?;
    let tail = &state[state.len().saturating_sub(1 << 16)..];
    let mut padded = tail.to_vec();
    padded.resize(tail.len().next_multiple_of(8), 0);
    Some(root.join("jit").join(format!("{:x}-{:016x}.bin", state.len(), profile::hash(&padded))))
}
