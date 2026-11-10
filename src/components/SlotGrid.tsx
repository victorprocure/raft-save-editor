import { item, itemLabel } from '../raft/items';
import { ItemIcon } from './ItemIcon';
import type { Container } from '../raft/save';

export interface ClickMods {
  /** Shift: select a range from the last clicked slot. */
  range: boolean;
  /** Ctrl or Cmd: add or remove one slot. */
  toggle: boolean;
}

interface Props {
  container: Container;
  selected: number[];
  onSelect: (slotIndex: number, mods: ClickMods) => void;
}

export function SlotGrid({ container, selected, onSelect }: Props) {
  const bySlot = new Map(container.slots.map((s) => [s.slotIndex, s]));
  const maxUsed = container.slots.reduce((m, s) => Math.max(m, s.slotIndex + 1), 0);
  const count = container.capacity ?? maxUsed;

  return (
    <div className="grid" role="grid">
      {Array.from({ length: count }, (_, i) => {
        const s = bySlot.get(i);
        const def = s ? item(s.itemIndex) : undefined;
        const over = s && def && s.amount > def.stack;
        return (
          <button
            key={i}
            className={`cell${s ? ' filled' : ''}${selected.includes(i) ? ' selected' : ''}`}
            onMouseDown={(e) => e.shiftKey && e.preventDefault()} // Stop Shift-click selecting page text.
            onClick={(e) => onSelect(i, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
            title={s ? `${itemLabel(s.itemIndex)} ×${s.amount}` : `Empty slot ${i + 1}`}
          >
            <span className="cell-index">{i + 1}</span>
            {s && (
              <>
                <ItemIcon id={s.itemIndex} size={40} />
                <span className="cell-name">{itemLabel(s.itemIndex)}</span>
                <span className={`cell-amount${over ? ' warn' : ''}`}>×{s.amount}</span>
                {def && def.maxUses > 1 && (
                  <span className="cell-bar" aria-hidden>
                    <span style={{ width: `${Math.min(100, (s.uses / def.maxUses) * 100)}%` }} />
                  </span>
                )}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
