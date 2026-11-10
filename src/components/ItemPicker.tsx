import { useMemo } from 'react';
import { ITEMS, item, type ItemDef } from '../raft/items';
import { ItemIcon } from './ItemIcon';

interface Props {
  value: number | null;
  onChange: (id: number) => void;
  /** Search text. Owned by the caller so it survives slot and container changes. */
  query: string;
  onQuery: (q: string) => void;
}

const MAX_RESULTS = 60;

export function ItemPicker({ value, onChange, query, onQuery }: Props) {
  const current = value !== null ? item(value) : undefined;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (i: ItemDef) =>
      !q || i.display.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || String(i.id) === q;
    return ITEMS.filter(match).slice(0, MAX_RESULTS);
  }, [query]);

  return (
    <div className="picker">
      <input
        type="search"
        placeholder={current ? `${current.display} (search to change)` : 'Search items by name or ID'}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        aria-label="Search items"
      />
      <ul className="picker-results" role="listbox">
        {results.map((i) => (
          <li
            key={i.id}
            role="option"
            aria-selected={i.id === value}
            className={i.id === value ? 'selected' : undefined}
            onClick={() => onChange(i.id)}
          >
            <span className="picker-name">
              <ItemIcon id={i.id} size={24} />
              {i.display}
            </span>
            <span className="muted">
              {i.name} · #{i.id}
            </span>
          </li>
        ))}
        {results.length === 0 && <li className="muted">No items match</li>}
      </ul>
    </div>
  );
}
