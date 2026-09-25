/**
 * Beat sync between the two decks.
 *
 * Pressing SYNC makes that deck the follower: its tempo is matched to the other
 * deck (the leader) and its playhead is moved into phase. While synced, the
 * follower tracks the leader's tempo fader. Pressing SYNC again, or moving the
 * follower's own tempo fader, releases it.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { DeckController } from './deck-controller';
import { phaseAlignedPosition, tempoForSync } from './sync';

export class SyncCoordinator {
  private readonly multipliers = new Map<DeckController, number>();
  /** Inputs of the most recent phase alignment, for diagnostics. */
  lastAlign: { deck: string; at: number; leader: number; follower: number; aligned: number } | null = null;

  constructor(private readonly decks: [DeckController, DeckController]) {
    for (const deck of decks) {
      deck.store.subscribe((state, previous) => {
        // The leader's tempo or grid changed: carry followers along.
        if (state.tempo !== previous.tempo || state.bpm !== previous.bpm) this.follow(deck);
        // A new track on the follower invalidates its lock.
        if (state.track !== previous.track && previous.synced) deck.setSynced(false);
        // Sync-on-play: a follower started later must land on the leader's beat now.
        if (state.playing && !previous.playing && state.synced) this.align(deck);
      });
    }
  }

  private other(deck: DeckController): DeckController {
    return deck === this.decks[0] ? this.decks[1] : this.decks[0];
  }

  toggle(follower: DeckController): void {
    if (follower.state.synced) {
      follower.setSynced(false);
      follower.notice('Sync off');
      return;
    }
    this.engage(follower);
  }

  private engage(follower: DeckController): void {
    const leader = this.other(follower);
    const followerGrid = follower.grid;
    const leaderGrid = leader.grid;
    const leaderBpm = leader.effectiveBpm;
    if (!follower.loaded) return follower.notice('Load a track first', 'warn');
    if (!followerGrid) return follower.notice('Sync needs a BPM on this deck', 'warn');
    if (!leader.loaded || !leaderGrid || leaderBpm === null) {
      return follower.notice(`Sync needs a BPM on deck ${leader.id}`, 'warn');
    }

    // Only one follower at a time: the leader stops following us.
    if (leader.state.synced) leader.setSynced(false);

    const { tempo, multiplier, range } = tempoForSync(leaderBpm, followerGrid.bpm);
    if (range !== null && range > follower.state.tempoRange) follower.setTempoRange(range);
    follower.applyTempo(tempo);
    this.multipliers.set(follower, multiplier);

    this.align(follower);
    follower.setSynced(true);

    const feel: Record<number, string> = { 2: ' (double time)', 0.5: ' (half time)' };
    follower.notice(`Synced to deck ${leader.id} at ${(leaderBpm * multiplier).toFixed(2)} BPM${feel[multiplier] ?? ''}`);
  }

  /** Move `follower` into phase with the other deck. */
  private align(follower: DeckController): void {
    const leader = this.other(follower);
    const leaderGrid = leader.grid;
    const followerGrid = follower.grid;
    if (!leaderGrid || !followerGrid) return;
    // Both positions at one instant; the seek carries that instant so the
    // processor compensates for however late the jump lands.
    const at = follower.now();
    const aligned = phaseAlignedPosition(leaderGrid, leader.renderPosition(at), followerGrid, follower.renderPosition(at), this.multipliers.get(follower) ?? 1);
    this.lastAlign = { deck: follower.id, at, leader: leader.renderPosition(at), follower: follower.renderPosition(at), aligned };
    follower.seek(aligned, at);
  }

  /** Re-apply tempo to any deck following `leader`. */
  private follow(leader: DeckController): void {
    const follower = this.other(leader);
    const followerGrid = follower.grid;
    const leaderBpm = leader.effectiveBpm;
    if (!follower.state.synced || !followerGrid || leaderBpm === null) return;
    const multiplier = this.multipliers.get(follower) ?? 1;
    follower.applyTempo((leaderBpm * multiplier) / followerGrid.bpm - 1);
  }
}
