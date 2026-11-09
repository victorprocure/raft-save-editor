import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { saveFiles } from '../../nrbf/__tests__/fixtures';
import { UsersSave, WorldSave } from '../save';

const files = saveFiles();
const worldFile = files.find((f) => f.includes('-Latest'));
const usersFile = files.find((f) => f.endsWith('RGD_Users.rgd'));
const OUT = process.env.EDIT_OUT_DIR;

function emit(name: string, bytes: Uint8Array) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), bytes);
}

describe.skipIf(!worldFile)('world chests', () => {
  let src: Uint8Array;
  beforeAll(() => {
    src = new Uint8Array(readFileSync(worldFile!));
  });

  it('lists every chest with its contents', () => {
    const chests = new WorldSave(src).chests();
    expect(chests).toHaveLength(10);
    expect(chests.every((c) => c.capacity === 20)).toBe(true);
    expect(chests.map((c) => c.slots.length)).toEqual([16, 11, 13, 20, 8, 20, 19, 9, 5, 6]);
  });

  it('changes an amount in place without changing file size', () => {
    const w = new WorldSave(src);
    const c = w.chests()[0];
    const s = c.slots.find((x) => x.slotIndex === 19)!;
    w.setSlot(c.key, { ...s, amount: 20 });
    const out = w.toBytes();
    expect(out.length).toBe(src.length);
    const diff = out.reduce((n, b, i) => n + (b !== src[i] ? 1 : 0), 0);
    expect(diff).toBe(1);
    expect(new WorldSave(out).chests()[0].slots.find((x) => x.slotIndex === 19)!.amount).toBe(20);
    emit('world-amount.rgd', out);
  });

  it('adds items to empty slots in slot order', () => {
    const w = new WorldSave(src);
    const key = w.chests()[0].key;
    w.setSlot(key, { slotIndex: 2, itemIndex: 21, amount: 20, uses: 1 });
    w.setSlot(key, { slotIndex: 0, itemIndex: 22, amount: 5, uses: 1 });
    const out = w.toBytes();
    const re = new WorldSave(out);
    const slots = re.chests()[0].slots;
    expect(slots.map((s) => s.slotIndex)).toEqual([0, 2, ...Array.from({ length: 16 }, (_, i) => i + 4)]);
    expect(slots[0]).toEqual({ slotIndex: 0, itemIndex: 22, amount: 5, uses: 1 });
    expect(slots[1]).toEqual({ slotIndex: 2, itemIndex: 21, amount: 20, uses: 1 });
    // Everything else is unchanged.
    expect(re.chests().slice(1)).toEqual(new WorldSave(src).chests().slice(1));
    emit('world-add.rgd', out);
  });

  it('clears every chest slot and keeps the rest of the world intact', () => {
    const w = new WorldSave(src);
    const before = w.chests();
    for (const c of before) for (const s of c.slots) w.clearSlot(c.key, s.slotIndex);
    const out = w.toBytes();
    const re = new WorldSave(out);
    expect(re.chests()).toEqual(before.map((c) => ({ ...c, slots: [] })));
    expect(re.worldGuid).toBe(w.worldGuid);
    expect(re.day).toBe(w.day);
    emit('world-clear-all.rgd', out);
  });

  it('empties a chest completely and refills it', () => {
    const w = new WorldSave(src);
    const c = w.chests()[8];
    for (const s of c.slots) w.clearSlot(c.key, s.slotIndex);
    expect(new WorldSave(w.toBytes()).chests()[8].slots).toEqual([]);
    w.setSlot(c.key, { slotIndex: 19, itemIndex: 21, amount: 20, uses: 1 });
    const out = w.toBytes();
    expect(new WorldSave(out).chests()[8].slots).toEqual([{ slotIndex: 19, itemIndex: 21, amount: 20, uses: 1 }]);
    emit('world-refill.rgd', out);
  });

  it('changes the game mode in place', () => {
    const w = new WorldSave(src);
    expect(w.mode).toBe(5);
    w.mode = 0;
    const out = w.toBytes();
    expect(out.length).toBe(src.length);
    expect(out.reduce((n, b, i) => n + (b !== src[i] ? 1 : 0), 0)).toBe(1);
    expect(new WorldSave(out).mode).toBe(0);
    expect(() => (w.mode = 4)).toThrow();
    emit('world-mode.rgd', out);
  });

  it('refuses to switch a survival world to Creative', () => {
    // Creative worlds skip landmark loading. Switching lost every island in a real save.
    const w = new WorldSave(src);
    expect(() => (w.mode = 2)).toThrow(/Creative/);
    expect(w.mode).toBe(5);
  });

  it('rejects slots outside the chest', () => {
    const w = new WorldSave(src);
    expect(() => w.setSlot(w.chests()[0].key, { slotIndex: 20, itemIndex: 21, amount: 1, uses: 1 })).toThrow();
  });
});

describe.skipIf(!usersFile || !worldFile)('player inventory', () => {
  it('finds the player for the world and edits the inventory', () => {
    const world = new WorldSave(new Uint8Array(readFileSync(worldFile!)));
    const src = new Uint8Array(readFileSync(usersFile!));
    const u = new UsersSave(src);
    const p = u.playerForWorld(world.worldGuid)!;
    expect(p).toBeDefined();
    expect(p.inventory.slots).toHaveLength(24);
    u.setSlot(p.inventory.key, { slotIndex: 23, itemIndex: 21, amount: 20, uses: 1 });
    u.setSlot(p.inventory.key, { slotIndex: 29, itemIndex: 22, amount: 20, uses: 1 });
    u.clearSlot(p.inventory.key, 0);
    const out = u.toBytes();
    const re = new UsersSave(out).playerForWorld(world.worldGuid)!;
    expect(re.inventory.slots.map((s) => s.slotIndex)).toEqual([...Array.from({ length: 23 }, (_, i) => i + 1), 24, 29]);
    expect(new UsersSave(out).players()[1]).toEqual(new UsersSave(src).players()[1]);
    emit('users-edit.rgd', out);
  });
});
