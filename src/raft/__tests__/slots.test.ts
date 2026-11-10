import { describe, expect, it } from 'vitest';
import { parse, serialize } from '../../nrbf/codec';
import { Graph, field, validate } from '../../nrbf/graph';
import { BT, PT, RT, type ClassRec, type Doc } from '../../nrbf/types';
import { readSlots, setSlot, slotArray } from '../slots';

// A chest the game saved empty: Slots is null and typed as Object.
function emptyChest(): Doc {
  const chest: ClassRec = {
    kind: 'class',
    rt: RT.ClassWithMembersAndTypes,
    id: 1,
    metaId: null,
    meta: {
      rt: RT.ClassWithMembersAndTypes,
      name: 'RGD_Storage',
      members: ['Slots', 'ObjectIndex'],
      binaryTypes: [BT.Object, BT.Primitive],
      typeInfos: [null, PT.UInt32],
      libraryId: 2,
    },
    values: [{ kind: 'null' }, { kind: 'prim', pt: PT.UInt32, v: 7 }],
    libs: [{ kind: 'lib', id: 2, name: 'Assembly-CSharp' }],
  };
  return { header: { rootId: 1, headerId: -1, major: 1, minor: 0 }, records: [chest] };
}

describe('setSlot on an empty chest', () => {
  it('writes the new slot array at top level and references it', () => {
    const doc = emptyChest();
    const g = new Graph(doc);
    const chest = doc.records[0] as ClassRec;
    setSlot(g, chest, 'Slots', { slotIndex: 2, itemIndex: 21, amount: 20, uses: 1 });
    validate(doc);

    // BinaryFormatter gives an ISerializable constructor null for an inline array.
    expect(field(chest, 'Slots').kind).toBe('ref');
    expect(doc.records.some((r) => r.kind === 'binarr')).toBe(true);

    const back = new Graph(parse(serialize(doc)));
    const slots = readSlots(back, slotArray(back, back.root(), 'Slots'));
    expect(slots).toEqual([{ slotIndex: 2, itemIndex: 21, amount: 20, uses: 1 }]);
  });

  it('moves an inline array left by an earlier version to top level', () => {
    const doc = emptyChest();
    const g = new Graph(doc);
    const chest = doc.records[0] as ClassRec;
    setSlot(g, chest, 'Slots', { slotIndex: 0, itemIndex: 21, amount: 1, uses: 1 });
    // Recreate the old layout: array inline in the chest.
    const arr = doc.records.pop()!;
    chest.values[0] = arr;
    g.reindex();
    setSlot(g, chest, 'Slots', { slotIndex: 1, itemIndex: 22, amount: 1, uses: 1 });
    validate(doc);
    expect(field(chest, 'Slots').kind).toBe('ref');
    expect(readSlots(g, slotArray(g, chest, 'Slots')).map((s) => s.slotIndex)).toEqual([0, 1]);
  });
});
