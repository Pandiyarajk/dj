/**
 * Tiny observable store: immutable snapshots, shallow patches, change listeners.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export type Listener<T> = (state: T, previous: T) => void;

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  /** Current snapshot. Treat it as read-only; change it with set(). */
  get(): T {
    return this.state;
  }

  /** Shallow-merge `patch` and notify listeners. */
  set(patch: Partial<T>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    for (const listener of this.listeners) listener(this.state, previous);
  }

  /** Call `listener` on every change; returns an unsubscribe function. */
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
