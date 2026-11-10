import data from '../data/items.json';

export interface ItemDef {
  id: number;
  name: string;
  display: string;
  stack: number;
  maxUses: number;
  /** Icon location in the game files. The pixels are read from the user's Raft install. */
  sprite: SpriteRef | null;
}

export interface SpriteRef {
  file: string;
  id: number;
  name: string;
}

type Raw = Record<
  string,
  { name: string; display: string | null; stack: number | null; uses: number | null; sprite?: SpriteRef | null }
>;

export const ITEMS: ItemDef[] = Object.entries(data as Raw)
  .map(([id, v]) => ({
    id: Number(id),
    name: v.name,
    display: v.display || v.name,
    stack: Math.max(1, v.stack ?? 1),
    maxUses: Math.max(1, v.uses ?? 1),
    sprite: v.sprite ?? null,
  }))
  .sort((a, b) => a.display.localeCompare(b.display));

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function item(id: number): ItemDef | undefined {
  return BY_ID.get(id);
}

export function itemLabel(id: number): string {
  return BY_ID.get(id)?.display ?? `Unknown item #${id}`;
}

/** Slot counts read from each storage UI in the game files (Raft_Data/sharedassets0). */
export const STORAGE_CAPACITY: Record<number, number> = {
  140: 8, // Placeable_Storage_Small
  42: 20, // Placeable_Storage_Medium
  296: 40, // Placeable_Storage_Large
  640: 25, // Placeable_Fridge
  389: 8, // Placeable_Trashcan
  456: 4, // Placeable_Cupboard_Small
};

/** Main player inventory: hotbar plus backpack. Equipment slots are stored separately. */
export const PLAYER_INVENTORY_SLOTS = 30;

/** Slot values are stored as 16-bit signed integers. */
export const MAX_SLOT_VALUE = 32767;
