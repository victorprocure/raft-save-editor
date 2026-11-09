import { item, itemLabel } from '../raft/items';
import type { Container } from '../raft/save';

interface Props {
  container: Container;
  selected: number | null;
  onSelect: (slotIndex: number) => void;
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
            className={`cell${s ? ' filled' : ''}${selected === i ? ' selected' : ''}`}
            onClick={() => onSelect(i)}
            title={s ? `${itemLabel(s.itemIndex)} ×${s.amount}` : `Empty slot ${i + 1}`}
          >
            <span className="cell-index">{i + 1}</span>
            {s && (
              <>
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
