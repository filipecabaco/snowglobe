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
        Learned::at(site, cache_path(site))
    }

    /// The build's profile, and the learned one kept at `path`.
    fn at(site: &Site, path: Option<PathBuf>) -> Learned {
        let parse = |d: &[u8]| profile::read(d).ok().unwrap_or_default();
        let base = site.file("system/jit-profile.bin").map_or_else(Vec::new, |d| parse(&d));
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
    cache_in(&cache_root(|k| std::env::var_os(k))?, site)
}

/// The cache directory, from the environment (`var`).
fn cache_root(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    var("SNOWGLOBE_CACHE")
        .map(PathBuf::from)
        .or_else(|| var("XDG_CACHE_HOME").map(|d| PathBuf::from(d).join("snowglobe")))
        .or_else(|| var("HOME").map(|h| PathBuf::from(h).join(".cache/snowglobe")))
}

/// Where in the cache `root` this site's snapshot keeps its profile.
fn cache_in(root: &std::path::Path, site: &Site) -> Option<PathBuf> {
    let state = site.file("system/state.bin.zst")?;
    let tail = &state[state.len().saturating_sub(1 << 16)..];
    let mut padded = tail.to_vec();
    padded.resize(tail.len().next_multiple_of(8), 0);
    Some(root.join("jit").join(format!("{:x}-{:016x}.bin", state.len(), profile::hash(&padded))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{self, site, tmp};

    fn page(key: u64, runs: u32) -> Page {
        Page { key, hash: key * 7, runs, entries: vec![key as u16] }
    }

    fn keys(pages: &[Page]) -> Vec<(u64, u32)> {
        pages.iter().map(|p| (p.key, p.runs)).collect()
    }

    #[test]
    fn the_cache_is_where_the_environment_says() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            cache_root(move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.into()))
        };
        assert_eq!(env(&[("SNOWGLOBE_CACHE", "/c"), ("XDG_CACHE_HOME", "/x"), ("HOME", "/h")]), Some("/c".into()));
        assert_eq!(env(&[("XDG_CACHE_HOME", "/x"), ("HOME", "/h")]), Some("/x/snowglobe".into()));
        assert_eq!(env(&[("HOME", "/h")]), Some("/h/.cache/snowglobe".into()));
        assert_eq!(env(&[]), None);
    }

    #[test]
    fn a_snapshot_is_named_by_its_size_and_the_hash_of_its_end() {
        let root = std::path::Path::new("/cache");
        let named = |state: &[u8]| cache_in(root, &site("profile-name", &[("system/state.bin.zst", state)]).1);
        let a = named(b"snapshot a").unwrap();
        assert_eq!(a.parent().unwrap(), root.join("jit"));
        assert!(a.file_name().unwrap().to_str().unwrap().starts_with("a-"), "{}", a.display());
        assert_ne!(named(b"snapshot b").unwrap(), a);
        assert_eq!(named(b"snapshot a").unwrap(), a);
        // Only the last 64 KiB count (a zstd frame ends with its checksum)
        let mut big = vec![1u8; 100_000];
        let one = named(&big).unwrap();
        big[0] = 2;
        assert_eq!(named(&big).unwrap(), one);
        big[99_999] = 2;
        assert_ne!(named(&big).unwrap(), one);
        // No snapshot, nothing to name
        assert_eq!(cache_in(root, &site("profile-none", &[]).1), None);
    }

    #[test]
    fn prewarm_puts_what_runs_compiled_before_the_builds_profile() {
        let cache = tmp("profile-prewarm").join("learned.bin");
        std::fs::write(&cache, profile::write(&[page(2, 5), page(3, 1)])).unwrap();
        let base = profile::write(&[page(1, 9), page(2, 9)]);
        let (_, s) = site("profile-prewarm-site", &[("system/jit-profile.bin", &base)]);
        let l = Learned::at(&s, Some(cache.clone()));
        assert_eq!(l.pages(), 4);
        // The build's pages count no runs: they come after every learned one
        assert_eq!(keys(&l.prewarm()), [(2, 5), (3, 1), (1, 0)]);
    }

    #[test]
    fn unreadable_profiles_are_none() {
        let cache = tmp("profile-garbage").join("learned.bin");
        std::fs::write(&cache, b"not a profile").unwrap();
        let (_, s) = site("profile-garbage-site", &[("system/jit-profile.bin", b"nor this")]);
        let l = Learned::at(&s, Some(cache));
        assert_eq!(l.pages(), 0);
        assert!(l.prewarm().is_empty());
        let l = Learned::at(&s, None);
        assert_eq!(l.pages(), 0);
    }

    #[test]
    fn learning_keeps_the_profile_with_this_runs_pages() {
        let (_, runner) = testing::machine("profile-learn");
        let cache = tmp("profile-learn-cache").join("jit/x.bin");
        let (_, s) = site("profile-learn-site", &[]);
        // Made where there was none, its directory too
        let l = Learned::at(&s, Some(cache.clone()));
        l.learn(&runner);
        assert_eq!(profile::read(&std::fs::read(&cache).unwrap()).unwrap().len(), 0);
        // What was learned before is kept
        std::fs::write(&cache, profile::write(&[page(4, 2)])).unwrap();
        let l = Learned::at(&s, Some(cache.clone()));
        l.learn(&runner);
        l.learn(&runner);
        assert_eq!(keys(&profile::read(&std::fs::read(&cache).unwrap()).unwrap()), [(4, 2)]);
        let leftovers: Vec<_> = std::fs::read_dir(cache.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers, ["x.bin"], "no temporary files left");
        // Nowhere to keep it: nothing happens
        Learned::at(&s, None).learn(&runner);
    }
}
