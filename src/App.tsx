import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import {
  ask,
  findUserDirs,
  folderName,
  openFolder,
  pickFolder,
  readFile,
  restoreBackup,
  reveal,
  writeSave,
  type SaveFolder,
  type UserDir,
} from './api';
import { SlotEditor } from './components/SlotEditor';
import { SlotGrid } from './components/SlotGrid';
import { CREATIVE, GAME_MODES, UsersSave, WorldSave, canSwitchMode, type Container } from './raft/save';
import type { SlotData } from './raft/slots';

interface Loaded {
  root: string;
  world: WorldSave;
  worldPath: string;
  users: UsersSave | null;
  usersPath: string | null;
}

type Dirty = { world: boolean; users: boolean };

export default function App() {
  const [folders, setFolders] = useState<UserDir[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [folder, setFolder] = useState<SaveFolder | null>(null);
  const [worldFile, setWorldFile] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dirty, setDirty] = useState<Dirty>({ world: false, users: false });
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<{ key: string; slot: number | null } | null>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
  const anyDirty = dirty.world || dirty.users;

  useEffect(() => {
    findUserDirs()
      .then((dirs) => {
        setFolders(dirs);
        if (dirs.length) setFolderPath(dirs[0].path);
      })
      .catch(fail);
  }, []);

  const refreshFolder = useCallback(async (path: string) => {
    const f = await openFolder(path);
    setFolder(f);
    setWorldFile((cur) => (f.worlds.some((w) => w.file === cur) ? cur : (f.worlds[0]?.file ?? '')));
    return f;
  }, []);

  useEffect(() => {
    setFolder(null);
    setWorldFile('');
    if (!folderPath) return;
    refreshFolder(folderPath).catch(fail);
  }, [folderPath, refreshFolder]);

  const readSaves = async (f: SaveFolder, file: string) => {
    const world = new WorldSave(await readFile(file));
    let users: UsersSave | null = null;
    if (f.users_file) {
      try {
        users = new UsersSave(await readFile(f.users_file));
      } catch (e) {
        setStatus({ kind: 'error', text: `Player file not loaded: ${e instanceof Error ? e.message : e}` });
      }
    }
    setLoaded({ root: f.path, world, worldPath: file, users, usersPath: f.users_file });
    setDirty({ world: false, users: false });
    setSelected(null);
    setVersion((v) => v + 1);
  };

  const load = async () => {
    if (!folder || !worldFile) return;
    if (anyDirty && !(await ask('Discard unsaved changes?'))) return;
    setBusy(true);
    setStatus(null);
    try {
      await readSaves(folder, worldFile);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      await openFolder(dir); // Validate before adding it to the list.
    } catch (e) {
      return fail(e);
    }
    if (!folders.some((d) => d.path === dir)) setFolders((d) => [...d, { path: dir, name: folderName(dir) }]);
    setFolderPath(dir);
    setStatus(null);
  };

  const restore = async () => {
    if (!folder?.backup) return;
    const cloud = folder.steam_cloud
      ? '\n\nSteam Cloud syncs this folder. Turn it off first (Steam → Raft → Properties → General → Keep game saves in Steam Cloud), ' +
        'or Steam can download the removed files again and Raft may load them instead of the original. ' +
        'Turn it back on after loading the restored world, and choose the local files if Steam reports a conflict.'
      : '';
    const msg =
      `Replace "${folderName(folder.path)}" with the original backup?\n\n` +
      'Every change made since the first save is lost, including progress the game saved since then.' +
      (anyDirty ? '\nUnsaved edits are discarded too.' : '') +
      cloud;
    if (!(await ask(msg))) return;
    setBusy(true);
    try {
      await restoreBackup(folder.path);
      const f = await refreshFolder(folder.path);
      if (loaded && loaded.root === f.path) {
        const file = f.worlds.find((w) => w.file === loaded.worldPath)?.file ?? f.worlds[0]?.file;
        if (file) await readSaves(f, file);
        else setLoaded(null);
      }
      setStatus({
        kind: 'info',
        text: f.steam_cloud
          ? 'Original restored. Keep Steam Cloud off until you have loaded and saved the world in Raft, then turn it back on and keep the local files.'
          : 'Original restored from backup.',
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Derived views. `version` forces a refresh after in-place edits.
  const view = useMemo(() => {
    if (!loaded) return null;
    const player = loaded.users?.playerForWorld(loaded.world.worldGuid) ?? null;
    return {
      chests: loaded.world.chests(),
      player,
      mode: loaded.world.mode,
      name: loaded.world.worldName,
      day: loaded.world.day,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, version]);

  const containers: { group: string; items: Container[] }[] = view
    ? [
        ...(view.player ? [{ group: 'Player', items: [view.player.inventory, view.player.equipment] }] : []),
        { group: `Storage (${view.chests.length})`, items: view.chests },
      ]
    : [];
  const all = containers.flatMap((g) => g.items);
  const active = selected ? all.find((c) => c.key === selected.key) : undefined;
  const isPlayerContainer = (key: string) => key.startsWith('inv:') || key.startsWith('equip:');

  const edit = (key: string, fn: (target: WorldSave | UsersSave) => void) => {
    if (!loaded) return;
    try {
      const player = isPlayerContainer(key);
      const target = player ? loaded.users : loaded.world;
      if (!target) throw new Error('Player file is not loaded');
      fn(target);
      setDirty((d) => (player ? { ...d, users: true } : { ...d, world: true }));
      setVersion((v) => v + 1);
      setStatus(null);
    } catch (e) {
      fail(e);
    }
  };

  const setMode = async (value: number) => {
    if (!loaded) return;
    if (value === 1 && !(await ask('Hardcore deletes the world when you die. Switch to Hardcore?'))) return;
    loaded.world.mode = value;
    setDirty((d) => ({ ...d, world: true }));
    setVersion((v) => v + 1);
  };

  const save = async () => {
    if (!loaded) return;
    setBusy(true);
    try {
      let created: string | null = null;
      const write = async (path: string, bytes: Uint8Array) => {
        const r = await writeSave(loaded.root, path, bytes);
        if (r.created) created = r.backup;
      };
      // Serialize both first so a format error stops the save before anything is written.
      const worldBytes = dirty.world ? loaded.world.toBytes() : null;
      const usersBytes = dirty.users && loaded.users ? loaded.users.toBytes() : null;
      if (worldBytes) await write(loaded.worldPath, worldBytes);
      if (usersBytes && loaded.usersPath) await write(loaded.usersPath, usersBytes);
      setDirty({ world: false, users: false });
      await refreshFolder(loaded.root);
      setStatus({
        kind: 'info',
        text: created ? `Saved. The original folder was backed up to ${created}` : 'Saved. The original backup is unchanged.',
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const activeSlot = active && selected?.slot != null ? active.slots.find((s) => s.slotIndex === selected.slot) : undefined;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Raft Save Editor</h1>
        <label>
          Save folder
          <select value={folderPath} onChange={(e) => setFolderPath(e.target.value)}>
            {folders.length === 0 && <option value="">No saves found</option>}
            {folders.map((d) => (
              <option key={d.path} value={d.path} title={d.path}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={chooseFolder}>Open folder…</button>
        <label>
          World
          <select value={worldFile} onChange={(e) => setWorldFile(e.target.value)} disabled={!folder?.worlds.length}>
            {folder?.worlds.map((w) => (
              <option key={w.file} value={w.file}>
                {w.snapshot ? `${w.name} (${w.snapshot})` : w.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={load} disabled={!worldFile || busy}>
          Load
        </button>
        <span className="spacer" />
        <button className="primary" onClick={save} disabled={!anyDirty || busy}>
          Save{anyDirty ? ' *' : ''}
        </button>
      </header>

      {folder && (
        <div className="backup-bar">
          {folder.backup ? (
            <>
              <span>
                Original backup: <code title={folder.backup}>{folderName(folder.backup)}</code>
              </span>
              <button onClick={() => reveal(folder.backup!).catch(fail)}>Show</button>
              <button className="danger" onClick={restore} disabled={busy}>
                Restore original
              </button>
              {folder.steam_cloud && <span className="warn">Turn off Steam Cloud for Raft before restoring.</span>}
            </>
          ) : (
            <span className="muted">
              The first save copies this folder to <code title={folder.backup_path}>{folderName(folder.backup_path)}</code> so you
              can restore the original.
            </span>
          )}
        </div>
      )}
      <p className="notice">Close Raft before saving. The game overwrites the save while it is running.</p>
      {status && <p className={`status ${status.kind}`}>{status.text}</p>}

      {!view ? (
        <main className="empty">
          <p>Pick a save folder or open one, choose a world, then press Load.</p>
        </main>
      ) : (
        <main className="layout">
          <aside className="sidebar">
            <section className="world">
              <h2>{view.name}</h2>
              <p className="muted">Day {view.day}</p>
              <label>
                Game mode
                <select
                  value={view.mode}
                  onChange={(e) => setMode(Number(e.target.value))}
                  disabled={view.mode === CREATIVE}
                >
                  {GAME_MODES.filter((m) => canSwitchMode(view.mode, m.value)).map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                  {!GAME_MODES.some((m) => m.value === view.mode) && <option value={view.mode}>Unknown ({view.mode})</option>}
                </select>
              </label>
              <p className="muted small">
                {view.mode === CREATIVE
                  ? 'Creative worlds cannot be switched to a survival mode.'
                  : 'Creative is a separate world type and cannot be switched to.'}
              </p>
            </section>
            {!view.player && loaded?.users && (
              <p className="muted small">No player entry for this world in RGD_Users.rgd.</p>
            )}
            {containers.map((g) => (
              <section key={g.group}>
                <h2>{g.group}</h2>
                <ul className="containers">
                  {g.items.map((c) => (
                    <li key={c.key}>
                      <button
                        className={selected?.key === c.key ? 'selected' : undefined}
                        onClick={() => setSelected({ key: c.key, slot: null })}
                      >
                        <span>{c.label}</span>
                        <span className="muted">
                          {c.slots.length}/{c.capacity ?? '?'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </aside>

          <section className="content">
            {!active ? (
              <p className="muted">Select a container.</p>
            ) : (
              <>
                <h2>{active.label}</h2>
                {'position' in active && (
                  <p className="muted small">
                    Raft position {(active as { position: number[] }).position.map((n) => n.toFixed(1)).join(', ')}
                  </p>
                )}
                <SlotGrid
                  container={active}
                  selected={selected?.slot ?? null}
                  onSelect={(slot) => setSelected({ key: active.key, slot })}
                />
                {selected?.slot != null && (
                  <SlotEditor
                    slotIndex={selected.slot}
                    slot={activeSlot}
                    canAdd={active.capacity !== null}
                    onApply={(data: SlotData) => edit(active.key, (t) => t.setSlot(active.key, data))}
                    onClear={() => edit(active.key, (t) => t.clearSlot(active.key, selected.slot!))}
                  />
                )}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
