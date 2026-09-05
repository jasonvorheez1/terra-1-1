// What you are carrying.
//
// One flat array of slots. The first nine are the hotbar - the only difference
// between those and the rest is that they are the ones drawn along the bottom
// of the screen and the ones a number key can select.

import { stackSize, isTool, maxDurability } from './items.js';

export const HOTBAR = 9;
export const PACK = 27;
export const SLOTS = HOTBAR + PACK;

export class Inventory {
  constructor() {
    // { id, count, wear } - wear only on tools, counting up to the item's
    // durability. Tools never stack, so a worn one is always its own slot.
    this.slots = new Array(SLOTS).fill(null);
    this.selected = 0;
  }

  get held() { return this.slots[this.selected]; }
  get heldId() { const s = this.slots[this.selected]; return s ? s.id : null; }

  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /**
   * Put items in, filling part-used stacks before empty slots.
   * Returns how many would not fit.
   */
  add(id, count = 1) {
    if (!id || count <= 0) return 0;
    let left = count;
    const max = stackSize(id);
    if (!isTool(id)) {
      for (const s of this.slots) {
        if (!s || s.id !== id || s.count >= max) continue;
        const room = max - s.count;
        const put = Math.min(room, left);
        s.count += put;
        left -= put;
        if (left === 0) return 0;
      }
    }
    for (let i = 0; i < SLOTS && left > 0; i++) {
      if (this.slots[i]) continue;
      const put = isTool(id) ? 1 : Math.min(max, left);
      this.slots[i] = { id, count: put, wear: 0 };
      left -= put;
    }
    return left;
  }

  /** Take items out. Returns false and changes nothing if there are not enough. */
  remove(id, count = 1) {
    if (this.count(id) < count) return false;
    let left = count;
    for (let i = 0; i < SLOTS && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }

  /** Consume one of what is held; used when a block is placed. */
  consumeHeld(n = 1) {
    const s = this.slots[this.selected];
    if (!s) return false;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
    return true;
  }

  /**
   * Wear the held tool by one use, and break it when it is spent.
   * Returns true if it broke.
   */
  wearHeld(amount = 1) {
    const s = this.slots[this.selected];
    if (!s) return false;
    const max = maxDurability(s.id);
    if (!max) return false;
    s.wear = (s.wear || 0) + amount;
    if (s.wear >= max) { this.slots[this.selected] = null; return true; }
    return false;
  }

  /** Move or merge one slot onto another, as a click-drag in the grid would. */
  move(from, to) {
    if (from === to) return;
    const a = this.slots[from], b = this.slots[to];
    if (!a) return;
    if (b && b.id === a.id && !isTool(a.id)) {
      const max = stackSize(a.id);
      const put = Math.min(max - b.count, a.count);
      b.count += put;
      a.count -= put;
      if (a.count <= 0) this.slots[from] = null;
      return;
    }
    this.slots[from] = b;
    this.slots[to] = a;
  }

  /** Everything held, as { id: count }, for testing a recipe against. */
  tally() {
    const out = Object.create(null);
    for (const s of this.slots) {
      if (!s) continue;
      out[s.id] = (out[s.id] || 0) + s.count;
    }
    return out;
  }

  get isEmpty() { return this.slots.every((s) => !s); }
}
