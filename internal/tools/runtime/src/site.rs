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

use crate::sys::Mmap;

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
        Site::bundle(std::env::current_exe().ok()?)
    }

    /// The site a bundle carries (None: `exe` is no bundle).
    fn bundle(exe: PathBuf) -> Option<Site> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{site, tmp, write};

    /// A bundle as `snowglobe bundle` writes it: `exe`, the files back to back, the index, the
    /// trailer.
    fn bundle_bytes(exe: &[u8], files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = exe.to_vec();
        let mut index = BTreeMap::new();
        for (name, data) in files {
            index.insert(name.to_string(), (out.len(), data.len()));
            out.extend_from_slice(data);
        }
        let json = serde_json::to_vec(&index).unwrap();
        let at = out.len();
        out.extend_from_slice(&json);
        for n in [exe.len(), at, json.len()] {
            out.extend_from_slice(&(n as u64).to_le_bytes());
        }
        out.extend_from_slice(MAGIC);
        out
    }

    #[test]
    fn a_site_directory_reads_its_files_and_system_files() {
        let (root, s) = site("site-dir", &[("run.json", b"{}"), ("system/state.bin.zst", b"state")]);
        assert_eq!(s.file("run.json").as_deref(), Some(&b"{}"[..]));
        assert_eq!(s.file("system/state.bin.zst").as_deref(), Some(&b"state"[..]));
        assert!(s.file("missing").is_none());
        assert_eq!(s.need("system/nope").err().unwrap(), "system/nope: not in the site");
        assert_eq!(s.describe(), root.display().to_string());
        assert_eq!(s.read_paths(), [root.clone(), root.join("system"), root.join("system/filesystem")]);
    }

    #[test]
    fn a_pooled_site_needs_its_blobs_store() {
        let root = tmp("site-pooled");
        write(&root, &[("run.json", b"{}"), ("pool/abc", b"blob")]);
        assert!(Site::dir(&root, None).err().unwrap().contains("--blobs"));
        let s = Site::dir(&root, Some(&root.join("pool"))).unwrap();
        assert_eq!((s.blobs().0)("abc"), Some(b"blob".to_vec()));
        assert_eq!(s.read_paths()[2], root.join("pool"));
    }

    #[test]
    fn blobs_are_names_never_paths() {
        let (root, s) = site("site-blobs", &[("system/filesystem/abc", b"blob"), ("system/secret", b"no")]);
        let get = s.blobs().0;
        assert_eq!(get("abc"), Some(b"blob".to_vec()));
        assert_eq!(get("missing"), None);
        for bad in ["../secret", "a/b", "..", &format!("{}/system/secret", root.display())] {
            assert_eq!(get(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_system_directory_has_no_site_files() {
        let root = tmp("site-system");
        write(&root, &[("state.bin.zst", b"state"), ("filesystem/abc", b"blob")]);
        let s = Site::system(&root);
        assert_eq!(s.file("system/state.bin.zst").as_deref(), Some(&b"state"[..]));
        // run.json is beside system/, which a system directory doesn't have
        assert!(s.file("run.json").is_none());
        assert_eq!((s.blobs().0)("abc"), Some(b"blob".to_vec()));
        assert_eq!(s.describe(), root.display().to_string());
    }

    #[test]
    fn a_bundle_carries_its_files_and_blobs() {
        let exe = tmp("site-bundle").join("site");
        let data = bundle_bytes(b"\x7fELF...", &[("run.json", b"{\"title\":\"t\"}"), ("blob/abc", b"blob"), ("empty", b"")]);
        std::fs::write(&exe, data).unwrap();
        let s = Site::bundle(exe.clone()).unwrap();
        assert_eq!(s.file("run.json").as_deref(), Some(&b"{\"title\":\"t\"}"[..]));
        assert_eq!(s.file("empty").as_deref(), Some(&b""[..]));
        assert!(s.file("system/state.bin.zst").is_none());
        let get = s.blobs().0;
        assert_eq!(get("abc"), Some(b"blob".to_vec()));
        assert_eq!(get("../run.json"), None);
        // Mapped already: nothing for the sandbox to let it read
        assert!(s.read_paths().is_empty());
        assert_eq!(s.describe(), exe.display().to_string());
    }

    #[test]
    fn an_executable_without_a_trailer_is_no_bundle() {
        let d = tmp("site-nobundle");
        std::fs::write(d.join("plain"), b"just a program, long enough to hold a trailer's worth").unwrap();
        assert!(Site::bundle(d.join("plain")).is_none());
        std::fs::write(d.join("empty"), b"").unwrap();
        assert!(Site::bundle(d.join("empty")).is_none());
        assert!(Site::bundle(d.join("missing")).is_none());
        // This test binary is no bundle either
        assert!(Site::this_bundle().is_none());
    }

    #[test]
    fn an_index_never_points_outside_the_files() {
        assert!(index(b"short").is_none());
        let good = bundle_bytes(b"exe", &[("a", b"aaaa")]);
        assert_eq!(index(&good).unwrap()["a"], (3, 4));
        // An entry running into the index (or past the end) is dropped
        let mut bad = b"exeaaaa".to_vec();
        let json = br#"{"a":[3,4],"over":[3,999],"wrap":[18446744073709551615,2]}"#;
        let at = bad.len();
        bad.extend_from_slice(json);
        for n in [3, at, json.len()] {
            bad.extend_from_slice(&(n as u64).to_le_bytes());
        }
        bad.extend_from_slice(MAGIC);
        let files = index(&bad).unwrap();
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files["a"], (3, 4));
        // An index that isn't where the trailer says, or isn't JSON
        let mut lost = good.clone();
        let n = lost.len();
        lost[n - TRAILER + 8..n - TRAILER + 16].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(index(&lost).is_none());
        let mut garbled = good.clone();
        let at = u64::from_le_bytes(good[n - TRAILER + 8..n - TRAILER + 16].try_into().unwrap()) as usize;
        garbled[at] = b'x';
        assert!(index(&garbled).is_none());
    }
}
