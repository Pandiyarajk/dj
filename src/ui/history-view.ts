/**
 * Played-history dialog: the tracklist, with CSV export and clear.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { historyToCsv, type PlayHistory } from '../library/history';
import { h, setText } from './dom';

export class HistoryDialog {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;

  constructor(private readonly history: PlayHistory) {
    this.button = h('button', { class: 'btn btn-small', text: 'History', title: 'Tracks played (audible for 30 s or more)', attrs: { type: 'button' } });
    this.button.addEventListener('click', () => this.open());
    this.list = h('ol', { class: 'history-list' });
    this.note = h('p', { class: 'history-note', attrs: { role: 'status' } });
    const exportButton = h('button', { class: 'btn btn-small', text: 'Export CSV', attrs: { type: 'button' } });
    exportButton.addEventListener('click', () => this.export());
    const clearButton = h('button', { class: 'btn btn-small', text: 'Clear', attrs: { type: 'button' } });
    clearButton.addEventListener('click', () => {
      const count = this.history.store.get().items.length;
      this.history.clear();
      setText(this.note, count ? `Cleared ${count} track${count === 1 ? '' : 's'}` : 'History was already empty');
    });
    const close = h('button', { class: 'btn btn-small', text: 'Close', attrs: { type: 'button' } });
    close.addEventListener('click', () => this.el.close());
    this.el = h('dialog', { class: 'help history', attrs: { 'aria-label': 'Played history' } }, [
      h('div', { class: 'help-head' }, [h('h2', { text: 'Played history' }), h('div', { class: 'history-actions' }, [exportButton, clearButton, close])]),
      this.note,
      this.list,
    ]);
    this.el.addEventListener('click', (event) => {
      if (event.target === this.el) this.el.close();
    });
    history.store.subscribe(() => this.render());
    this.render();
  }

  open(): void {
    setText(this.note, '');
    this.render();
    this.el.showModal();
  }

  private render(): void {
    const items = this.history.store.get().items;
    setText(this.button, items.length ? `History (${items.length})` : 'History');
    if (items.length === 0) {
      this.list.replaceChildren(h('li', { class: 'history-empty', text: 'Nothing played yet. A track is logged once it has been audible for 30 seconds.' }));
      return;
    }
    this.list.replaceChildren(
      ...items.map((item) =>
        h('li', {}, [
          h('span', { class: 'history-time', text: new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
          h('span', { class: `history-deck history-deck-${item.deck.toLowerCase()}`, text: item.deck }),
          h('span', { class: 'history-title', text: item.artist ? `${item.artist} - ${item.title}` : item.title }),
          h('span', { class: 'history-meta', text: [item.bpm?.toFixed(1), item.key].filter(Boolean).join('  ') }),
        ]),
      ),
    );
  }

  private export(): void {
    const items = this.history.store.get().items;
    if (items.length === 0) {
      setText(this.note, 'History is empty: nothing exported');
      return;
    }
    const blob = new Blob([historyToCsv(items)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { attrs: { href: url, download: `dj-history-${new Date().toISOString().slice(0, 10)}.csv` } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setText(this.note, `Exported ${items.length} track${items.length === 1 ? '' : 's'}`);
  }
}
