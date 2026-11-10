mod icons;
mod saves;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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

/// Steam library folders (each holds `steamapps/`).
fn steam_libraries() -> Vec<PathBuf> {
    let mut steam_dirs = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(p) = std::env::var_os(var) {
                steam_dirs.push(PathBuf::from(p).join("Steam"));
            }
        }
    } else if let Some(h) = home() {
        steam_dirs.extend([
            h.join(".local/share/Steam"),
            h.join(".steam/steam"),
            h.join(".steam/root"),
            h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
        ]);
    }
    let mut libraries: Vec<PathBuf> = Vec::new();
    for s in &steam_dirs {
        if s.join("steamapps").is_dir() {
            libraries.push(s.clone());
        }
        if let Ok(vdf) = fs::read_to_string(s.join("steamapps").join("libraryfolders.vdf")) {
            libraries.extend(library_paths(&vdf));
        }
    }
    libraries
}

/// `Raft_Data` folder of the first Raft install found in a Steam library.
fn find_raft_data() -> Option<PathBuf> {
    steam_libraries()
        .into_iter()
        .find_map(|lib| icons::data_dir_for(&lib.join("steamapps").join("common").join("Raft")))
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
    for lib in steam_libraries() {
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

/// Raft install used for item icons, or None when none was found.
#[tauri::command]
fn icon_source(store: tauri::State<'_, Arc<icons::IconStore>>) -> Option<String> {
    store.data_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Use the Raft install at `path` (the game folder or `Raft_Data`) for icons.
#[tauri::command]
fn set_game_dir(store: tauri::State<'_, Arc<icons::IconStore>>, path: String) -> Result<String, String> {
    let dir = icons::data_dir_for(Path::new(&path)).ok_or(format!("No Raft game files in {path}"))?;
    store.set_data_dir(Some(dir.clone()));
    Ok(dir.to_string_lossy().into_owned())
}

/// `raft-icon://localhost/<generation>/<asset file>/<sprite id>/<sprite name>`, percent-encoded as
/// one path segment. Answers with a PNG or 404.
fn serve_icon(store: &icons::IconStore, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'));
    let parts: Vec<&str> = decoded.splitn(4, '/').collect();
    let result = match parts.as_slice() {
        [_, file, id, name] => id
            .parse::<i64>()
            .map_err(|e| e.to_string())
            .and_then(|id| store.icon_png(file, id, name)),
        _ => Err("Bad icon path".into()),
    };
    let builder = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*");
    match result {
        Ok(png) => builder
            .header("Content-Type", "image/png")
            .header("Cache-Control", "max-age=31536000, immutable")
            .body(png.to_vec())
            .unwrap(),
        Err(_) => builder.status(404).body(Vec::new()).unwrap(),
    }
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
    let store = Arc::new(icons::IconStore::new(find_raft_data()));
    let protocol_store = store.clone();
    tauri::Builder::default()
        .manage(store)
        .register_asynchronous_uri_scheme_protocol("raft-icon", move |_ctx, request, responder| {
            let store = protocol_store.clone();
            let path = request.uri().path().to_string();
            // Decoding reads game files. Keep it off the UI thread.
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve_icon(&store, &path)));
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            find_user_dirs,
            open_folder,
            read_file,
            write_save,
            restore_backup,
            reveal,
            icon_source,
            set_game_dir
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
