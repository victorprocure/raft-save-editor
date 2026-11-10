import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { ask as nativeAsk, open } from '@tauri-apps/plugin-dialog';

export interface UserDir {
  path: string;
  name: string;
}

export interface WorldInfo {
  name: string;
  file: string;
  /** Snapshot folder name. Empty for a plain folder. */
  snapshot: string;
}

export interface SaveFolder {
  path: string;
  users_file: string | null;
  worlds: WorldInfo[];
  /** `<folder>.bak` when it exists. */
  backup: string | null;
  /** Where the first save creates the backup. */
  backup_path: string;
  /** Steam Cloud syncs this folder and can bring back files a restore removed. */
  steam_cloud: boolean;
}

export interface SaveResult {
  backup: string;
  created: boolean;
}

export const findUserDirs = () => invoke<UserDir[]>('find_user_dirs');

export const openFolder = (path: string) => invoke<SaveFolder>('open_folder', { path });

export async function readFile(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return new Uint8Array(buf);
}

/** Backs up the folder on first save, then replaces the file. */
export function writeSave(root: string, path: string, bytes: Uint8Array): Promise<SaveResult> {
  return invoke<SaveResult>('write_save', bytes, {
    headers: { 'x-root': encodeURIComponent(root), 'x-path': encodeURIComponent(path) },
  });
}

/** Replace the folder with its `.bak` copy. */
export const restoreBackup = (root: string) => invoke<void>('restore_backup', { root });

export const reveal = (path: string) => invoke<void>('reveal', { path });

export async function pickFolder(title = 'Select the folder that contains your Raft saves'): Promise<string | null> {
  const r = await open({ directory: true, title });
  return typeof r === 'string' ? r : null;
}

/** `Raft_Data` folder used for item icons, or null when no install was found. */
export const iconSource = () => invoke<string | null>('icon_source');

/** Use the Raft install at `path` for icons. Returns its `Raft_Data` folder. */
export const setGameDir = (path: string) => invoke<string>('set_game_dir', { path });

/** URL of an item icon. `generation` changes when the install changes, so old failures are not reused. */
export const iconUrl = (generation: number, file: string, id: number, name: string) =>
  convertFileSrc(`${generation}/${file}/${id}/${name}`, 'raft-icon');

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/** Native yes/no dialog. window.confirm() is not shown by the Linux webview and returns true. */
export function ask(message: string, title = 'Raft Save Editor'): Promise<boolean> {
  return nativeAsk(message, { title, kind: 'warning' });
}
