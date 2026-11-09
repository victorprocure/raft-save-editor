//! Save folder discovery, whole-folder backup, and restore.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const USERS_FILE: &str = "RGD_Users.rgd";
const SETTINGS_FILE: &str = "Settings.rgd";
const BACKUP_SUFFIX: &str = ".bak";
/// Steam writes this file into save folders it syncs with Steam Cloud.
const STEAM_CLOUD_MARKER: &str = "steam_autocloud.vdf";

#[derive(Serialize, Debug, PartialEq)]
pub struct WorldInfo {
    pub name: String,
    /// The world file the game loads.
    pub file: String,
    /// Snapshot folder name, empty for a flat folder.
    pub snapshot: String,
}

#[derive(Serialize, Debug)]
pub struct SaveFolder {
    pub path: String,
    pub users_file: Option<String>,
    pub worlds: Vec<WorldInfo>,
    /// Path of the `<folder>.bak` copy when it exists.
    pub backup: Option<String>,
    /// Where the backup is created on first save.
    pub backup_path: String,
    /// Steam Cloud syncs this folder. It can bring back files that a restore removed.
    pub steam_cloud: bool,
}

/// Read a save folder. Accepts the game's layout (`Player/` + `World/`) or a
/// plain folder holding `RGD_Users.rgd` and one or more world `.rgd` files.
pub fn open_folder(dir: &Path) -> Result<SaveFolder, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let mut users = None;
    let mut worlds = Vec::new();

    let game_users = dir.join("Player").join(USERS_FILE);
    if game_users.is_file() {
        users = Some(game_users);
    }
    if dir.join("World").is_dir() {
        worlds.extend(game_layout_worlds(&dir.join("World")));
    }

    // Plain folder with the .rgd files directly inside.
    if dir.join(USERS_FILE).is_file() {
        users.get_or_insert(dir.join(USERS_FILE));
    }
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_file() && name.ends_with(".rgd") && name != USERS_FILE && name != SETTINGS_FILE {
            worlds.push(WorldInfo {
                name: name.trim_end_matches(".rgd").to_string(),
                file: p.to_string_lossy().into_owned(),
                snapshot: String::new(),
            });
        }
    }

    if users.is_none() && worlds.is_empty() {
        return Err(format!(
            "No Raft saves in {}. Pick the folder that holds {USERS_FILE} and the world save, or the User_<id> folder with Player and World inside.",
            dir.display()
        ));
    }
    worlds.sort_by(|a, b| a.name.cmp(&b.name).then(a.snapshot.cmp(&b.snapshot)));
    let backup = backup_path(dir)?;
    Ok(SaveFolder {
        path: dir.to_string_lossy().into_owned(),
        users_file: users.map(|p| p.to_string_lossy().into_owned()),
        worlds,
        backup: backup.is_dir().then(|| backup.to_string_lossy().into_owned()),
        backup_path: backup.to_string_lossy().into_owned(),
        steam_cloud: dir.join(STEAM_CLOUD_MARKER).is_file(),
    })
}

/// `World/<name>/<snapshot>/<name>.rgd`: pick the `-Latest` snapshot, else the newest.
fn game_layout_worlds(world_root: &Path) -> Vec<WorldInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(world_root) else { return out };
    for e in entries.flatten() {
        let dir = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !dir.is_dir() || name == "OldSaveSystem-Backup" {
            continue;
        }
        let file_name = format!("{name}.rgd");
        let mut snapshots: Vec<String> = fs::read_dir(&dir)
            .map(|it| {
                it.flatten()
                    .filter(|s| s.path().join(&file_name).is_file())
                    .map(|s| s.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        // Snapshot folders are named yyyy.MM.dd-HH.mm, so name order is time order.
        snapshots.sort();
        let chosen = snapshots
            .iter()
            .find(|s| s.ends_with("-Latest"))
            .or_else(|| snapshots.last())
            .cloned();
        if let Some(snapshot) = chosen {
            out.push(WorldInfo {
                file: dir.join(&snapshot).join(&file_name).to_string_lossy().into_owned(),
                name,
                snapshot,
            });
        }
    }
    out
}

pub fn backup_path(dir: &Path) -> Result<PathBuf, String> {
    let name = dir
        .file_name()
        .ok_or_else(|| format!("Cannot back up {}", dir.display()))?
        .to_string_lossy();
    Ok(dir.with_file_name(format!("{name}{BACKUP_SUFFIX}")))
}

/// Copy the folder to `<folder>.bak` unless that backup already exists.
/// The first backup holds the untouched original, so later saves never replace it.
/// Returns the backup path and whether it was created now.
pub fn ensure_backup(dir: &Path) -> Result<(PathBuf, bool), String> {
    let backup = backup_path(dir)?;
    if backup.is_dir() {
        return Ok((backup, false));
    }
    if backup.exists() {
        return Err(format!("{} exists and is not a folder", backup.display()));
    }
    let tmp = with_suffix(&backup, ".tmp");
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(|e| format!("Cannot clear {}: {e}", tmp.display()))?;
    }
    copy_dir(dir, &tmp).map_err(|e| format!("Backup failed: {e}"))?;
    fs::rename(&tmp, &backup).map_err(|e| format!("Backup failed: {e}"))?;
    Ok((backup, true))
}

/// Replace the folder with the contents of `<folder>.bak`. The backup stays in place.
pub fn restore_backup(dir: &Path) -> Result<(), String> {
    let backup = backup_path(dir)?;
    if !backup.is_dir() {
        return Err(format!("No backup at {}", backup.display()));
    }
    // Copy first, then swap, so a failed copy leaves the current folder untouched.
    let incoming = with_suffix(dir, ".restore");
    let outgoing = with_suffix(dir, ".replaced");
    for p in [&incoming, &outgoing] {
        if p.exists() {
            fs::remove_dir_all(p).map_err(|e| format!("Cannot clear {}: {e}", p.display()))?;
        }
    }
    copy_dir(&backup, &incoming).map_err(|e| format!("Restore failed: {e}"))?;
    fs::rename(dir, &outgoing).map_err(|e| format!("Restore failed: {e}"))?;
    if let Err(e) = fs::rename(&incoming, dir) {
        // Put the original folder back.
        let _ = fs::rename(&outgoing, dir);
        return Err(format!("Restore failed: {e}"));
    }
    fs::remove_dir_all(&outgoing).map_err(|e| format!("Restored, but could not remove {}: {e}", outgoing.display()))
}

/// Write a save file inside `root`, backing up `root` first.
pub fn write_save(root: &Path, target: &Path, bytes: &[u8]) -> Result<(PathBuf, bool), String> {
    let root_c = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let target_c = fs::canonicalize(target).map_err(|e| format!("{}: {e}", target.display()))?;
    if !target_c.starts_with(&root_c) {
        return Err(format!("{} is outside the opened folder", target.display()));
    }
    let backup = ensure_backup(&root_c)?;

    let tmp = with_suffix(&target_c, ".tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Write failed: {e}"))?;
    // Keep the original file's permissions on the replacement.
    if let Ok(meta) = fs::metadata(&target_c) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, &target_c).map_err(|e| format!("Replace failed: {e}"))?;
    Ok(backup)
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let src = e.path();
        let dst = to.join(e.file_name());
        let ty = e.file_type()?;
        if ty.is_dir() {
            copy_dir(&src, &dst)?;
        } else if ty.is_file() {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "raft-save-editor-test-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(p: &Path, data: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }

    fn game_layout(root: &Path) -> PathBuf {
        let user = root.join("User_1");
        write(&user.join("Player").join(USERS_FILE), b"users");
        write(&user.join("Player").join(SETTINGS_FILE), b"settings");
        write(&user.join("World/Learning/2026.11.09-11.08/Learning.rgd"), b"old");
        write(&user.join("World/Learning/2026.11.09-12.15-Latest/Learning.rgd"), b"latest");
        write(&user.join("World/Learning/2026.11.09-12.30/Learning.rgd"), b"newer-name");
        user
    }

    #[test]
    fn opens_game_layout() {
        let t = TempDir::new("game");
        let user = game_layout(&t.0);
        let f = open_folder(&user).unwrap();
        assert!(f.users_file.unwrap().ends_with("Player/RGD_Users.rgd"));
        assert_eq!(f.worlds.len(), 1);
        assert_eq!(f.worlds[0].name, "Learning");
        assert_eq!(f.worlds[0].snapshot, "2026.11.09-12.15-Latest");
        assert_eq!(f.backup, None);
        assert!(f.backup_path.ends_with("User_1.bak"));
        assert!(!f.steam_cloud);
        write(&user.join(STEAM_CLOUD_MARKER), b"\"steam_autocloud.vdf\"");
        assert!(open_folder(&user).unwrap().steam_cloud);
    }

    #[test]
    fn opens_flat_folder() {
        let t = TempDir::new("flat");
        let dir = t.0.join("MySaves");
        write(&dir.join(USERS_FILE), b"users");
        write(&dir.join(SETTINGS_FILE), b"settings");
        write(&dir.join("Learning.rgd"), b"world");
        let f = open_folder(&dir).unwrap();
        assert!(f.users_file.unwrap().ends_with("MySaves/RGD_Users.rgd"));
        assert_eq!(
            f.worlds,
            vec![WorldInfo { name: "Learning".into(), file: dir.join("Learning.rgd").to_string_lossy().into(), snapshot: String::new() }]
        );
    }

    #[test]
    fn rejects_folder_without_saves() {
        let t = TempDir::new("empty");
        assert!(open_folder(&t.0).is_err());
    }

    #[test]
    fn first_save_backs_up_original_and_later_saves_keep_it() {
        let t = TempDir::new("backup");
        let user = game_layout(&t.0);
        let world = user.join("World/Learning/2026.11.09-12.15-Latest/Learning.rgd");

        let (backup, created) = write_save(&user, &world, b"edit-1").unwrap();
        assert!(created);
        assert_eq!(fs::read(&world).unwrap(), b"edit-1");
        let backed = backup.join("World/Learning/2026.11.09-12.15-Latest/Learning.rgd");
        assert_eq!(fs::read(&backed).unwrap(), b"latest");
        assert_eq!(fs::read(backup.join("Player").join(USERS_FILE)).unwrap(), b"users");

        let (_, created) = write_save(&user, &world, b"edit-2").unwrap();
        assert!(!created);
        assert_eq!(fs::read(&backed).unwrap(), b"latest");
        assert!(open_folder(&user).unwrap().backup.is_some());
    }

    #[test]
    fn refuses_files_outside_the_folder() {
        let t = TempDir::new("outside");
        let user = game_layout(&t.0);
        let other = t.0.join("other.rgd");
        write(&other, b"x");
        assert!(write_save(&user, &other, b"y").is_err());
        assert!(!backup_path(&user).unwrap().exists());
    }

    #[test]
    fn restore_replaces_folder_with_backup() {
        let t = TempDir::new("restore");
        let user = game_layout(&t.0);
        let world = user.join("World/Learning/2026.11.09-12.15-Latest/Learning.rgd");
        write_save(&user, &world, b"edited").unwrap();
        // The game wrote a new snapshot after the edit.
        write(&user.join("World/Learning/2026.11.09-13.00/Learning.rgd"), b"game-after-edit");

        restore_backup(&user).unwrap();
        assert_eq!(fs::read(&world).unwrap(), b"latest");
        assert!(!user.join("World/Learning/2026.11.09-13.00").exists());
        assert!(backup_path(&user).unwrap().is_dir());
        assert!(!with_suffix(&user, ".replaced").exists());
        assert!(!with_suffix(&user, ".restore").exists());
    }

    #[test]
    fn restore_without_backup_fails() {
        let t = TempDir::new("nobackup");
        let user = game_layout(&t.0);
        assert!(restore_backup(&user).is_err());
    }
}
