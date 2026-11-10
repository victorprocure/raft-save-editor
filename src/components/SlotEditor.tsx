import { MAX_SLOT_VALUE, item, itemLabel } from '../raft/items';
import type { SlotData } from '../raft/slots';
import { ItemIcon } from './ItemIcon';
import { ItemPicker } from './ItemPicker';

/** Item, amount and durability to put into slots. Kept by the caller across selections. */
export interface Draft {
  query: string;
  itemIndex: number | null;
  amount: number;
  uses: number;
}

export const EMPTY_DRAFT: Draft = { query: '', itemIndex: null, amount: 1, uses: 1 };

interface Props {
  /** Selected slot indexes, sorted. */
  selection: number[];
  /** Occupied slots among the selection. */
  slots: SlotData[];
  /** False when only existing slots may be edited (unknown container size). */
  canAdd: boolean;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onApply: (slotIndexes: number[]) => void;
  onClear: (slotIndexes: number[]) => void;
  onMax: (slotIndexes: number[]) => void;
}

export function SlotEditor({ selection, slots, canAdd, draft, onDraft, onApply, onClear, onMax }: Props) {
  const { itemIndex, amount, uses } = draft;
  const def = itemIndex !== null ? item(itemIndex) : undefined;
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });

  const pickItem = (id: number) => {
    const d = item(id);
    // A different item starts with a full stack and full durability.
    if (d && id !== itemIndex) set({ itemIndex: id, amount: d.stack, uses: d.maxUses });
    else set({ itemIndex: id });
  };

  const targets = canAdd ? selection : slots.map((s) => s.slotIndex);
  const valid =
    itemIndex !== null && amount >= 1 && amount <= MAX_SLOT_VALUE && uses >= 0 && uses <= MAX_SLOT_VALUE && targets.length > 0;
  const single = selection.length === 1 ? slots[0] : undefined;
  const canMax = slots.some((s) => {
    const d = item(s.itemIndex);
    return d !== undefined && s.amount < d.stack;
  });

  const title =
    selection.length === 0 ? 'No slot selected' : selection.length === 1 ? `Slot ${selection[0] + 1}` : `${selection.length} slots selected`;
  const applyLabel =
    selection.length > 1
      ? `Put in ${targets.length} slot${targets.length === 1 ? '' : 's'}`
      : !single
        ? 'Add to slot'
        : single.itemIndex === itemIndex
          ? 'Update slot'
          : 'Replace item';

  return (
    <section className="slot-editor" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {selection.length > 0 && (
          <span className="muted">{selection.length === 1 ? (single ? 'Occupied' : 'Empty') : `${slots.length} occupied`}</span>
        )}
      </header>

      {single && (
        <div className="current">
          <span className="current-item">
            <ItemIcon id={single.itemIndex} size={32} />
            {itemLabel(single.itemIndex)} <strong>×{single.amount}</strong>
            {(item(single.itemIndex)?.maxUses ?? 0) > 1 && <span className="muted"> · durability {single.uses}</span>}
          </span>
          <button onClick={() => onDraft({ ...draft, itemIndex: single.itemIndex, amount: single.amount, uses: single.uses })}>
            Edit
          </button>
        </div>
      )}
      {slots.length > 0 && (
        <div className="actions">
          <button onClick={() => onMax(slots.map((s) => s.slotIndex))} disabled={!canMax}>
            Max stack{slots.length > 1 ? 's' : ''}
          </button>
          <button className="danger" onClick={() => onClear(slots.map((s) => s.slotIndex))}>
            Clear{slots.length > 1 ? ` ${slots.length} slots` : ' slot'}
          </button>
        </div>
      )}

      <hr />
      <ItemPicker value={itemIndex} onChange={pickItem} query={draft.query} onQuery={(query) => set({ query })} />
      <div className="fields">
        <label>
          Amount
          <input
            type="number"
            min={1}
            max={MAX_SLOT_VALUE}
            value={amount}
            onChange={(e) => set({ amount: Math.trunc(Number(e.target.value)) })}
          />
          {def && <small className={amount > def.stack ? 'warn' : 'muted'}>Stack limit {def.stack}</small>}
        </label>
        <label>
          Durability
          <input
            type="number"
            min={0}
            max={MAX_SLOT_VALUE}
            value={uses}
            onChange={(e) => set({ uses: Math.trunc(Number(e.target.value)) })}
          />
          {def && <small className={uses > def.maxUses ? 'warn' : 'muted'}>Max {def.maxUses}</small>}
        </label>
      </div>
      <div className="actions">
        <button className="primary" disabled={!valid} onClick={() => onApply(targets)}>
          {applyLabel}
        </button>
        {def && (
          <button onClick={() => set({ amount: def.stack })} disabled={amount === def.stack}>
            Full stack
          </button>
        )}
      </div>
      {!canAdd && selection.length > slots.length && (
        <p className="muted small">This container's size is unknown, so empty slots can't be filled.</p>
      )}
    </section>
  );
}
