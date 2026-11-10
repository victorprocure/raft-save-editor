# Raft Save Editor

Desktop editor for Raft save files (`.rgd`). Change item amounts, add or clear items in chests and the player inventory, and change the world's game mode.

Built with Tauri 2 (Rust) and React. Runs on Windows and on Linux/Steam Deck (Proton saves are found automatically).

## Use

1. Close Raft.
2. Pick a detected save folder, or press Open folder and choose either the `User_<id>` folder (with `Player` and `World` inside) or a folder holding `RGD_Users.rgd` and the world `.rgd`.
3. Choose the world and press Load.
4. Select a chest or the inventory, click a slot, edit, then press Save.

Ctrl-click (Cmd on macOS) adds or removes a slot from the selection, and Shift-click selects a range. The editor panel then fills every selected slot with one item and amount, or raises or clears them together. Max all stacks raises every stack in the container to its limit. The item search and the picked item stay when you change slot or container.

Item icons are read from your Raft install, so no game art ships with the editor. The install is found through your Steam libraries. If it isn't found, press Locate Raft and pick the game folder.

The first save copies the whole folder to `<folder>.bak` next to it. Later saves leave that copy alone, so it always holds the original. Restore original replaces the folder with the `.bak` copy.

## Develop

```sh
npm install
npm run tauri dev      # run the app
npx vitest run         # format and edit tests (use saves in ../Player and ../World when present)
npm run tauri build    # installer for the current OS
```

Tauri builds installers for the OS it runs on. Build on Windows for a Windows installer.

## Layout

- `src/nrbf` reads and writes .NET BinaryFormatter data. Unedited files serialize back byte for byte.
- `src/raft` maps Raft's save classes: chests, player inventory, game mode.
- `src/data/items.json` item IDs, names, stack sizes, durability and icon locations, extracted from the game by `tools/extract_items.py`.
- `tools/NrbfVerify` decodes files with Microsoft's `System.Formats.Nrbf` as an independent check.
- `src-tauri` finds save folders, reads files, writes saves, and handles the `.bak` folder backup and restore (`src-tauri/src/saves.rs`). `src-tauri/src/icons.rs` decodes item icons from the game's Unity files and serves them over the `raft-icon://` protocol.
