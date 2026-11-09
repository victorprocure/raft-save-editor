import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, serialize } from '../codec';
import { saveFiles } from './fixtures';

const files = saveFiles();

describe.skipIf(files.length === 0)('round trip', () => {
  it.each(files)('%s serializes to identical bytes', (file) => {
    const src = new Uint8Array(readFileSync(file));
    const out = serialize(parse(src));
    expect(out.length).toBe(src.length);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(src))).toBe(0);
  });
});
