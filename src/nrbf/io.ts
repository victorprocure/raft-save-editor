import { PT, type Prim, type PrimValue } from './types';

const utf8d = new TextDecoder('utf-8', { fatal: true });
const utf8e = new TextEncoder();

const FIXED: Partial<Record<PT, number>> = {
  [PT.Boolean]: 1,
  [PT.Byte]: 1,
  [PT.SByte]: 1,
  [PT.Int16]: 2,
  [PT.UInt16]: 2,
  [PT.Int32]: 4,
  [PT.UInt32]: 4,
  [PT.Single]: 4,
  [PT.Int64]: 8,
  [PT.UInt64]: 8,
  [PT.Double]: 8,
  [PT.TimeSpan]: 8,
  [PT.DateTime]: 8,
};

export class Reader {
  pos = 0;
  private dv: DataView;
  constructor(public buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error(`Unexpected end of data at ${this.pos}`);
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  string(): string {
    let len = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return utf8d.decode(this.bytes(len));
  }
  prim(pt: PT): Prim {
    const start = this.pos;
    let v: PrimValue;
    const dv = this.dv;
    const fixed = FIXED[pt];
    if (fixed !== undefined) this.need(fixed);
    switch (pt) {
      case PT.Boolean: v = this.buf[this.pos] !== 0; break;
      case PT.Byte: v = this.buf[this.pos]; break;
      case PT.SByte: v = dv.getInt8(this.pos); break;
      case PT.Int16: v = dv.getInt16(this.pos, true); break;
      case PT.UInt16: v = dv.getUint16(this.pos, true); break;
      case PT.Int32: v = dv.getInt32(this.pos, true); break;
      case PT.UInt32: v = dv.getUint32(this.pos, true); break;
      case PT.Single: v = dv.getFloat32(this.pos, true); break;
      case PT.Double: v = dv.getFloat64(this.pos, true); break;
      case PT.Int64: case PT.TimeSpan: v = dv.getBigInt64(this.pos, true); break;
      case PT.UInt64: case PT.DateTime: v = dv.getBigUint64(this.pos, true); break;
      case PT.Char: {
        const c = this.buf[this.pos];
        const n = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
        return { kind: 'prim', pt, v: utf8d.decode(this.bytes(n)) };
      }
      case PT.Decimal: case PT.String:
        return { kind: 'prim', pt, v: this.string() };
      default:
        throw new Error(`Unsupported primitive type ${pt} at ${start}`);
    }
    this.pos += fixed!;
    const p: Prim = { kind: 'prim', pt, v };
    // Keep raw bytes for NaN so the exact bit pattern survives a round trip.
    if (typeof v === 'number' && Number.isNaN(v)) p.raw = this.buf.slice(start, this.pos);
    return p;
  }
}

export class Writer {
  private buf = new Uint8Array(1 << 16);
  private dv = new DataView(this.buf.buffer);
  pos = 0;
  private grow(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.pos++] = v;
  }
  i32(v: number) {
    this.grow(4);
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  string(s: string) {
    const b = utf8e.encode(s);
    let n = b.length;
    do {
      let c = n & 0x7f;
      n >>>= 7;
      if (n) c |= 0x80;
      this.u8(c);
    } while (n);
    this.bytes(b);
  }
  prim(p: Prim) {
    if (p.raw) return this.bytes(p.raw);
    const { pt, v } = p;
    const fixed = FIXED[pt];
    if (fixed !== undefined) this.grow(fixed);
    const dv = this.dv;
    switch (pt) {
      case PT.Boolean: this.buf[this.pos] = v ? 1 : 0; break;
      case PT.Byte: this.buf[this.pos] = v as number; break;
      case PT.SByte: dv.setInt8(this.pos, v as number); break;
      case PT.Int16: dv.setInt16(this.pos, v as number, true); break;
      case PT.UInt16: dv.setUint16(this.pos, v as number, true); break;
      case PT.Int32: dv.setInt32(this.pos, v as number, true); break;
      case PT.UInt32: dv.setUint32(this.pos, v as number, true); break;
      case PT.Single: dv.setFloat32(this.pos, v as number, true); break;
      case PT.Double: dv.setFloat64(this.pos, v as number, true); break;
      case PT.Int64: case PT.TimeSpan: dv.setBigInt64(this.pos, v as bigint, true); break;
      case PT.UInt64: case PT.DateTime: dv.setBigUint64(this.pos, v as bigint, true); break;
      case PT.Char: return this.bytes(utf8e.encode(v as string));
      case PT.Decimal: case PT.String: return this.string(v as string);
      default: throw new Error(`Unsupported primitive type ${pt}`);
    }
    this.pos += fixed!;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Decode a raw primitive array payload. */
export function decodePrimArray(pt: PT, length: number, bytes: Uint8Array): Prim[] {
  const r = new Reader(bytes);
  const out: Prim[] = [];
  for (let i = 0; i < length; i++) out.push(r.prim(pt));
  return out;
}

export function encodePrimArray(values: Prim[]): Uint8Array {
  const w = new Writer();
  for (const v of values) w.prim(v);
  return w.result();
}
