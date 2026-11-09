mod saves;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

const RAFT_APP_ID: &str = "648800";

#[derive(Serialize)]
struct UserDir {
    /// Folder holding `Player/` and `World/`.
    path: String,
    /// `User_<steamid>` folder name.
    name: String,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// `LocalLow/Redbeet Interactive/Raft/User` folders that may hold saves.
fn candidate_user_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let tail = Path::new("Redbeet Interactive").join("Raft").join("User");

    if cfg!(windows) {
        if let Some(h) = home() {
            roots.push(h.join("AppData").join("LocalLow").join(&tail));
        }
        return roots;
    }

    // Linux and Steam Deck: the game runs under Proton, saves live in its prefix.
    let Some(h) = home() else { return roots };
    let steam_dirs = [
        h.join(".local/share/Steam"),
        h.join(".steam/steam"),
        h.join(".steam/root"),
        h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    ];
    let mut libraries: Vec<PathBuf> = Vec::new();
    for s in &steam_dirs {
        if s.join("steamapps").is_dir() {
            libraries.push(s.clone());
        }
        if let Ok(vdf) = fs::read_to_string(s.join("steamapps/libraryfolders.vdf")) {
            libraries.extend(library_paths(&vdf));
        }
    }
    for lib in libraries {
        let prefix = lib
            .join("steamapps/compatdata")
            .join(RAFT_APP_ID)
            .join("pfx/drive_c/users/steamuser/AppData/LocalLow");
        roots.push(prefix.join(&tail));
    }
    roots
}

/// Extract `"path" "<dir>"` entries from Steam's libraryfolders.vdf.
fn library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('"').collect();
            // Line shape: <ws>"path"<ws>"<value>"
            if parts.len() >= 4 && parts[1] == "path" {
                Some(PathBuf::from(parts[3].replace("\\\\", "\\")))
            } else {
                None
            }
        })
        .collect()
}

fn canonical_key(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[tauri::command]
fn find_user_dirs() -> Vec<UserDir> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for root in candidate_user_roots() {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            // Skip editor backups (`User_<id>.bak`) and leftovers from interrupted operations.
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".bak") || name.ends_with(".tmp") || name.ends_with(".restore") || name.ends_with(".replaced") {
                continue;
            }
            if !p.join("World").is_dir() && !p.join("Player").is_dir() {
                continue;
            }
            if !seen.insert(canonical_key(&p)) {
                continue;
            }
            out.push(UserDir {
                name,
                path: p.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

#[tauri::command]
fn open_folder(path: String) -> Result<saves::SaveFolder, String> {
    saves::open_folder(Path::new(&path))
}

#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

#[derive(Serialize)]
struct SaveResult {
    backup: String,
    /// True when this save created the backup.
    created: bool,
}

/// Back up the opened folder to `<folder>.bak` (first save only), then replace the file.
/// Headers: `x-root` is the opened folder, `x-path` the file to replace. Body: file bytes.
#[tauri::command]
fn write_save(request: tauri::ipc::Request<'_>) -> Result<SaveResult, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw file bytes".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .ok_or(format!("Missing {name} header"))
    };
    let root = header("x-root")?;
    let path = header("x-path")?;
    let (backup, created) = saves::write_save(Path::new(&root), Path::new(&path), bytes)?;
    Ok(SaveResult { backup: backup.to_string_lossy().into_owned(), created })
}

#[tauri::command]
fn restore_backup(root: String) -> Result<(), String> {
    saves::restore_backup(Path::new(&root))
}

/// Open a folder in the system file manager.
#[tauri::command]
fn reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            find_user_dirs,
            open_folder,
            read_file,
            write_save,
            restore_backup,
            reveal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_paths() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"/home/u/.local/share/Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(
            library_paths(vdf),
            vec![PathBuf::from("/home/u/.local/share/Steam"), PathBuf::from("D:\\SteamLibrary")]
        );
    }

    #[test]
    fn decodes_percent_paths() {
        assert_eq!(percent_decode("/a%20b/R%C3%A5ft"), "/a b/Råft");
    }
}
