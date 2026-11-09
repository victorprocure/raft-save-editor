import { Reader, Writer } from './io';
import {
  BT,
  PT,
  RT,
  type ArrPrimRec,
  type BinArrRec,
  type ClassMeta,
  type ClassRec,
  type Doc,
  type Library,
  type Prim,
  type Rec,
  type TypeInfo,
  type Value,
} from './types';

function readTypeInfo(r: Reader, bt: BT): TypeInfo {
  switch (bt) {
    case BT.Primitive:
    case BT.PrimitiveArray:
      return r.u8();
    case BT.SystemClass:
      return r.string();
    case BT.Class:
      return [r.string(), r.i32()];
    default:
      return null;
  }
}

function writeTypeInfo(w: Writer, bt: BT, info: TypeInfo) {
  switch (bt) {
    case BT.Primitive:
    case BT.PrimitiveArray:
      w.u8(info as number);
      break;
    case BT.SystemClass:
      w.string(info as string);
      break;
    case BT.Class: {
      const [name, lib] = info as [string, number];
      w.string(name);
      w.i32(lib);
      break;
    }
  }
}

export function parse(buf: Uint8Array): Doc {
  const r = new Reader(buf);
  const metas = new Map<number, ClassMeta>();

  if (r.u8() !== RT.Header) throw new Error('Not a .NET BinaryFormatter stream (missing header)');
  const header = { rootId: r.i32(), headerId: r.i32(), major: r.i32(), minor: r.i32() };

  const readMember = (bt: BT, info: TypeInfo): Value =>
    bt === BT.Primitive ? r.prim(info as PT) : readRecord();

  const readClassValues = (meta: ClassMeta): Value[] => {
    const out: Value[] = [];
    for (let i = 0; i < meta.members.length; i++) {
      const bt = meta.binaryTypes ? meta.binaryTypes[i] : BT.Object;
      out.push(readMember(bt, meta.typeInfos ? meta.typeInfos[i] : null));
    }
    return out;
  };

  // Returns a record, or null on MessageEnd.
  function readRecordOrEnd(): { rec: Rec | null; libs?: Library[] } {
    let libs: Library[] | undefined;
    for (;;) {
      const at = r.pos;
      const t = r.u8();
      switch (t) {
        case RT.BinaryLibrary:
          (libs ??= []).push({ kind: 'lib', id: r.i32(), name: r.string() });
          continue;
        case RT.MessageEnd:
          return { rec: null, libs };
        case RT.ClassWithMembersAndTypes:
        case RT.SystemClassWithMembersAndTypes:
        case RT.ClassWithMembers:
        case RT.SystemClassWithMembers: {
          const id = r.i32();
          const name = r.string();
          const n = r.i32();
          const members: string[] = [];
          for (let i = 0; i < n; i++) members.push(r.string());
          let binaryTypes: BT[] | null = null;
          let typeInfos: TypeInfo[] | null = null;
          if (t === RT.ClassWithMembersAndTypes || t === RT.SystemClassWithMembersAndTypes) {
            binaryTypes = [];
            for (let i = 0; i < n; i++) binaryTypes.push(r.u8());
            typeInfos = binaryTypes.map((bt) => readTypeInfo(r, bt));
          }
          const libraryId = t === RT.ClassWithMembersAndTypes || t === RT.ClassWithMembers ? r.i32() : null;
          const meta: ClassMeta = { rt: t, name, members, binaryTypes, typeInfos, libraryId };
          metas.set(id, meta);
          const rec: ClassRec = { kind: 'class', rt: t, id, metaId: null, meta, values: [] };
          if (libs) rec.libs = libs;
          rec.values = readClassValues(meta);
          return { rec };
        }
        case RT.ClassWithId: {
          const id = r.i32();
          const metaId = r.i32();
          const meta = metas.get(metaId);
          if (!meta) throw new Error(`ClassWithId ${id} references unknown metadata ${metaId} at ${at}`);
          metas.set(id, meta);
          const rec: ClassRec = { kind: 'class', rt: t, id, metaId, meta, values: [] };
          if (libs) rec.libs = libs;
          rec.values = readClassValues(meta);
          return { rec };
        }
        case RT.BinaryObjectString:
          return { rec: withLibs({ kind: 'str', id: r.i32(), value: r.string() }, libs) };
        case RT.MemberReference:
          return { rec: withLibs({ kind: 'ref', id: r.i32() }, libs) };
        case RT.ObjectNull:
          return { rec: withLibs({ kind: 'null' }, libs) };
        case RT.ObjectNullMultiple256:
          return { rec: withLibs({ kind: 'nullm', rt: t, count: r.u8() }, libs) };
        case RT.ObjectNullMultiple:
          return { rec: withLibs({ kind: 'nullm', rt: t, count: r.i32() }, libs) };
        case RT.MemberPrimitiveTyped:
          return { rec: withLibs({ kind: 'primtyped', prim: r.prim(r.u8()) }, libs) };
        case RT.ArraySinglePrimitive: {
          const id = r.i32();
          const length = r.i32();
          const pt = r.u8() as PT;
          const start = r.pos;
          for (let i = 0; i < length; i++) r.prim(pt);
          const rec: ArrPrimRec = { kind: 'arrprim', id, pt, length, bytes: buf.slice(start, r.pos) };
          return { rec: withLibs(rec, libs) };
        }
        case RT.ArraySingleObject:
        case RT.ArraySingleString: {
          const id = r.i32();
          const len = r.i32();
          const items = readElements(len, () => readRecord());
          return { rec: withLibs({ kind: 'arrsingle', rt: t, id, items: items as Rec[] }, libs) };
        }
        case RT.BinaryArray: {
          const id = r.i32();
          const arrayType = r.u8();
          const rank = r.i32();
          const lengths: number[] = [];
          for (let i = 0; i < rank; i++) lengths.push(r.i32());
          let lowerBounds: number[] | null = null;
          if (arrayType === 3 || arrayType === 4 || arrayType === 5) {
            lowerBounds = [];
            for (let i = 0; i < rank; i++) lowerBounds.push(r.i32());
          }
          const bt = r.u8() as BT;
          const info = readTypeInfo(r, bt);
          const total = lengths.reduce((a, b) => a * b, 1);
          const items = readElements(total, () => readMember(bt, info));
          const rec: BinArrRec = { kind: 'binarr', id, arrayType, lengths, lowerBounds, bt, info, items };
          return { rec: withLibs(rec, libs) };
        }
        default:
          throw new Error(`Unknown record type ${t} at offset ${at}`);
      }
    }
  }

  function readElements(total: number, read: () => Value): Value[] {
    const items: Value[] = [];
    let filled = 0;
    while (filled < total) {
      const v = read();
      items.push(v);
      filled += v.kind === 'nullm' ? v.count : 1;
    }
    if (filled !== total) throw new Error('Null run overflows array bounds');
    return items;
  }

  function readRecord(): Rec {
    const { rec } = readRecordOrEnd();
    if (!rec) throw new Error('Unexpected MessageEnd inside a value');
    return rec;
  }

  const records: Rec[] = [];
  let trailingLibs: Library[] | undefined;
  for (;;) {
    const { rec, libs } = readRecordOrEnd();
    if (!rec) {
      trailingLibs = libs;
      break;
    }
    records.push(rec);
  }
  if (r.pos !== buf.length) throw new Error(`Trailing data after MessageEnd: ${buf.length - r.pos} bytes`);
  const doc: Doc = { header, records };
  if (trailingLibs) doc.trailingLibs = trailingLibs;
  return doc;
}

function withLibs<T extends Rec>(rec: T, libs?: Library[]): T {
  if (libs) rec.libs = libs;
  return rec;
}

export function serialize(doc: Doc): Uint8Array {
  const w = new Writer();
  w.u8(RT.Header);
  w.i32(doc.header.rootId);
  w.i32(doc.header.headerId);
  w.i32(doc.header.major);
  w.i32(doc.header.minor);

  const writeLibs = (libs?: Library[]) => {
    if (!libs) return;
    for (const l of libs) {
      w.u8(RT.BinaryLibrary);
      w.i32(l.id);
      w.string(l.name);
    }
  };

  const writeValue = (v: Value | Prim) => (v.kind === 'prim' ? w.prim(v) : writeRecord(v));

  function writeRecord(rec: Rec) {
    writeLibs(rec.libs);
    switch (rec.kind) {
      case 'class': {
        const m = rec.meta;
        if (rec.rt === RT.ClassWithId) {
          w.u8(RT.ClassWithId);
          w.i32(rec.id);
          w.i32(rec.metaId!);
        } else {
          w.u8(rec.rt);
          w.i32(rec.id);
          w.string(m.name);
          w.i32(m.members.length);
          for (const n of m.members) w.string(n);
          if (rec.rt === RT.ClassWithMembersAndTypes || rec.rt === RT.SystemClassWithMembersAndTypes) {
            for (const bt of m.binaryTypes!) w.u8(bt);
            m.binaryTypes!.forEach((bt, i) => writeTypeInfo(w, bt, m.typeInfos![i]));
          }
          if (rec.rt === RT.ClassWithMembersAndTypes || rec.rt === RT.ClassWithMembers) w.i32(m.libraryId!);
        }
        if (rec.values.length !== m.members.length)
          throw new Error(`Object ${rec.id} (${m.name}) has ${rec.values.length} values for ${m.members.length} members`);
        rec.values.forEach((v, i) => {
          const bt = m.binaryTypes ? m.binaryTypes[i] : BT.Object;
          if ((bt === BT.Primitive) !== (v.kind === 'prim'))
            throw new Error(`Object ${rec.id} (${m.name}).${m.members[i]} has the wrong value kind`);
          writeValue(v);
        });
        return;
      }
      case 'str':
        w.u8(RT.BinaryObjectString);
        w.i32(rec.id);
        w.string(rec.value);
        return;
      case 'ref':
        w.u8(RT.MemberReference);
        w.i32(rec.id);
        return;
      case 'null':
        w.u8(RT.ObjectNull);
        return;
      case 'nullm':
        w.u8(rec.rt);
        if (rec.rt === RT.ObjectNullMultiple256) w.u8(rec.count);
        else w.i32(rec.count);
        return;
      case 'primtyped':
        w.u8(RT.MemberPrimitiveTyped);
        w.u8(rec.prim.pt);
        w.prim(rec.prim);
        return;
      case 'arrprim':
        w.u8(RT.ArraySinglePrimitive);
        w.i32(rec.id);
        w.i32(rec.length);
        w.u8(rec.pt);
        w.bytes(rec.bytes);
        return;
      case 'arrsingle':
        w.u8(rec.rt);
        w.i32(rec.id);
        w.i32(rec.items.reduce((a, it) => a + (it.kind === 'nullm' ? it.count : 1), 0));
        rec.items.forEach(writeRecord);
        return;
      case 'binarr': {
        w.u8(RT.BinaryArray);
        w.i32(rec.id);
        w.u8(rec.arrayType);
        w.i32(rec.lengths.length);
        const total = rec.items.reduce((a, it) => a + (it.kind === 'nullm' ? it.count : 1), 0);
        if (rec.lengths.length === 1) rec.lengths[0] = total;
        else if (total !== rec.lengths.reduce((a, b) => a * b, 1))
          throw new Error(`Multi-dimensional array ${rec.id} element count changed`);
        rec.lengths.forEach((l) => w.i32(l));
        rec.lowerBounds?.forEach((l) => w.i32(l));
        w.u8(rec.bt);
        writeTypeInfo(w, rec.bt, rec.info);
        rec.items.forEach(writeValue);
        return;
      }
    }
  }

  doc.records.forEach(writeRecord);
  writeLibs(doc.trailingLibs);
  w.u8(RT.MessageEnd);
  return w.result();
}
