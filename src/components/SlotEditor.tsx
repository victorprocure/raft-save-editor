import { useEffect, useState } from 'react';
import { MAX_SLOT_VALUE, item } from '../raft/items';
import type { SlotData } from '../raft/slots';
import { ItemPicker } from './ItemPicker';

interface Props {
  slotIndex: number;
  slot: SlotData | undefined;
  /** False when only existing slots may be edited (unknown container size). */
  canAdd: boolean;
  onApply: (data: SlotData) => void;
  onClear: () => void;
}

export function SlotEditor({ slotIndex, slot, canAdd, onApply, onClear }: Props) {
  const [itemIndex, setItemIndex] = useState<number | null>(slot?.itemIndex ?? null);
  const [amount, setAmount] = useState(slot?.amount ?? 1);
  const [uses, setUses] = useState(slot?.uses ?? 1);

  useEffect(() => {
    setItemIndex(slot?.itemIndex ?? null);
    setAmount(slot?.amount ?? 1);
    setUses(slot?.uses ?? 1);
  }, [slotIndex, slot]);

  const def = itemIndex !== null ? item(itemIndex) : undefined;
  const pickItem = (id: number) => {
    setItemIndex(id);
    const d = item(id);
    if (!d) return;
    // New item: start with a full stack and full durability.
    if (id !== slot?.itemIndex) {
      setAmount(d.stack);
      setUses(d.maxUses);
    }
  };

  const valid = itemIndex !== null && amount >= 1 && amount <= MAX_SLOT_VALUE && uses >= 0 && uses <= MAX_SLOT_VALUE;
  const disabled = !slot && !canAdd;

  return (
    <section className="slot-editor" aria-label={`Slot ${slotIndex + 1}`}>
      <header>
        <h3>Slot {slotIndex + 1}</h3>
        <span className="muted">{slot ? 'Occupied' : 'Empty'}</span>
      </header>
      {disabled ? (
        <p className="muted">This container's size is unknown, so empty slots can't be filled.</p>
      ) : (
        <>
          <ItemPicker value={itemIndex} onChange={pickItem} />
          <div className="fields">
            <label>
              Amount
              <input
                type="number"
                min={1}
                max={MAX_SLOT_VALUE}
                value={amount}
                onChange={(e) => setAmount(Math.trunc(Number(e.target.value)))}
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
                onChange={(e) => setUses(Math.trunc(Number(e.target.value)))}
              />
              {def && <small className={uses > def.maxUses ? 'warn' : 'muted'}>Max {def.maxUses}</small>}
            </label>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!valid}
              onClick={() => onApply({ slotIndex, itemIndex: itemIndex!, amount, uses })}
            >
              {slot ? 'Update slot' : 'Add to slot'}
            </button>
            {def && (
              <button onClick={() => setAmount(def.stack)} disabled={amount === def.stack}>
                Full stack
              </button>
            )}
            {slot && (
              <button className="danger" onClick={onClear}>
                Clear slot
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
