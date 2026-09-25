/**
 * Library browser: sources toolbar, search, sortable track table, and
 * load-to-deck by button, double-click or drag.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { formatTime } from '../audio/deck-controller';
import { supportsFolderPicker } from '../library/fs';
import type { Library, LibraryEntry, LibraryState } from '../library/library';
import { ENTRY_DRAG_TYPE } from './deck-view';
import { h, setText } from './dom';

type SortKey = 'title' | 'artist' | 'bpm' | 'duration';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Rows rendered at most; the rest are reachable by searching. */
const MAX_ROWS = 500;

export interface LibraryViewHandlers {
  load: (entry: LibraryEntry, deck: 'A' | 'B') => void;
  /** Double-click: pick a deck automatically. */
  loadAuto: (entry: LibraryEntry) => void;
}

export class LibraryView {
  readonly el: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly status: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly reopen: HTMLButtonElement;
  private readonly headers = new Map<SortKey, HTMLTableCellElement>();
  private sort: { key: SortKey; ascending: boolean } = { key: 'title', ascending: true };
  private renderQueued = false;
  /**
   * One row element per entry id, kept for the entry's lifetime; changed
   * entries (tags arriving, BPM analysed) update the cells in place.
   * Replacing a row swaps the element under the pointer between mousedown
   * and mouseup, and that click never fires.
   */
  private readonly rowCache = new Map<string, { entry: LibraryEntry; tr: HTMLTableRowElement; cells: HTMLTableCellElement[] }>();

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
    this.search = h('input', { class: 'library-search', attrs: { type: 'search', placeholder: 'Search title or artist', 'aria-label': 'Search library' } });
    this.search.addEventListener('input', () => this.queueRender());
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
          header('duration', 'Time', 'col-num'),
          header(null, 'Load', 'col-load'),
        ]),
      ]),
      this.body,
    ]);

    this.el = h('section', { class: 'library', attrs: { 'aria-label': 'Library' } }, [
      h('div', { class: 'library-toolbar' }, [folder, this.reopen, files, this.search, this.status]),
      h('div', { class: 'library-table-wrap' }, [table]),
    ]);

    library.store.subscribe(() => this.queueRender());
    this.queueRender();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render(this.library.store.get());
    });
  }

  private visibleEntries(state: LibraryState): LibraryEntry[] {
    const query = this.search.value.trim().toLowerCase();
    const matches = query
      ? state.entries.filter((e) => e.title.toLowerCase().includes(query) || e.artist.toLowerCase().includes(query))
      : state.entries.slice();
    const { key, ascending } = this.sort;
    const direction = ascending ? 1 : -1;
    matches.sort((a, b) => {
      const x = a[key];
      const y = b[key];
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
    const entries = this.visibleEntries(state);
    const shown = entries.slice(0, MAX_ROWS);
    const rows = shown.map((entry) => {
      let cached = this.rowCache.get(entry.id);
      if (!cached) {
        cached = this.row(entry);
        this.rowCache.set(entry.id, cached);
      } else if (cached.entry !== entry) {
        cached.entry = entry;
        fillCells(cached.cells, entry);
      }
      return cached.tr;
    });
    const live = new Set(state.entries.map((e) => e.id));
    for (const id of this.rowCache.keys()) if (!live.has(id)) this.rowCache.delete(id);

    if (entries.length === 0) {
      const message = state.entries.length === 0 ? 'No tracks yet: open a folder, add files or drop a file on a deck' : 'No tracks match the search';
      this.body.replaceChildren(h('tr', { class: 'empty-row' }, [h('td', { text: message, attrs: { colspan: '5' } })]));
    } else {
      const current = this.body.children;
      const unchanged = current.length === rows.length && rows.every((tr, i) => current[i] === tr);
      if (!unchanged) this.body.replaceChildren(...rows);
    }

    let status = state.status;
    if (entries.length > MAX_ROWS) status += ` (showing ${MAX_ROWS} of ${entries.length}; search to narrow)`;
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
  private row(entry: LibraryEntry): { entry: LibraryEntry; tr: HTMLTableRowElement; cells: HTMLTableCellElement[] } {
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
    const cells = [h('td', { class: 'col-title' }), h('td', { class: 'col-artist' }), h('td', { class: 'col-num' }), h('td', { class: 'col-num' })];
    fillCells(cells, entry);
    const tr = h('tr', { attrs: { draggable: 'true' } }, [...cells, h('td', { class: 'col-load' }, [loadButton('A'), loadButton('B')])]);
    tr.addEventListener('dblclick', () => this.handlers.loadAuto(current()));
    tr.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(ENTRY_DRAG_TYPE, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    });
    return { entry, tr, cells };
  }
}

function fillCells(cells: HTMLTableCellElement[], entry: LibraryEntry): void {
  const [title, artist, bpm, duration] = cells;
  setText(title, entry.title);
  title.title = entry.title;
  setText(artist, entry.artist);
  setText(bpm, entry.bpm === null ? '' : entry.bpm.toFixed(1));
  setText(duration, entry.duration === null ? '' : formatTime(entry.duration).replace(/\.\d$/, ''));
}
