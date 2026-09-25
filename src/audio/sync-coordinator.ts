/**
 * Beat sync between the two decks.
 *
 * Pressing SYNC makes that deck the follower: its tempo is matched to the other
 * deck (the leader) and its playhead is moved into phase. While synced, the
 * follower tracks the leader's tempo, and moving the follower's own tempo
 * fader moves the shared tempo (the leader follows it) instead of silently
 * dropping sync. Pressing SYNC again releases it.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (shared tempo from the follower's fader, range
 *   widening while following, realign after unquantized jumps)
 */
import type { DeckController } from './deck-controller';
import { phaseAlignedPosition, TEMPO_RANGES, tempoForSync } from './sync';

export class SyncCoordinator {
  private readonly multipliers = new Map<DeckController, number>();
  /** Inputs of the most recent phase alignment, for diagnostics. */
  lastAlign: { deck: string; at: number; leader: number; follower: number; aligned: number } | null = null;

  constructor(private readonly decks: [DeckController, DeckController]) {
    for (const deck of decks) {
      deck.syncHooks = {
        manualTempo: (tempo) => this.manualTempo(deck, tempo),
        realign: () => this.align(deck),
      };
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
    const leaderPos = leader.renderPosition(at);
    const followerPos = follower.renderPosition(at);
    const aligned = phaseAlignedPosition(leaderGrid, leaderPos, followerGrid, followerPos, this.multipliers.get(follower) ?? 1);
    this.lastAlign = { deck: follower.id, at, leader: leaderPos, follower: followerPos, aligned };
    // Within half a beat, so keep an active loop: its span is whole beats and
    // the audio thread folds the target back in phase.
    follower.seek(aligned, at, true);
  }

  /** Tempo the follower needs for the leader's current tempo, or null if either has no grid. */
  private targetTempo(follower: DeckController): number | null {
    const leaderBpm = this.other(follower).effectiveBpm;
    const followerGrid = follower.grid;
    if (leaderBpm === null || !followerGrid) return null;
    return (leaderBpm * (this.multipliers.get(follower) ?? 1)) / followerGrid.bpm - 1;
  }

  /** Re-apply tempo to any deck following `leader`, widening its range when needed. */
  private follow(leader: DeckController): void {
    const follower = this.other(leader);
    if (!follower.state.synced) return;
    const tempo = this.targetTempo(follower);
    if (tempo === null) return;
    const range = TEMPO_RANGES.find((r) => Math.abs(tempo) <= r + 1e-9);
    if (range === undefined) {
      follower.setSynced(false);
      follower.notice(`Sync off: deck ${leader.id}'s tempo is beyond this deck's range`, 'warn');
      return;
    }
    if (range > follower.state.tempoRange) follower.setTempoRange(range);
    follower.applyTempo(tempo);
  }

  /**
   * A synced deck's own fader moved: move the shared tempo. The other deck is
   * set so its heard BPM matches, and this deck then follows it exactly.
   */
  private manualTempo(follower: DeckController, tempo: number): boolean {
    const leader = this.other(follower);
    const followerGrid = follower.grid;
    const leaderGrid = leader.grid;
    if (!followerGrid || !leaderGrid) return false;
    const multiplier = this.multipliers.get(follower) ?? 1;
    const sharedBpm = (followerGrid.bpm * (1 + tempo)) / multiplier;
    if (!leader.applyTempo(sharedBpm / leaderGrid.bpm - 1)) {
      follower.notice(`Deck ${leader.id}'s tempo range is at its limit`, 'warn');
    }
    // follow() runs from the leader's store update and sets this deck exactly.
    return true;
  }
}
