/**
 * Crates: named, ordered lists of library tracks for preparing a set.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';
import { getSetting, setSetting } from './db';

export interface Crate {
  name: string;
  /** Library row ids, in set order. */
  ids: string[];
}

const CRATES_KEY = 'crates';

/** Outcome of an edit, for the always-visible status line. */
export type CrateResult = { ok: true; message: string } | { ok: false; message: string };

export class Crates {
  readonly store = new Store<{ crates: Crate[] }>({ crates: [] });

  async load(): Promise<void> {
    const crates = await getSetting<Crate[]>(CRATES_KEY).catch(() => null);
    if (crates) this.store.set({ crates });
  }

  private save(crates: Crate[]): void {
    this.store.set({ crates });
    void setSetting(CRATES_KEY, crates).catch(() => undefined);
  }

  get(name: string): Crate | undefined {
    return this.store.get().crates.find((c) => c.name === name);
  }

  create(rawName: string): CrateResult {
    const name = rawName.trim();
    if (!name) return { ok: false, message: 'Give the crate a name' };
    if (this.get(name)) return { ok: false, message: `A crate called "${name}" already exists` };
    this.save([...this.store.get().crates, { name, ids: [] }]);
    return { ok: true, message: `Created crate "${name}"` };
  }

  add(name: string, id: string, title: string): CrateResult {
    const crate = this.get(name);
    if (!crate) return { ok: false, message: 'Choose a crate first' };
    if (crate.ids.includes(id)) return { ok: false, message: `"${title}" is already in ${name}` };
    this.save(this.store.get().crates.map((c) => (c.name === name ? { ...c, ids: [...c.ids, id] } : c)));
    return { ok: true, message: `Added "${title}" to ${name} (${crate.ids.length + 1})` };
  }

  remove(name: string, id: string, title: string): CrateResult {
    const crate = this.get(name);
    if (!crate || !crate.ids.includes(id)) return { ok: false, message: `"${title}" is not in ${name}` };
    this.save(this.store.get().crates.map((c) => (c.name === name ? { ...c, ids: c.ids.filter((x) => x !== id) } : c)));
    return { ok: true, message: `Removed "${title}" from ${name}` };
  }

  delete(name: string): CrateResult {
    if (!this.get(name)) return { ok: false, message: `No crate called "${name}"` };
    this.save(this.store.get().crates.filter((c) => c.name !== name));
    return { ok: true, message: `Deleted crate "${name}"` };
  }
}
