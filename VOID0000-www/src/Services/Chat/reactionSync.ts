import { MAX_UNIQUE_REACTIONS_PER_MESSAGE } from './reactionLimits';

export type ReactionMap = Record<string, { count: number; me: boolean }>;
export interface ReactionSnapshot {
  conversation_id: string;
  message_id: string;
  user_id: string;
  revision: string;
  counts: Record<string, number>;
  mine: string[];
}
interface ServerState { counts: Record<string, number>; mine: Set<string>; revision: bigint; mineRevision: bigint }
interface Pending { desired: boolean; intent: number; inFlight: boolean; uncertain: boolean; attempts: number; timer?: ReturnType<typeof setTimeout> }
const equal = (a: ReactionMap = {}, b: ReactionMap = {}) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([emoji, value]) => value.count === b[emoji]?.count && value.me === b[emoji]?.me);

export function normalizeReactions(raw: unknown, userId?: string): ReactionMap {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([emoji, value]) => {
    const data = Array.isArray(value) ? { count: value.length, me: value.includes(userId) }
      : value && typeof value === 'object' ? { count: Number(value.count), me: value.me === true } : null;
    return data && data.count > 0 ? [[emoji, data]] : [];
  }));
}

// Desired state is separate from confirmed server state. A response or own echo
// can confirm older intent, but cannot overwrite a newer pending local choice.
export class ReactionSync {
  private states = new Map<string, ServerState>();
  private pending = new Map<string, Map<string, Pending>>();
  private view: Record<string, ReactionMap> = {};
  private stopped = false;
  private abort = new AbortController();
  constructor(private conversationId: string, private userId: string,
    private send: (message: string, emoji: string, present: boolean, signal: AbortSignal) => Promise<ReactionSnapshot>,
    private change: (reactions: Record<string, ReactionMap>) => void,
    private failure: (error: unknown) => void = () => {}) {}

  private state(id: string): ServerState {
    let state = this.states.get(id);
    if (!state) { state = { counts: {}, mine: new Set(), revision: -1n, mineRevision: -1n }; this.states.set(id, state); }
    return state;
  }
  seed(messages: Array<{ message_id: string; reactions?: unknown; reaction_revision?: string }>) {
    for (const message of messages) {
      const map = normalizeReactions(message.reactions, this.userId);
      this.apply({ conversation_id: this.conversationId, message_id: message.message_id, user_id: this.userId,
        revision: message.reaction_revision || '0', counts: Object.fromEntries(Object.entries(map).map(([e, v]) => [e, v.count])), mine: Object.keys(map).filter(e => map[e]?.me) });
    }
    this.emit();
  }
  private apply(event: ReactionSnapshot) {
    if (this.stopped || event.conversation_id !== this.conversationId || !event.message_id || !/^\d+$/.test(event.revision) || !event.counts || !Array.isArray(event.mine)) return;
    const state = this.state(event.message_id), revision = BigInt(event.revision);
    if (revision > state.revision) { state.counts = { ...event.counts }; state.revision = revision; }
    if (event.user_id === this.userId && revision > state.mineRevision) { state.mine = new Set(event.mine); state.mineRevision = revision; }
  }
  receive(events: ReactionSnapshot[]) { for (const event of events) this.apply(event); this.emit(); }
  private emit() {
    if (this.stopped) return;
    const next: Record<string, ReactionMap> = {}; let changed = false;
    for (const [message, state] of this.states) {
      const map: ReactionMap = Object.fromEntries(Object.entries(state.counts).filter(([, count]) => count > 0).map(([emoji, count]) => [emoji, { count, me: state.mine.has(emoji) }]));
      for (const [emoji, entry] of this.pending.get(message) ?? []) {
        const originalMe = state.mine.has(emoji), count = (state.counts[emoji] || 0) + Number(entry.desired) - Number(originalMe);
        if (count > 0) map[emoji] = { count, me: entry.desired }; else delete map[emoji];
      }
      next[message] = equal(this.view[message], map) && this.view[message] ? this.view[message] : map;
      changed ||= next[message] !== this.view[message];
    }
    if (changed) { this.view = next; this.change(next); }
  }
  toggle(message: string, emoji: string) {
    if (this.stopped) return;
    const state = this.state(message), current = this.view[message]?.[emoji];
    const desired = !current?.me;
    if (desired && !current?.count && Object.keys(this.view[message] || {}).length >= MAX_UNIQUE_REACTIONS_PER_MESSAGE) return;
    let entries = this.pending.get(message); if (!entries) { entries = new Map(); this.pending.set(message, entries); }
    let entry = entries.get(emoji);
    if (!entry) { entry = { desired: state.mine.has(emoji), intent: 0, inFlight: false, uncertain: false, attempts: 0 }; entries.set(emoji, entry); }
    entry.desired = desired; entry.intent++; entry.attempts = 0;
    this.emit(); this.schedule(message, emoji, entry, 220);
  }
  private schedule(message: string, emoji: string, entry: Pending, delay: number) {
    if (this.stopped || entry.inFlight) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.flush(message, emoji, entry); }, delay);
  }
  private async flush(message: string, emoji: string, entry: Pending) {
    if (this.stopped || entry.inFlight) return;
    if (!entry.uncertain && entry.desired === this.state(message).mine.has(emoji)) { this.pending.get(message)?.delete(emoji); this.emit(); return; }
    entry.inFlight = true;
    const sent = entry.desired, intent = entry.intent;
    try {
      const result = await this.send(message, emoji, sent, this.abort.signal);
      if (this.stopped) return;
      if (result.conversation_id !== this.conversationId || result.message_id !== message || result.user_id !== this.userId || !/^\d+$/.test(result.revision)) throw Object.assign(new Error('Invalid reaction response'), { status: 502 });
      this.apply(result); entry.inFlight = false; entry.uncertain = false; entry.attempts = 0;
      if (entry.intent === intent && this.state(message).mineRevision > BigInt(result.revision)) this.pending.get(message)?.delete(emoji);
      else if (entry.desired !== this.state(message).mine.has(emoji)) this.schedule(message, emoji, entry, 220);
      else this.pending.get(message)?.delete(emoji);
    } catch (error) {
      if (this.stopped) return;
      entry.inFlight = false;
      const failure = error as { status?: number; code?: string; retryAfterMs?: number };
      const transient = failure.code !== 'AUTH_ACCOUNT_CHANGED' && (!failure.status || [408, 425, 429].includes(failure.status) || failure.status >= 500);
      // Even if intent now equals the old server state, an unknown outcome
      // requires an explicit compensation, not another toggle or a silent drop.
      entry.uncertain = transient;
      if (transient && entry.attempts < 3) this.schedule(message, emoji, entry, Math.min(30_000, Math.max(250 * 2 ** entry.attempts++, Number(failure.retryAfterMs) || 0)));
      else { this.pending.get(message)?.delete(emoji); this.failure(error); }
    }
    this.emit();
  }
  dispose() {
    this.stopped = true; this.abort.abort();
    for (const entries of this.pending.values()) for (const entry of entries.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
