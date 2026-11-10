import { createContext, useContext, useState } from 'react';
import { iconUrl } from '../api';
import { item } from '../raft/items';

/** Icon generation, or null when no Raft install is available. */
export const IconContext = createContext<number | null>(null);

export function ItemIcon({ id, size }: { id: number; size: number }) {
  const generation = useContext(IconContext);
  const [failed, setFailed] = useState<string | null>(null);
  const s = item(id)?.sprite;
  if (generation === null || !s) return null;
  const src = iconUrl(generation, s.file, s.id, s.name);
  if (failed === src) return null;
  return (
    <img
      className="item-icon"
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}
