/**
 * Library browser: sources toolbar, search, sortable track table, and
 * load-to-deck by button, double-click, drag or keyboard.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (keyboard selection, Match filter with tempo deltas
 *   and key compatibility, played markers, BPM / key / album search)
 */
import { formatTime } from '../audio/deck-controller';
import { compatibleKeys } from '../analysis/key';
import { supportsFolderPicker } from '../library/fs';
import type { Library, LibraryEntry, LibraryState } from '../library/library';
import { bpmDelta, matchesQuery } from '../library/match';
import { ENTRY_DRAG_TYPE } from './deck-view';
import { h, setClass, setText } from './dom';

type SortKey = 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'delta';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Rows rendered at most; the rest are reachable by searching. */
const MAX_ROWS = 500;
/** The Match filter keeps tracks within this tempo change of the deck on air, percent. */
const MATCH_RANGE = 6;

/** The deck the next track has to fit: its heard BPM and key. */
export interface MatchReference {
  deck: 'A' | 'B';
  bpm: number | null;
  key: string | null;
}

export interface LibraryViewHandlers {
  load: (entry: LibraryEntry, deck: 'A' | 'B') => void;
  /** Double-click or Enter: pick a deck automatically. */
  loadAuto: (entry: LibraryEntry) => void;
  /** Extra toolbar controls (such as background analysis). */
  tools?: HTMLElement[];
  /** The deck on air, for the Match filter and key highlighting. */
  reference?: () => MatchReference | null;
  /** Library row ids already played this session and before. */
  playedIds?: () => Set<string>;
  /** Hear a row in the headphones only. */
  prelisten?: (entry: LibraryEntry) => void;
}

interface Row {
  entry: LibraryEntry;
  tr: HTMLTableRowElement;
  cells: HTMLTableCellElement[];
}

export class LibraryView {
  readonly el: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly status: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly reopen: HTMLButtonElement;
  private readonly matchButton: HTMLButtonElement;
  private readonly headers = new Map<SortKey, HTMLTableCellElement>();
  private sort: { key: SortKey; ascending: boolean } = { key: 'title', ascending: true };
  private renderQueued = false;
  private matching = false;
  /** Selected row, by entry id (survives re-sorting). */
  private selectedId: string | null = null;
  /** Entries in their current on-screen order. */
  private visible: LibraryEntry[] = [];
  /**
   * One row element per entry id, kept for the entry's lifetime; changed
   * entries (tags arriving, BPM analysed) update the cells in place.
   * Replacing a row swaps the element under the pointer between mousedown
   * and mouseup, and that click never fires.
   */
  private readonly rowCache = new Map<string, Row>();

  constructor(
    private readonly library: Library,
    private readonly handlers: LibraryViewHandlers,
  ) {
    const tool = (label: string, title: string, run: () => Promise<void> | void): HTMLButtonElement =>
      h('button', {
        class: 'btn btn-small',
        text: label,
        title,
        attrs: { type: 'button' },
        on: {
          click: () => {
            void run();
          },
        },
      });

    const folder = tool('Open folder', 'Choose a music folder (scanned recursively)', () => library.openFolder());
    if (!supportsFolderPicker()) {
      folder.disabled = true;
      folder.title = 'This browser cannot open folders; use Add files';
    }
    this.reopen = tool('Reopen last folder', 'Rescan the folder from last time', () => library.reopenFolder());
    const files = tool('Add files', 'Add individual audio files', () => library.addFiles());
    this.matchButton = tool('Match', `Show only tracks within ${MATCH_RANGE}% of the deck on air (half and double time count), with the tempo change each needs`, () => this.toggleMatch());
    this.matchButton.classList.add('btn-match');
    this.search = h('input', {
      class: 'library-search',
      attrs: { type: 'search', placeholder: 'Search title, artist, album, BPM (124) or key (8A)   /', 'aria-label': 'Search library' },
    });
    this.search.addEventListener('input', () => this.queueRender());
    // Up/Down move the selection and Enter loads it, even from the search box.
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.loadSelected(null);
      } else if (event.key === 'Escape') {
        this.search.blur();
      }
    });
    this.status = h('span', { class: 'library-status', attrs: { role: 'status', 'aria-live': 'polite' } });

    const header = (key: SortKey | null, label: string, cls: string): HTMLTableCellElement => {
      const th = h('th', { class: cls, text: label });
      if (key) {
        th.classList.add('sortable');
        th.tabIndex = 0;
        const activate = (): void => {
          this.sort = { key, ascending: this.sort.key === key ? !this.sort.ascending : true };
          this.queueRender();
        };
        th.addEventListener('click', activate);
        th.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        });
        this.headers.set(key, th);
      }
      return th;
    };

    this.body = h('tbody');
    const table = h('table', { class: 'library-table' }, [
      h('thead', {}, [
        h('tr', {}, [
          header('title', 'Title', 'col-title'),
          header('artist', 'Artist', 'col-artist'),
          header('bpm', 'BPM', 'col-num'),
          header('delta', '+/-', 'col-delta'),
          header('key', 'Key', 'col-key'),
          header('duration', 'Time', 'col-num'),
          header(null, 'Load', 'col-load'),
        ]),
      ]),
      this.body,
    ]);

    this.el = h('section', { class: 'library', attrs: { 'aria-label': 'Library' } }, [
      h('div', { class: 'library-toolbar' }, [folder, this.reopen, files, ...(handlers.tools ?? []), this.matchButton, this.search, this.status]),
      h('div', { class: 'library-table-wrap' }, [table]),
    ]);

    library.store.subscribe(() => this.queueRender());
    this.queueRender();
  }

  /** Re-render soon (the deck on air or the history changed). */
  refresh(): void {
    this.queueRender();
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  toggleMatch(): void {
    this.matching = !this.matching;
    setClass(this.matchButton, 'on', this.matching);
    this.queueRender();
  }

  /** Move the selection by `step` rows (wrapping), scrolling it into view. */
  moveSelection(step: number): void {
    if (this.visible.length === 0) return;
    const index = this.visible.findIndex((e) => e.id === this.selectedId);
    const next = index < 0 ? (step > 0 ? 0 : this.visible.length - 1) : (index + step + this.visible.length) % this.visible.length;
    this.select(this.visible[next].id);
  }

  /** Load the selected row onto `deck`, or onto a free deck when null. */
  loadSelected(deck: 'A' | 'B' | null): void {
    const entry = this.visible.find((e) => e.id === this.selectedId);
    if (!entry) {
      setText(this.status, 'Select a track first (Up / Down)');
      return;
    }
    if (deck) this.handlers.load(entry, deck);
    else this.handlers.loadAuto(entry);
  }

  private select(id: string): void {
    const previous = this.selectedId ? this.rowCache.get(this.selectedId) : undefined;
    if (previous) setClass(previous.tr, 'selected', false);
    this.selectedId = id;
    const row = this.rowCache.get(id);
    if (row) {
      setClass(row.tr, 'selected', true);
      row.tr.setAttribute('aria-selected', 'true');
      row.tr.scrollIntoView({ block: 'nearest' });
    }
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render(this.library.store.get());
    });
  }

  private visibleEntries(state: LibraryState, reference: MatchReference | null): LibraryEntry[] {
    const query = this.search.value;
    let matches = state.entries.filter((e) => matchesQuery(e, query));
    const refBpm = reference?.bpm ?? null;
    if (this.matching && refBpm !== null) {
      matches = matches.filter((e) => {
        const delta = bpmDelta(e.bpm, refBpm);
        return delta !== null && Math.abs(delta) <= MATCH_RANGE;
      });
    }
    const { key, ascending } = this.sort;
    const direction = ascending ? 1 : -1;
    const value = (e: LibraryEntry): string | number | null => {
      if (key === 'delta') {
        const delta = refBpm === null ? null : bpmDelta(e.bpm, refBpm);
        return delta === null ? null : Math.abs(delta);
      }
      return e[key];
    };
    matches.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      // Unknown values sort last in either direction.
      if (x === null || x === '') return y === null || y === '' ? 0 : 1;
      if (y === null || y === '') return -1;
      // Natural order: "Track 2" before "Track 10".
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return order * direction;
    });
    return matches;
  }

  private render(state: LibraryState): void {
    const reference = this.handlers.reference?.() ?? null;
    const played = this.handlers.playedIds?.() ?? new Set<string>();
    const compatible = reference?.key ? new Set(compatibleKeys(reference.key)) : null;
    const entries = this.visibleEntries(state, reference);
    this.visible = entries.slice(0, MAX_ROWS);
    const rows = this.visible.map((entry) => {
      let cached = this.rowCache.get(entry.id);
      if (!cached) {
        cached = this.row(entry);
        this.rowCache.set(entry.id, cached);
      }
      cached.entry = entry;
      fillCells(cached.cells, entry, reference?.bpm ?? null);
      setClass(cached.tr, 'played', played.has(entry.id));
      setClass(cached.tr, 'key-match', compatible !== null && entry.key !== null && compatible.has(entry.key));
      setClass(cached.tr, 'selected', entry.id === this.selectedId);
      return cached.tr;
    });
    const live = new Set(state.entries.map((e) => e.id));
    for (const id of this.rowCache.keys()) if (!live.has(id)) this.rowCache.delete(id);

    if (entries.length === 0) {
      let message = 'No tracks match the search';
      if (state.entries.length === 0) message = 'No tracks yet: open a folder, add files or drop a file on a deck';
      else if (this.matching && reference?.bpm) message = `No tracks within ${MATCH_RANGE}% of ${reference.bpm.toFixed(1)} BPM`;
      this.body.replaceChildren(h('tr', { class: 'empty-row' }, [h('td', { text: message, attrs: { colspan: '7' } })]));
    } else {
      const current = this.body.children;
      const unchanged = current.length === rows.length && rows.every((tr, i) => current[i] === tr);
      if (!unchanged) this.body.replaceChildren(...rows);
    }

    let status = state.status;
    if (this.matching) {
      status = reference?.bpm
        ? `Match: ${entries.length} within ${MATCH_RANGE}% of deck ${reference.deck} (${reference.bpm.toFixed(1)} BPM${reference.key ? `, ${reference.key}` : ''})`
        : 'Match: load and analyse a track on a deck first';
    } else if (entries.length > MAX_ROWS) status += ` (showing ${MAX_ROWS} of ${entries.length}; search to narrow)`;
    else if (this.search.value.trim()) status += ` (${entries.length} match${entries.length === 1 ? '' : 'es'})`;
    setText(this.status, status);
    this.status.classList.toggle('is-busy', state.busy);
    this.reopen.disabled = !state.canReopen || !supportsFolderPicker();

    for (const [key, th] of this.headers) {
      th.classList.toggle('sorted', this.sort.key === key);
      const direction = this.sort.ascending ? 'ascending' : 'descending';
      th.setAttribute('aria-sort', this.sort.key === key ? direction : 'none');
    }
  }

  /** Build a row. Handlers look the entry up by id, so they always see the latest version. */
  private row(entry: LibraryEntry): Row {
    const id = entry.id;
    const current = (): LibraryEntry => this.rowCache.get(id)?.entry ?? entry;
    const loadButton = (deck: 'A' | 'B'): HTMLButtonElement =>
      h('button', {
        class: `btn btn-load btn-load-${deck.toLowerCase()}`,
        text: deck,
        title: `Load onto deck ${deck}`,
        attrs: { type: 'button', 'aria-label': `Load ${entry.title} onto deck ${deck}` },
        on: { click: () => this.handlers.load(current(), deck) },
      });
    const cells = [
      h('td', { class: 'col-title' }),
      h('td', { class: 'col-artist' }),
      h('td', { class: 'col-num' }),
      h('td', { class: 'col-delta' }),
      h('td', { class: 'col-key' }),
      h('td', { class: 'col-num' }),
    ];
    const listen = h('button', {
      class: 'btn btn-load btn-listen',
      title: 'Prelisten in the headphones (not on the master)',
      attrs: { type: 'button', 'aria-label': `Prelisten ${entry.title}` },
      on: {
        click: (event) => {
          event.stopPropagation();
          this.handlers.prelisten?.(current());
        },
      },
    });
    const loads = this.handlers.prelisten ? [listen, loadButton('A'), loadButton('B')] : [loadButton('A'), loadButton('B')];
    const tr = h('tr', { attrs: { draggable: 'true' } }, [...cells, h('td', { class: 'col-load' }, loads)]);
    tr.addEventListener('click', () => this.select(id));
    tr.addEventListener('dblclick', () => this.handlers.loadAuto(current()));
    tr.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(ENTRY_DRAG_TYPE, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    });
    return { entry, tr, cells };
  }
}

function fillCells(cells: HTMLTableCellElement[], entry: LibraryEntry, referenceBpm: number | null): void {
  const [title, artist, bpm, delta, key, duration] = cells;
  setText(title, entry.title);
  title.title = entry.title;
  setText(artist, entry.artist);
  setText(bpm, entry.bpm === null ? '' : entry.bpm.toFixed(1));
  const change = referenceBpm === null ? null : bpmDelta(entry.bpm, referenceBpm);
  setText(delta, change === null ? '' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`);
  setClass(delta, 'near', change !== null && Math.abs(change) <= 3);
  setText(key, entry.key ?? '');
  setText(duration, entry.duration === null ? '' : formatTime(entry.duration).replace(/\.\d$/, ''));
}
