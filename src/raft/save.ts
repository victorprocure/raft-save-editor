import { parse, serialize } from '../nrbf/codec';
import { Graph, field, hasField, num, setNum, str, validate } from '../nrbf/graph';
import type { BinArrRec, ClassRec } from '../nrbf/types';
import { PLAYER_INVENTORY_SLOTS, STORAGE_CAPACITY, itemLabel } from './items';
import { clearSlot, readSlots, setSlot, slotArray, type SlotData } from './slots';

/** One editable set of slots: a chest or a player inventory. */
export interface Container {
  key: string;
  label: string;
  /** Number of slots the game shows. Null when unknown, which disables adding to empty slots. */
  capacity: number | null;
  slots: SlotData[];
}

abstract class SaveFile {
  readonly graph: Graph;
  constructor(bytes: Uint8Array) {
    this.graph = new Graph(parse(bytes));
  }
  protected abstract owner(key: string): { obj: ClassRec; field: string; capacity: number | null };

  setSlot(key: string, data: SlotData) {
    const o = this.owner(key);
    if (o.capacity !== null && (data.slotIndex < 0 || data.slotIndex >= o.capacity))
      throw new Error(`Slot ${data.slotIndex} is outside this container (${o.capacity} slots)`);
    if (o.capacity === null && !readSlots(this.graph, slotArray(this.graph, o.obj, o.field)).some((s) => s.slotIndex === data.slotIndex))
      throw new Error('Unknown container size. Only existing slots can be edited.');
    setSlot(this.graph, o.obj, o.field, data);
  }

  clearSlot(key: string, slotIndex: number) {
    const o = this.owner(key);
    clearSlot(this.graph, o.obj, o.field, slotIndex);
  }

  toBytes(): Uint8Array {
    validate(this.graph.doc);
    const out = serialize(this.graph.doc);
    // Re-read the output so a broken file is never written.
    validate(parse(out));
    return out;
  }
}

/** GameMode enum values from Assembly-CSharp.dll. 4 (None) is internal. */
export const GAME_MODES = [
  { value: 0, label: 'Normal' },
  { value: 3, label: 'Easy' },
  { value: 5, label: 'Peaceful' },
  { value: 1, label: 'Hardcore' },
  { value: 2, label: 'Creative' },
] as const;

/**
 * Creative is a separate world type, not a difficulty. The game skips loading
 * islands and other landmarks for Creative worlds, so switching a survival
 * world to Creative loses them and the next save deletes their data.
 * Switching is allowed only between the survival modes.
 */
export const CREATIVE = 2;

export function canSwitchMode(from: number, to: number): boolean {
  if (!GAME_MODES.some((m) => m.value === to)) return false;
  return from === to || (from !== CREATIVE && to !== CREATIVE);
}

export interface Chest extends Container {
  blockIndex: number;
  position: [number, number, number];
}

export class WorldSave extends SaveFile {
  get game(): ClassRec {
    return this.graph.root();
  }
  get world(): ClassRec {
    return this.graph.obj(field(this.game, 'World'));
  }
  get worldName(): string {
    return str(this.graph, this.game, 'WorldName') ?? '';
  }
  get worldGuid(): string {
    return str(this.graph, this.world, 'WorldGuid') ?? '';
  }
  get day(): number {
    return num(this.world, 'DayCounter');
  }

  private get modeObj(): ClassRec {
    return this.graph.obj(field(this.game, 'Mode'));
  }
  get mode(): number {
    return num(this.modeObj, 'value__');
  }
  set mode(value: number) {
    if (!GAME_MODES.some((m) => m.value === value)) throw new Error(`Unknown game mode ${value}`);
    if (!canSwitchMode(this.mode, value))
      throw new Error('Creative is a separate world type. Worlds cannot be switched into or out of Creative.');
    setNum(this.modeObj, 'value__', value);
  }

  private storageObjects(): ClassRec[] {
    const list = this.graph.obj(field(this.game, 'Behaviours'));
    const items = this.graph.resolve(field(list, '_items'));
    const size = num(list, '_size');
    if (!items || (items.kind !== 'arrsingle' && items.kind !== 'binarr')) return [];
    const out: ClassRec[] = [];
    let i = 0;
    for (const it of items.items) {
      if (i >= size) break;
      i += it.kind === 'nullm' ? it.count : 1;
      if (it.kind === 'prim') continue;
      const o = this.graph.maybeObj(it);
      if (o && hasField(o, 'Slots') && hasField(o, 'BlockIndex')) out.push(o);
    }
    return out;
  }

  chests(): Chest[] {
    return this.storageObjects().map((o) => {
      const blockIndex = num(o, 'BlockIndex');
      const id = num(o, 'ObjectIndex');
      const capacity = STORAGE_CAPACITY[blockIndex] ?? null;
      return {
        key: `storage:${id}`,
        label: `${itemLabel(blockIndex)} #${id}`,
        capacity,
        blockIndex,
        position: [num(o, 'BlockPositionX'), num(o, 'BlockPositionY'), num(o, 'BlockPositionZ')],
        slots: readSlots(this.graph, slotArray(this.graph, o, 'Slots')),
      };
    });
  }

  protected owner(key: string) {
    const id = Number(key.replace(/^storage:/, ''));
    const obj = this.storageObjects().find((o) => num(o, 'ObjectIndex') === id);
    if (!obj) throw new Error(`Storage ${key} not found`);
    return { obj, field: 'Slots', capacity: STORAGE_CAPACITY[num(obj, 'BlockIndex')] ?? null };
  }
}

export interface PlayerEntry {
  index: number;
  steamId: string;
  worldGuid: string;
  inventory: Container;
  /** Equipped items. Shown read-only apart from amount and durability edits. */
  equipment: Container;
}

export class UsersSave extends SaveFile {
  private userObjects(): ClassRec[] {
    const list = this.graph.obj(field(this.graph.root(), 'Users'));
    const items = this.graph.resolve(field(list, '_items'));
    const size = num(list, '_size');
    if (!items || (items.kind !== 'arrsingle' && items.kind !== 'binarr')) return [];
    return items.items
      .filter((it) => it.kind !== 'prim')
      .map((it) => this.graph.maybeObj(it as ClassRec))
      .filter((o): o is ClassRec => !!o)
      .slice(0, size);
  }

  private inventory(user: ClassRec): ClassRec {
    return this.graph.obj(field(this.graph.obj(field(user, 'Player')), 'Inventory'));
  }

  players(): PlayerEntry[] {
    return this.userObjects().map((u, index) => {
      const inv = this.inventory(u);
      const steam = field(u, 'SteamID');
      return {
        index,
        steamId: steam.kind === 'prim' ? String(steam.v) : '',
        worldGuid: str(this.graph, u, 'WorldGuid') ?? '',
        inventory: {
          key: `inv:${index}`,
          label: 'Inventory',
          capacity: PLAYER_INVENTORY_SLOTS,
          slots: readSlots(this.graph, slotArray(this.graph, inv, 'Slots')),
        },
        equipment: {
          key: `equip:${index}`,
          label: 'Equipment',
          capacity: null,
          slots: readSlots(this.graph, slotArray(this.graph, inv, 'EquipSlots') as BinArrRec | null),
        },
      };
    });
  }

  playerForWorld(worldGuid: string): PlayerEntry | undefined {
    return this.players().find((p) => p.worldGuid === worldGuid);
  }

  protected owner(key: string) {
    const [kind, idx] = key.split(':');
    const user = this.userObjects()[Number(idx)];
    if (!user) throw new Error(`Player ${idx} not found`);
    const inv = this.inventory(user);
    if (kind === 'inv') return { obj: inv, field: 'Slots', capacity: PLAYER_INVENTORY_SLOTS };
    if (kind === 'equip') return { obj: inv, field: 'EquipSlots', capacity: null };
    throw new Error(`Unknown container ${key}`);
  }
}
