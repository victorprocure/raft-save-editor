import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Save files from the parent directory. Tests skip when they are absent. */
export const SAVE_ROOT = resolve(__dirname, '../../../..');

export function saveFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.rgd')) out.push(p);
    }
  };
  walk(join(SAVE_ROOT, 'Player'));
  walk(join(SAVE_ROOT, 'World'));
  return out.sort();
}
