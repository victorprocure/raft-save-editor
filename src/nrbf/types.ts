// MS-NRBF (.NET BinaryFormatter) record model.
// The model keeps the exact record layout of the source stream so an
// unmodified document serializes back to identical bytes.

export enum RT {
  Header = 0,
  ClassWithId = 1,
  SystemClassWithMembers = 2,
  ClassWithMembers = 3,
  SystemClassWithMembersAndTypes = 4,
  ClassWithMembersAndTypes = 5,
  BinaryObjectString = 6,
  BinaryArray = 7,
  MemberPrimitiveTyped = 8,
  MemberReference = 9,
  ObjectNull = 10,
  MessageEnd = 11,
  BinaryLibrary = 12,
  ObjectNullMultiple256 = 13,
  ObjectNullMultiple = 14,
  ArraySinglePrimitive = 15,
  ArraySingleObject = 16,
  ArraySingleString = 17,
}

export enum BT {
  Primitive = 0,
  String = 1,
  Object = 2,
  SystemClass = 3,
  Class = 4,
  ObjectArray = 5,
  StringArray = 6,
  PrimitiveArray = 7,
}

export enum PT {
  Boolean = 1,
  Byte = 2,
  Char = 3,
  Decimal = 5,
  Double = 6,
  Int16 = 7,
  Int32 = 8,
  Int64 = 9,
  SByte = 10,
  Single = 11,
  TimeSpan = 12,
  DateTime = 13,
  UInt16 = 14,
  UInt32 = 15,
  UInt64 = 16,
  Null = 17,
  String = 18,
}

/** Extra type info per member: PT for primitives, class name for system classes, [name, libId] for classes. */
export type TypeInfo = number | string | [string, number] | null;

export type PrimValue = boolean | number | bigint | string;

export interface Library {
  kind: 'lib';
  id: number;
  name: string;
}

/** Class layout. Defined by record types 2-5 and reused by ClassWithId (1). */
export interface ClassMeta {
  rt: RT.SystemClassWithMembers | RT.ClassWithMembers | RT.SystemClassWithMembersAndTypes | RT.ClassWithMembersAndTypes;
  name: string;
  members: string[];
  binaryTypes: BT[] | null; // null for record types 2 and 3
  typeInfos: TypeInfo[] | null;
  libraryId: number | null; // set for record types 3 and 5
}

/** Inline primitive member value. `raw` preserves NaN payloads bit for bit. */
export interface Prim {
  kind: 'prim';
  pt: PT;
  v: PrimValue;
  raw?: Uint8Array;
}

export interface ClassRec {
  kind: 'class';
  rt: RT.ClassWithId | ClassMeta['rt'];
  id: number;
  /** Object id of the record that defined the metadata. Only for rt 1. */
  metaId: number | null;
  meta: ClassMeta;
  values: Value[];
  libs?: Library[];
}

export interface StrRec { kind: 'str'; id: number; value: string; libs?: Library[] }
export interface RefRec { kind: 'ref'; id: number; libs?: Library[] }
export interface NullRec { kind: 'null'; libs?: Library[] }
export interface NullMultiRec { kind: 'nullm'; rt: RT.ObjectNullMultiple256 | RT.ObjectNullMultiple; count: number; libs?: Library[] }
export interface PrimTypedRec { kind: 'primtyped'; prim: Prim; libs?: Library[] }
/** Primitive array. Payload is kept raw. Decode with `decodePrimArray`. */
export interface ArrPrimRec { kind: 'arrprim'; id: number; pt: PT; length: number; bytes: Uint8Array; libs?: Library[] }
export interface ArrSingleRec { kind: 'arrsingle'; rt: RT.ArraySingleObject | RT.ArraySingleString; id: number; items: Rec[]; libs?: Library[] }
export interface BinArrRec {
  kind: 'binarr';
  id: number;
  arrayType: number;
  lengths: number[];
  lowerBounds: number[] | null;
  bt: BT;
  info: TypeInfo;
  /** Records for reference element types, Prim for primitive element types. */
  items: (Rec | Prim)[];
  libs?: Library[];
}

export type Rec =
  | ClassRec
  | StrRec
  | RefRec
  | NullRec
  | NullMultiRec
  | PrimTypedRec
  | ArrPrimRec
  | ArrSingleRec
  | BinArrRec;

export type Value = Prim | Rec;

export interface Header {
  rootId: number;
  headerId: number;
  major: number;
  minor: number;
}

export interface Doc {
  header: Header;
  /** Top-level records in stream order. */
  records: Rec[];
  /** Libraries that appear right before MessageEnd. */
  trailingLibs?: Library[];
}

export function isRec(v: Value | undefined | null): v is Rec {
  return !!v && v.kind !== 'prim';
}

/** Number of logical elements a record occupies inside an array. */
export function elementSpan(r: Rec | Prim): number {
  return r.kind === 'nullm' ? r.count : 1;
}
