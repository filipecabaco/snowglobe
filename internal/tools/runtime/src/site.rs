//! A built site's files, from its directory or from a bundle: a snowglobe-vm executable with the
//! site appended to it, which runs the site when started (`snowglobe bundle`, which writes it:
//! internal/bundle).
//!
//! A bundle is the executable, then each file of the site back to back (as they are: the
//! snapshot and blobs are compressed already), then a JSON index of them, then a trailer:
//!
//!   [executable][files...][index JSON][executable length: u64][index offset: u64][index length: u64]["SGBUNDL1"]
//!
//! The running executable maps itself and reads the site from memory: nothing is extracted, and
//! a blob the guest reads is a slice of the mapping.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use armless::native::BlobSource;

const MAGIC: &[u8; 8] = b"SGBUNDL1";
const TRAILER: usize = 8 * 3 + MAGIC.len();

#[derive(Clone)]
pub struct Site(Arc<Source>);

enum Source {
    Dir { root: Option<PathBuf>, system: PathBuf, blobs: PathBuf },
    Bundle { map: Mmap, files: HashMap<String, (usize, usize)>, exe: PathBuf },
}

impl Site {
    /// A site directory (with run.json and system/), its blobs in `blobs` if they aren't in
    /// system/filesystem (a pooled site).
    pub fn dir(root: &Path, blobs: Option<&Path>) -> Result<Site, String> {
        let system = root.join("system");
        let blobs = if system.join("filesystem").is_dir() {
            system.join("filesystem")
        } else {
            blobs.ok_or("the site has no system/filesystem: pass --blobs")?.to_path_buf()
        };
        Ok(Site(Arc::new(Source::Dir { root: Some(root.to_path_buf()), system, blobs })))
    }

    /// Just a system directory, as `snapshot` has.
    pub fn system(system: &Path) -> Site {
        Site(Arc::new(Source::Dir { root: None, system: system.to_path_buf(), blobs: system.join("filesystem") }))
    }

    /// The site this executable carries, if it is a bundle.
    pub fn this_bundle() -> Option<Site> {
        let exe = std::env::current_exe().ok()?;
        let file = std::fs::File::open(&exe).ok()?;
        let map = Mmap::of(&file)?;
        let files = index(&map)?;
        Some(Site(Arc::new(Source::Bundle { map, files, exe })))
    }

    /// A file of the site (`run.json`, `system/state.bin.zst`...).
    pub fn file(&self, rel: &str) -> Option<Cow<'_, [u8]>> {
        match &*self.0 {
            Source::Dir { root, system, .. } => {
                let path = match rel.strip_prefix("system/") {
                    Some(name) => system.join(name),
                    None => root.as_ref()?.join(rel),
                };
                std::fs::read(path).ok().map(Cow::Owned)
            },
            Source::Bundle { map, files, .. } => files.get(rel).map(|&(o, n)| Cow::Borrowed(&map[o..o + n])),
        }
    }

    pub fn need(&self, rel: &str) -> Result<Cow<'_, [u8]>, String> {
        self.file(rel).ok_or_else(|| format!("{rel}: not in the site"))
    }

    /// Where the guest's files come from.
    pub fn blobs(&self) -> BlobSource {
        let site = self.clone();
        BlobSource(Arc::new(move |name: &str| {
            if name.contains('/') || name.contains("..") {
                return None;
            }
            match &*site.0 {
                Source::Dir { blobs, .. } => std::fs::read(blobs.join(name)).ok(),
                Source::Bundle { .. } => site.file(&format!("blob/{name}")).map(Cow::into_owned),
            }
        }))
    }

    /// Paths a sandboxed run must still be able to read (nothing, for a bundle: it is mapped).
    pub fn read_paths(&self) -> Vec<PathBuf> {
        match &*self.0 {
            Source::Dir { root, system, blobs } => root.iter().chain([system, blobs]).cloned().collect(),
            Source::Bundle { .. } => Vec::new(),
        }
    }

    pub fn describe(&self) -> String {
        match &*self.0 {
            Source::Dir { root, system, .. } => root.as_ref().unwrap_or(system).display().to_string(),
            Source::Bundle { exe, .. } => exe.display().to_string(),
        }
    }
}

/// The files of a bundle, by name.
fn index(data: &[u8]) -> Option<HashMap<String, (usize, usize)>> {
    let t = data.len().checked_sub(TRAILER)?;
    let trailer = &data[t..];
    if &trailer[24..] != MAGIC {
        return None;
    }
    let num = |i: usize| u64::from_le_bytes(trailer[i * 8..i * 8 + 8].try_into().unwrap()) as usize;
    let (at, len) = (num(1), num(2));
    let json: BTreeMap<String, (usize, usize)> = serde_json::from_slice(data.get(at..at.checked_add(len)?)?).ok()?;
    let files = json
        .into_iter()
        .filter(|&(_, (o, n))| o.checked_add(n).is_some_and(|end| end <= at))
        .collect();
    Some(files)
}

/// A read-only mapping of a whole file.
struct Mmap {
    ptr: *const u8,
    len: usize,
}

// The mapping is read-only and lives as long as the Mmap
unsafe impl Send for Mmap {}
unsafe impl Sync for Mmap {}

impl Mmap {
    fn of(file: &std::fs::File) -> Option<Mmap> {
        use std::os::fd::AsRawFd;
        let len = file.metadata().ok()?.len() as usize;
        if len == 0 {
            return None;
        }
        // SAFETY: a private read-only mapping of an open file; the bundle is not written while
        // it runs (replacing it makes a new file)
        let ptr = unsafe {
            libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_PRIVATE, file.as_raw_fd(), 0)
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        Some(Mmap { ptr: ptr as *const u8, len })
    }
}

impl std::ops::Deref for Mmap {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        // SAFETY: mapped for `len` bytes until drop
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for Mmap {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.ptr as *mut _, self.len) };
    }
}
