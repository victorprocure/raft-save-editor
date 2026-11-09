import { describe, expect, it } from 'vitest';
import { parse, serialize } from '../codec';
import { Graph, removeArrayElement, validate } from '../graph';
import { BT, PT, RT, type BinArrRec, type ClassMeta, type ClassRec, type Doc } from '../types';

// Root object holds an array of three slots. Slot 10 defines the class layout
// and the shared string; slots 11 and 12 point back to both.
function fixture(): Doc {
  const meta: ClassMeta = {
    rt: RT.ClassWithMembersAndTypes,
    name: 'RGD_Slot',
    members: ['ItemIndex', 'ExclusiveString'],
    binaryTypes: [BT.Primitive, BT.String],
    typeInfos: [PT.Int16, null],
    libraryId: 2,
  };
  const slot = (id: number, item: number, full: boolean): ClassRec => ({
    kind: 'class',
    rt: full ? RT.ClassWithMembersAndTypes : RT.ClassWithId,
    id,
    metaId: full ? null : 10,
    meta,
    values: [{ kind: 'prim', pt: PT.Int16, v: item }, full ? { kind: 'str', id: 99, value: '' } : { kind: 'ref', id: 99 }],
  });
  const arr: BinArrRec = {
    kind: 'binarr', id: 5, arrayType: 0, lengths: [3], lowerBounds: null, bt: BT.Class, info: ['RGD_Slot', 2],
    items: [slot(10, 21, true), slot(11, 22, false), slot(12, 23, false)],
  };
  const root: ClassRec = {
    kind: 'class', rt: RT.ClassWithMembersAndTypes, id: 1, metaId: null,
    meta: { rt: RT.ClassWithMembersAndTypes, name: 'Root', members: ['Slots'], binaryTypes: [BT.Class], typeInfos: [['RGD_Slot[]', 2]], libraryId: 2 },
    values: [{ kind: 'ref', id: 5 }],
    libs: [{ kind: 'lib', id: 2, name: 'Assembly-CSharp' }],
  };
  return { header: { rootId: 1, headerId: -1, major: 1, minor: 0 }, records: [root, arr] };
}

describe('removeArrayElement', () => {
  it('moves the class layout and shared string to the next user', () => {
    const doc = fixture();
    const g = new Graph(doc);
    const arr = g.byId.get(5) as BinArrRec;
    removeArrayElement(g, arr, 0);
    const [a, b] = arr.items as ClassRec[];
    expect(a.id).toBe(11);
    expect(a.rt).toBe(RT.ClassWithMembersAndTypes);
    expect(a.values[1]).toEqual({ kind: 'str', id: 99, value: '' });
    expect(b.rt).toBe(RT.ClassWithId);
    expect(b.metaId).toBe(11);
    expect(b.values[1]).toEqual({ kind: 'ref', id: 99 });
    const bytes = serialize(doc);
    validate(parse(bytes));
    expect(serialize(parse(bytes))).toEqual(bytes);
  });

  it('removes a slot that defines nothing shared', () => {
    const doc = fixture();
    const g = new Graph(doc);
    const arr = g.byId.get(5) as BinArrRec;
    removeArrayElement(g, arr, 1);
    expect((arr.items as ClassRec[]).map((s) => s.id)).toEqual([10, 12]);
    validate(parse(serialize(doc)));
  });

  it('removes every slot', () => {
    const doc = fixture();
    const g = new Graph(doc);
    const arr = g.byId.get(5) as BinArrRec;
    while (arr.items.length) removeArrayElement(g, arr, 0);
    const out = parse(serialize(doc));
    expect((out.records[1] as BinArrRec).lengths).toEqual([0]);
  });
});
