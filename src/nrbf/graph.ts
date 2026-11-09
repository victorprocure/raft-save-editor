import { RT, type ClassRec, type Doc, type Prim, type Rec, type Value } from './types';

type Container = { values: Value[] } | { items: (Rec | Prim)[] } | { records: Rec[] };

interface Slot {
  owner: Container;
  index: number;
}

function slotArray(c: Container): (Value | Prim)[] {
  return 'values' in c ? c.values : 'items' in c ? c.items : c.records;
}

/** Visit every record in stream order with the container slot that holds it. */
export function walk(doc: Doc, fn: (rec: Rec, slot: Slot) => void) {
  const visit = (owner: Container) => {
    const arr = slotArray(owner);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v.kind === 'prim') continue;
      fn(v, { owner, index: i });
      if (v.kind === 'class' || v.kind === 'arrsingle' || v.kind === 'binarr') visit(v as Container);
    }
  };
  visit(doc);
}

export function definesId(rec: Rec): number | null {
  switch (rec.kind) {
    case 'class':
    case 'str':
    case 'arrprim':
    case 'arrsingle':
    case 'binarr':
      return rec.id;
    default:
      return null;
  }
}

/** Fast lookup of defined objects. Rebuild after structural edits. */
export class Graph {
  byId = new Map<number, Rec>();
  maxId = 0;
  constructor(public doc: Doc) {
    this.reindex();
  }
  reindex() {
    this.byId.clear();
    this.maxId = 0;
    walk(this.doc, (rec) => {
      const id = definesId(rec);
      if (id !== null) {
        this.byId.set(id, rec);
        if (id > this.maxId) this.maxId = id;
      }
    });
  }
  nextId(): number {
    return ++this.maxId;
  }
  root(): ClassRec {
    return this.obj({ kind: 'ref', id: this.doc.header.rootId });
  }
  /** Follow references. */
  resolve(v: Value | Prim | undefined | null): Rec | Prim | null {
    while (v && v.kind === 'ref') v = this.byId.get(v.id);
    if (!v || v.kind === 'null') return null;
    return v;
  }
  obj(v: Value | undefined | null): ClassRec {
    const r = this.resolve(v);
    if (!r || r.kind !== 'class') throw new Error('Expected an object');
    return r;
  }
  maybeObj(v: Value | undefined | null): ClassRec | null {
    const r = this.resolve(v);
    return r && r.kind === 'class' ? r : null;
  }
}

export function hasField(o: ClassRec, name: string): boolean {
  return o.meta.members.includes(name);
}

export function field(o: ClassRec, name: string): Value {
  const i = o.meta.members.indexOf(name);
  if (i < 0) throw new Error(`${o.meta.name} has no field ${name}`);
  return o.values[i];
}

export function prim(o: ClassRec, name: string): Prim {
  const v = field(o, name);
  if (v.kind !== 'prim') throw new Error(`${o.meta.name}.${name} is not a primitive`);
  return v;
}

export function num(o: ClassRec, name: string): number {
  const v = prim(o, name).v;
  if (typeof v !== 'number') throw new Error(`${o.meta.name}.${name} is not a number`);
  return v;
}

export function setNum(o: ClassRec, name: string, value: number) {
  const p = prim(o, name);
  if (typeof p.v !== 'number') throw new Error(`${o.meta.name}.${name} is not a number`);
  p.v = value;
  delete p.raw;
}

export function str(g: Graph, o: ClassRec, name: string): string | null {
  const r = g.resolve(field(o, name));
  if (!r) return null;
  if (r.kind === 'str') return r.value;
  if (r.kind === 'prim' && typeof r.v === 'string') return r.v;
  throw new Error(`${o.meta.name}.${name} is not a string`);
}

/**
 * Remove one element from an array record, keeping the stream valid.
 *
 * BinaryFormatter writes each object and class layout once, at first use.
 * Later uses point back to it. If the removed element holds such a first
 * definition, the definition is moved to its next user.
 */
export function removeArrayElement(g: Graph, arr: Rec, index: number) {
  if (arr.kind !== 'arrsingle' && arr.kind !== 'binarr') throw new Error('Not an object array');
  const removed = arr.items[index];
  if (!removed || removed.kind === 'prim') throw new Error('Array element is not a record');

  const definedObjects = new Map<number, Rec>();
  const definedMetas = new Set<number>();
  const inside = new Set<Rec>();
  const collect = (r: Rec) => {
    inside.add(r);
    const id = definesId(r);
    if (id !== null) definedObjects.set(id, r);
    if (r.kind === 'class' && r.rt !== RT.ClassWithId) definedMetas.add(r.id);
    const kids = r.kind === 'class' ? r.values : r.kind === 'arrsingle' || r.kind === 'binarr' ? r.items : [];
    for (const k of kids) if (k.kind !== 'prim') collect(k);
  };
  collect(removed);

  // Library records travel with the first record that follows the removed one.
  const libs: Rec['libs'] = [];
  for (const r of inside) if (r.libs) libs.push(...r.libs);
  if (libs.length) {
    let found = false;
    let next: Rec | null = null;
    walk(g.doc, (rec) => {
      if (next) return;
      if (rec === removed) found = true;
      else if (found && !inside.has(rec)) next = rec;
    });
    if (!next) throw new Error('Cannot relocate library record');
    const n = next as Rec;
    n.libs = [...libs, ...(n.libs ?? [])];
  }

  arr.items.splice(index, 1);

  // Class layouts: the first later ClassWithId user becomes the full definition.
  if (definedMetas.size) {
    const promoted = new Map<number, ClassRec>();
    walk(g.doc, (rec) => {
      if (rec.kind !== 'class' || rec.rt !== RT.ClassWithId || !definedMetas.has(rec.metaId!)) return;
      const old = rec.metaId!;
      const p = promoted.get(old);
      if (!p) {
        rec.rt = rec.meta.rt;
        rec.metaId = null;
        promoted.set(old, rec);
      } else {
        rec.metaId = p.id;
      }
    });
  }

  // Objects: the first remaining reference receives the definition.
  if (definedObjects.size) {
    const moved = new Set<number>();
    walk(g.doc, (rec, slot) => {
      if (rec.kind !== 'ref' || moved.has(rec.id)) return;
      const def = definedObjects.get(rec.id);
      if (!def) return;
      const arr = slotArray(slot.owner);
      if (def.libs || rec.libs) def.libs = [...(rec.libs ?? []), ...(def.libs ?? [])];
      arr[slot.index] = def;
      moved.add(rec.id);
    });
  }

  g.reindex();
  validate(g.doc);
}

/** Check that every reference resolves and every class layout is defined before use. */
export function validate(doc: Doc) {
  const objects = new Set<number>();
  const metas = new Set<number>();
  const refs: number[] = [];
  walk(doc, (rec) => {
    const id = definesId(rec);
    if (id !== null) {
      if (objects.has(id)) throw new Error(`Object id ${id} is defined twice`);
      objects.add(id);
    }
    if (rec.kind === 'class') {
      if (rec.rt === RT.ClassWithId && !metas.has(rec.metaId!))
        throw new Error(`Object ${rec.id} uses class layout ${rec.metaId} before it is defined`);
      metas.add(rec.id);
    }
    if (rec.kind === 'ref') refs.push(rec.id);
  });
  for (const id of refs) if (!objects.has(id)) throw new Error(`Reference to missing object ${id}`);
  if (!objects.has(doc.header.rootId)) throw new Error('Root object missing');
}
