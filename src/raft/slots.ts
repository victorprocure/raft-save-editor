import { Graph, field, num, removeArrayElement, setNum, walk } from '../nrbf/graph';
import { BT, PT, RT, type BinArrRec, type ClassMeta, type ClassRec, type Rec } from '../nrbf/types';
import { MAX_SLOT_VALUE } from './items';

export interface SlotData {
  slotIndex: number;
  itemIndex: number;
  amount: number;
  uses: number;
}

const SLOT_CLASS = 'RGD_Slot';
const SLOT_MEMBERS = ['SlotIndex', 'ItemIndex', 'ItemAmount', 'ItemUses', 'ExclusiveString'];

/** Resolve an owner's slot array field. Returns null when the field is null. */
export function slotArray(g: Graph, owner: ClassRec, fieldName: string): BinArrRec | null {
  const r = g.resolve(field(owner, fieldName));
  if (!r) return null;
  if (r.kind !== 'binarr') throw new Error(`${owner.meta.name}.${fieldName} is not a slot array`);
  return r;
}

function slotRecords(g: Graph, arr: BinArrRec): ClassRec[] {
  const out: ClassRec[] = [];
  for (const it of arr.items) {
    if (it.kind === 'prim' || it.kind === 'null' || it.kind === 'nullm') continue;
    const o = g.maybeObj(it);
    if (o && o.meta.name === SLOT_CLASS) out.push(o);
  }
  return out;
}

export function readSlots(g: Graph, arr: BinArrRec | null): SlotData[] {
  if (!arr) return [];
  return slotRecords(g, arr).map((o) => ({
    slotIndex: num(o, 'SlotIndex'),
    itemIndex: num(o, 'ItemIndex'),
    amount: num(o, 'ItemAmount'),
    uses: num(o, 'ItemUses'),
  }));
}

function clamp(v: number, min: number) {
  if (!Number.isInteger(v)) throw new Error(`${v} is not a whole number`);
  return Math.max(min, Math.min(MAX_SLOT_VALUE, v));
}

/** Copy the slot class layout used in this file so new slots match it exactly. */
function slotMeta(g: Graph): ClassMeta {
  let found: ClassMeta | null = null;
  walk(g.doc, (r) => {
    if (!found && r.kind === 'class' && r.meta.name === SLOT_CLASS) found = r.meta;
  });
  if (found) {
    const m = found as ClassMeta;
    return {
      rt: RT.ClassWithMembersAndTypes,
      name: m.name,
      members: [...m.members],
      binaryTypes: m.binaryTypes ? [...m.binaryTypes] : SLOT_MEMBERS.map((_, i) => (i < 4 ? BT.Primitive : BT.String)),
      typeInfos: m.typeInfos ? [...m.typeInfos] : [PT.Int16, PT.Int16, PT.Int16, PT.Int16, null],
      libraryId: m.libraryId ?? assemblyLibraryId(g),
    };
  }
  return {
    rt: RT.ClassWithMembersAndTypes,
    name: SLOT_CLASS,
    members: [...SLOT_MEMBERS],
    binaryTypes: [BT.Primitive, BT.Primitive, BT.Primitive, BT.Primitive, BT.String],
    typeInfos: [PT.Int16, PT.Int16, PT.Int16, PT.Int16, null],
    libraryId: assemblyLibraryId(g),
  };
}

function assemblyLibraryId(g: Graph): number {
  let id: number | null = null;
  walk(g.doc, (r) => {
    for (const l of r.libs ?? []) if (id === null && l.name.startsWith('Assembly-CSharp')) id = l.id;
  });
  if (id === null) throw new Error('Assembly-CSharp library record not found');
  return id;
}

function newSlot(g: Graph, data: SlotData): ClassRec {
  const meta = slotMeta(g);
  // A full class definition per new slot keeps it independent of where earlier layouts sit in the stream.
  const values: ClassRec['values'] = meta.members.map((m, i) => {
    const bt = meta.binaryTypes![i];
    if (bt === BT.Primitive) {
      const pt = meta.typeInfos![i] as PT;
      const v =
        m === 'SlotIndex' ? data.slotIndex : m === 'ItemIndex' ? data.itemIndex : m === 'ItemAmount' ? data.amount : m === 'ItemUses' ? data.uses : 0;
      return { kind: 'prim', pt, v };
    }
    if (m === 'ExclusiveString') return { kind: 'str', id: g.nextId(), value: '' } as Rec;
    return { kind: 'null' } as Rec;
  });
  return { kind: 'class', rt: RT.ClassWithMembersAndTypes, id: g.nextId(), metaId: null, meta, values };
}

function newSlotArray(g: Graph): BinArrRec {
  return {
    kind: 'binarr',
    id: g.nextId(),
    arrayType: 0,
    lengths: [0],
    lowerBounds: null,
    bt: BT.Class,
    info: [SLOT_CLASS, assemblyLibraryId(g)],
    items: [],
  };
}

/**
 * Put an item in a slot. Updates the existing slot record, or inserts a new
 * one in SlotIndex order when the slot is empty.
 */
export function setSlot(g: Graph, owner: ClassRec, fieldName: string, data: SlotData) {
  const d: SlotData = {
    slotIndex: clamp(data.slotIndex, 0),
    itemIndex: clamp(data.itemIndex, 1),
    amount: clamp(data.amount, 1),
    uses: clamp(data.uses, 0),
  };
  let arr = slotArray(g, owner, fieldName);
  if (!arr) {
    arr = newSlotArray(g);
    owner.values[owner.meta.members.indexOf(fieldName)] = arr;
  }
  const existing = slotRecords(g, arr).find((o) => num(o, 'SlotIndex') === d.slotIndex);
  if (existing) {
    setNum(existing, 'ItemIndex', d.itemIndex);
    setNum(existing, 'ItemAmount', d.amount);
    setNum(existing, 'ItemUses', d.uses);
    return;
  }
  let at = arr.items.length;
  for (let i = 0; i < arr.items.length; i++) {
    const o = g.maybeObj(arr.items[i] as Rec);
    if (o && num(o, 'SlotIndex') > d.slotIndex) {
      at = i;
      break;
    }
  }
  arr.items.splice(at, 0, newSlot(g, d));
  g.reindex();
}

export function clearSlot(g: Graph, owner: ClassRec, fieldName: string, slotIndex: number) {
  const arr = slotArray(g, owner, fieldName);
  if (!arr) return;
  const i = arr.items.findIndex((it) => {
    const o = it.kind === 'prim' ? null : g.maybeObj(it);
    return o && o.meta.name === SLOT_CLASS && num(o, 'SlotIndex') === slotIndex;
  });
  if (i >= 0) removeArrayElement(g, arr, i);
}
