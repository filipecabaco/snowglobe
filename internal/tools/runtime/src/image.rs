//! A site's snapshot RAM as an image on disk, which every machine restored from the snapshot maps
//! copy-on-write (`armless::Ram::from_image`): they share the pages none of them writes (the host's
//! page cache holds one copy), and a page a machine writes becomes its own. Without it each run
//! decompresses the whole snapshot into memory of its own.
//!
//! The image is made from the snapshot the first time a site runs, in the cache:
//!
//!   ram/<sha256 of state.bin.zst>.ram    RAM as the snapshot has it, holes where it is zero
//!   ram/<sha256 of state.bin.zst>.state  the snapshot without its pages, which restores onto it
//!
//! A page no machine has written yet is still the file's, so what keeps a machine's memory its
//! own is that nobody else can change the files: `ram` is made 0700, the files 0444, and both are
//! checked on the descriptor that is opened (a regular file, ours, with no write bits and one link:
//! not a link to a file someone else can write) before they are used. They are named by a hash of
//! the whole snapshot, so a site can't pass its snapshot off as another's and get that one's RAM.
//! Anything not right is reported and the run restores the usual way.
//!
//! SNOWGLOBE_RAM_IMAGE=off restores the usual way.

use std::fs::File;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::site::Site;

/// RAM mapped from the image, and the state that restores onto it.
pub struct Image {
    pub ram: armless::Ram,
    pub state: Vec<u8>,
}

/// Images not used for this long go when a new one is made.
const UNUSED: Duration = Duration::from_secs(14 * 24 * 3600);

/// The image of `site`'s snapshot for a machine with `memory` bytes of RAM, made the first time.
/// None when it is off, there is no cache, or something is wrong with it (said on stderr).
pub fn open(site: &Site, memory: usize) -> Option<Image> {
    if std::env::var("SNOWGLOBE_RAM_IMAGE").is_ok_and(|v| v == "off") {
        return None;
    }
    let root = crate::profile::cache_root_from_env()?;
    let state = site.file("system/state.bin.zst")?;
    match open_in(&root, &state, memory) {
        Ok(image) => Some(image),
        Err(e) => {
            eprintln!("snowglobe-vm: the snapshot's RAM is not shared: {e}");
            None
        }
    }
}

/// `open`, with the cache in `root`.
fn open_in(root: &Path, state: &[u8], memory: usize) -> Result<Image, String> {
    let dir = root.join("ram");
    private_dir(&dir)?;
    let key = format!("{:x}", Sha256::digest(state));
    let (ram, rest) = (dir.join(format!("{key}.ram")), dir.join(format!("{key}.state")));
    // The state goes in after its image: with it there, both are whole
    if !rest.exists() {
        make(&dir, state, &ram, &rest)?;
    }
    let read = || -> Result<(File, Vec<u8>), String> {
        let mut f = open_checked(&rest)?;
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut data).map_err(|e| e.to_string())?;
        Ok((f, data))
    };
    let (mut rest_file, mut without_pages) = read()?;
    // One that isn't (from another version, say) would restore as a whole snapshot with no pages:
    // made again
    if !armless::vm::is_split_state(&without_pages) {
        make(&dir, state, &ram, &rest)?;
        (rest_file, without_pages) = read()?;
    }
    let image = open_checked(&ram)?;
    let mapped = armless::Ram::from_image(&image, memory).map_err(|e| format!("{}: {e}", ram.display()))?;
    // In use: kept from the pruning of unused ones
    let _ = image.set_modified(SystemTime::now());
    let _ = rest_file.set_modified(SystemTime::now());
    Ok(Image { ram: mapped, state: without_pages })
}

/// `dir`, made if missing: a directory of ours that only we can reach.
fn private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::DirBuilder::new().mode(0o700).recursive(true).create(dir) {
        Ok(()) => {}
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    }
    let m = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !m.is_dir() || m.uid() != crate::sys::euid() || m.mode() & 0o077 != 0 {
        return Err(format!("{} must be a directory of this user's that only it can reach (0700)", dir.display()));
    }
    Ok(())
}

/// `path` opened for reading if it is a regular file of ours, read-only and with one link.
fn open_checked(path: &Path) -> Result<File, String> {
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let m = f.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() || m.uid() != crate::sys::euid() || m.mode() & 0o222 != 0 || m.nlink() != 1 {
        return Err(format!("{} must be a read-only file of this user's with one link", path.display()));
    }
    Ok(f)
}

/// Splits `state` (zstd) into its image `ram` and the rest `rest`: each written whole under a
/// name of its own, made read-only, then renamed into place (the image first). Old unused images go.
fn make(dir: &Path, state: &[u8], ram: &Path, rest: &Path) -> Result<(), String> {
    prune(dir);
    let (ram_tmp, ram_file) = temp(dir, "ram")?;
    let (rest_tmp, mut rest_file) = match temp(dir, "state") {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_file(&ram_tmp);
            return Err(e);
        }
    };
    let made = (|| {
        let mut reader = zstd::stream::read::Decoder::with_buffer(state).map_err(|e| e.to_string())?;
        let without_pages = armless::vm::split_state(&mut reader, &ram_file)?;
        rest_file.write_all(&without_pages).map_err(|e| e.to_string())?;
        for (f, tmp, to) in [(&ram_file, &ram_tmp, ram), (&rest_file, &rest_tmp, rest)] {
            f.set_permissions(std::fs::Permissions::from_mode(0o444)).map_err(|e| e.to_string())?;
            std::fs::rename(tmp, to).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if made.is_err() {
        let _ = std::fs::remove_file(&ram_tmp);
        let _ = std::fs::remove_file(&rest_tmp);
    }
    made.map_err(|e: String| format!("making the RAM image in {}: {e}", dir.display()))
}

/// A new file in `dir` that only we can read and write, and its name.
fn temp(dir: &Path, ext: &str) -> Result<(PathBuf, File), String> {
    let entropy = armless::runner::os_entropy();
    let name = format!(".{}-{:016x}.{ext}", std::process::id(), u64::from_le_bytes(entropy[..8].try_into().unwrap()));
    let path = dir.join(name);
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((path, f))
}

/// Removes images (and leftovers of ones being made) not used for `UNUSED`. One a machine still
/// maps stays in memory until it lets go of it.
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > UNUSED);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::tmp;

    /// A snapshot (zstd) of a 16 MiB machine whose RAM has `byte` at page 3.
    fn snapshot(byte: u8) -> Vec<u8> {
        let (board, runner) = crate::testing::machine(&format!("image-snapshot-{byte}"));
        board.io.mem.store(3 * 4096, 1, byte as u64);
        let raw = runner.save_state();
        zstd::encode_all(&raw[..], 3).unwrap()
    }

    const MB16: usize = 16 << 20;

    #[test]
    fn an_image_is_made_once_and_restores_the_snapshot() {
        let root = tmp("image-made");
        let state = snapshot(0x5a);
        let a = open_in(&root, &state, MB16).unwrap();
        assert_eq!(a.ram.load(3 * 4096, 1), 0x5a);
        let dir = root.join("ram");
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names.len(), 2, "the image and its state, nothing left over: {names:?}");
        for n in &names {
            assert_eq!(std::fs::metadata(dir.join(n)).unwrap().mode() & 0o777, 0o444, "{n}");
        }
        // Used again, not made again; a write is this RAM's own
        let made = std::fs::metadata(dir.join(&names[0])).unwrap().ino();
        let b = open_in(&root, &state, MB16).unwrap();
        a.ram.store(3 * 4096, 1, 1);
        assert_eq!(b.ram.load(3 * 4096, 1), 0x5a);
        assert_eq!(std::fs::metadata(dir.join(&names[0])).unwrap().ino(), made);
        // Another snapshot, another image
        let c = open_in(&root, &snapshot(0x77), MB16).unwrap();
        assert_eq!(c.ram.load(3 * 4096, 1), 0x77);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 4);
        // A machine of another size doesn't take it
        assert!(open_in(&root, &state, 32 << 20).is_err());
    }

    #[test]
    fn a_restore_onto_the_image_is_the_snapshots_machine() {
        let root = tmp("image-restore");
        let state = snapshot(0x42);
        let image = open_in(&root, &state, MB16).unwrap();
        let (_, site) = crate::testing::site("image-restore-site", &[("system/filesystem.json", crate::testing::EMPTY_FS)]);
        let spec = crate::machine::Spec { memory_mb: 16, cpus: 1, network: "none".into() };
        let (vm, clock) = crate::machine::new_vm_on(&spec, &site, false, Some(image.ram)).unwrap();
        let board = vm.board.clone();
        let runner = armless::runner::Runner::new(vm, clock, false);
        runner.load_state(&image.state).unwrap();
        assert_eq!(board.io.mem.load(3 * 4096, 1), 0x42);
    }

    #[test]
    fn a_directory_others_can_reach_is_refused() {
        let root = tmp("image-open-dir");
        let dir = root.join("ram");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = open_in(&root, &snapshot(3), MB16).err().unwrap();
        assert!(e.contains("0700"), "{e}");
    }

    #[test]
    fn files_that_could_change_are_refused() {
        let root = tmp("image-files");
        let state = snapshot(9);
        open_in(&root, &state, MB16).unwrap();
        let dir = root.join("ram");
        let ram = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().unwrap() == "ram").unwrap();

        // Writable
        std::fs::set_permissions(&ram, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(open_in(&root, &state, MB16).err().unwrap().contains("read-only"));
        std::fs::set_permissions(&ram, std::fs::Permissions::from_mode(0o444)).unwrap();
        // A second link to it (one that someone could reach some other way)
        let link = root.join("elsewhere");
        std::fs::hard_link(&ram, &link).unwrap();
        assert!(open_in(&root, &state, MB16).err().unwrap().contains("one link"));
        std::fs::remove_file(&link).unwrap();
        // A symbolic link in its place
        let real = root.join("real.ram");
        std::fs::rename(&ram, &real).unwrap();
        std::os::unix::fs::symlink(&real, &ram).unwrap();
        assert!(open_in(&root, &state, MB16).is_err());
        std::fs::remove_file(&ram).unwrap();
        std::fs::rename(&real, &ram).unwrap();
        assert!(open_in(&root, &state, MB16).is_ok());
    }

    #[test]
    fn unused_images_go_when_a_new_one_is_made() {
        let root = tmp("image-prune");
        let dir = root.join("ram");
        open_in(&root, &snapshot(1), MB16).unwrap();
        let old = SystemTime::now() - UNUSED - Duration::from_secs(60);
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            File::open(e.path()).unwrap().set_modified(old).unwrap();
        }
        open_in(&root, &snapshot(2), MB16).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "only the new one's");
    }

    #[test]
    fn a_state_that_isnt_split_is_made_again() {
        let root = tmp("image-unsplit");
        let state = snapshot(0x31);
        open_in(&root, &state, MB16).unwrap();
        let rest = std::fs::read_dir(root.join("ram")).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().unwrap() == "state").unwrap();
        // A whole snapshot without pages where the split one was
        let mut unsplit = std::fs::read(&rest).unwrap();
        unsplit[19] &= 0x7f;
        std::fs::remove_file(&rest).unwrap();
        std::fs::write(&rest, &unsplit).unwrap();
        std::fs::set_permissions(&rest, std::fs::Permissions::from_mode(0o444)).unwrap();
        let image = open_in(&root, &state, MB16).unwrap();
        assert!(armless::vm::is_split_state(&image.state));
        assert_eq!(image.ram.load(3 * 4096, 1), 0x31);
    }

    #[test]
    fn a_broken_snapshot_leaves_nothing_behind() {
        let root = tmp("image-broken");
        let bad = zstd::encode_all(&b"not a snapshot"[..], 3).unwrap();
        assert!(open_in(&root, &bad, MB16).is_err());
        assert_eq!(std::fs::read_dir(root.join("ram")).unwrap().count(), 0);
    }
}
