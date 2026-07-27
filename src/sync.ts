import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { eventsChannel, stateKey } from "./keys.js";
import type {
  DraftEvent,
  DraftPick,
  DraftState,
  DraftTeam,
  Player,
} from "./types.js";

export interface DraftSyncOptions {
  /** Key prefix / namespace. Defaults to "draft". */
  prefix?: string;
  /**
   * A connected ioredis client used for reads and writes. The same client
   * can be shared across many drafts.
   */
  redis: Redis;
  /**
   * A *separate* ioredis client used only for pub/sub subscriptions. Redis
   * connections in subscriber mode can't run normal commands, so this must
   * not be the same instance as `redis`. Only required if you call
   * `subscribe()`.
   */
  subscriber?: Redis;
}

/**
 * Atomically records a pick: verifies the player is still available, removes
 * it from the available pool, appends the pick, advances the clock, bumps the
 * revision, writes the state back, and publishes an event — all in one round
 * trip so concurrent drafters can't double-draft a player.
 */
const MAKE_PICK_LUA = `
local stateJson = redis.call('GET', KEYS[1])
if not stateJson then
  return redis.error_reply('DRAFT_NOT_FOUND')
end
local state = cjson.decode(stateJson)
if state.status == 'complete' then
  return redis.error_reply('DRAFT_COMPLETE')
end

local playerId = tonumber(ARGV[1])
local teamId = tonumber(ARGV[2])
local timestamp = tonumber(ARGV[3])

-- Confirm the player is still available and drop them from the pool.
local found = false
local remaining = {}
for _, id in ipairs(state.availablePlayerIds) do
  if id == playerId then
    found = true
  else
    remaining[#remaining + 1] = id
  end
end
if not found then
  return redis.error_reply('PLAYER_UNAVAILABLE')
end
state.availablePlayerIds = remaining

local overall = state.onTheClock
local round = math.floor((overall - 1) / #state.teams) + 1
local pick = {
  overall = overall,
  round = round,
  teamId = teamId,
  playerId = playerId,
  timestamp = timestamp,
}
state.picks[#state.picks + 1] = pick

state.onTheClock = overall + 1
state.status = 'in_progress'
if #state.availablePlayerIds == 0 or overall >= (#state.teams * (state.rounds or 0)) then
  if (state.rounds or 0) > 0 and overall >= (#state.teams * state.rounds) then
    state.status = 'complete'
  elseif #state.availablePlayerIds == 0 then
    state.status = 'complete'
  end
end
state.revision = state.revision + 1
state.updatedAt = timestamp

-- cjson encodes empty Lua tables as objects; force arrays to stay arrays.
if #state.availablePlayerIds == 0 then state.availablePlayerIds = {} end
local newJson = cjson.encode(state)
redis.call('SET', KEYS[1], newJson)

local event = cjson.encode({
  type = 'pick',
  draftId = state.draftId,
  pick = pick,
  revision = state.revision,
})
redis.call('PUBLISH', KEYS[2], event)

return newJson
`;

export interface CreateDraftInput {
  draftId: string;
  teams: DraftTeam[];
  players: Player[];
  /** Total rounds; used to mark the draft complete. 0 = unbounded. */
  rounds?: number;
}

type Listener = (event: DraftEvent) => void;

/**
 * DraftSync is the live source of truth for a draft, backed by Redis.
 *
 * Writes are atomic (via a server-side Lua script) and every mutation is
 * broadcast on a pub/sub channel so any number of clients — draft boards,
 * bots, spectators — stay in sync in real time.
 */
export class DraftSync {
  private readonly redis: Redis;
  private readonly subscriber?: Redis;
  private readonly prefix: string;
  private readonly emitter = new EventEmitter();
  private subscribedChannels = new Set<string>();
  private messageHandlerBound = false;

  constructor(options: DraftSyncOptions) {
    this.redis = options.redis;
    this.subscriber = options.subscriber;
    this.prefix = options.prefix ?? "draft";
  }

  /** Create (or overwrite) a draft's initial state and publish a sync event. */
  async createDraft(input: CreateDraftInput): Promise<DraftState> {
    const now = Date.now();
    const state: DraftState & { rounds?: number } = {
      draftId: input.draftId,
      status: "pending",
      teams: input.teams,
      picks: [],
      availablePlayerIds: input.players.map((p) => p.id),
      onTheClock: 1,
      revision: 0,
      updatedAt: now,
      rounds: input.rounds ?? 0,
    };
    await this.redis.set(this.stateKey(input.draftId), JSON.stringify(state));
    await this.redis.publish(
      this.channel(input.draftId),
      JSON.stringify({ type: "sync", draftId: input.draftId, state } satisfies DraftEvent),
    );
    return state;
  }

  /** Fetch the current authoritative state, or null if the draft is unknown. */
  async getState(draftId: string): Promise<DraftState | null> {
    const raw = await this.redis.get(this.stateKey(draftId));
    return raw ? normalizeState(JSON.parse(raw)) : null;
  }

  /**
   * Record a pick atomically. Throws if the draft is missing/complete or the
   * player was already taken. Returns the resulting state.
   */
  async makePick(
    draftId: string,
    teamId: number,
    playerId: number,
  ): Promise<DraftState> {
    let result: unknown;
    try {
      result = await this.redis.eval(
        MAKE_PICK_LUA,
        2,
        this.stateKey(draftId),
        this.channel(draftId),
        String(playerId),
        String(teamId),
        String(Date.now()),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("DRAFT_NOT_FOUND")) {
        throw new Error(`Draft "${draftId}" not found`);
      }
      if (message.includes("PLAYER_UNAVAILABLE")) {
        throw new Error(`Player ${playerId} is not available in draft "${draftId}"`);
      }
      if (message.includes("DRAFT_COMPLETE")) {
        throw new Error(`Draft "${draftId}" is already complete`);
      }
      throw err;
    }
    return normalizeState(JSON.parse(result as string));
  }

  /** Reset a draft back to its initial pending state (keeps teams/players). */
  async reset(draftId: string): Promise<DraftState> {
    const state = await this.getState(draftId);
    if (!state) throw new Error(`Draft "${draftId}" not found`);
    const players = new Set(state.availablePlayerIds);
    for (const pick of state.picks) players.add(pick.playerId);
    const next: DraftState = {
      ...state,
      status: "pending",
      picks: [],
      availablePlayerIds: [...players].sort((a, b) => a - b),
      onTheClock: 1,
      revision: state.revision + 1,
      updatedAt: Date.now(),
    };
    await this.redis.set(this.stateKey(draftId), JSON.stringify(next));
    await this.redis.publish(
      this.channel(draftId),
      JSON.stringify({ type: "reset", draftId, revision: next.revision } satisfies DraftEvent),
    );
    return next;
  }

  /**
   * Subscribe to live events for a draft. The returned function unsubscribes.
   * Requires a `subscriber` client to have been provided.
   */
  async subscribe(draftId: string, listener: Listener): Promise<() => Promise<void>> {
    if (!this.subscriber) {
      throw new Error(
        "DraftSync.subscribe requires a dedicated `subscriber` Redis client",
      );
    }
    const channel = this.channel(draftId);
    this.bindMessageHandler();
    this.emitter.on(channel, listener);
    if (!this.subscribedChannels.has(channel)) {
      await this.subscriber.subscribe(channel);
      this.subscribedChannels.add(channel);
    }
    return async () => {
      this.emitter.off(channel, listener);
      if (this.emitter.listenerCount(channel) === 0) {
        this.subscribedChannels.delete(channel);
        await this.subscriber?.unsubscribe(channel);
      }
    };
  }

  private bindMessageHandler(): void {
    if (this.messageHandlerBound || !this.subscriber) return;
    this.subscriber.on("message", (channel: string, message: string) => {
      let parsed: DraftEvent;
      try {
        parsed = JSON.parse(message) as DraftEvent;
      } catch {
        return;
      }
      this.emitter.emit(channel, parsed);
    });
    this.messageHandlerBound = true;
  }

  private stateKey(draftId: string): string {
    return stateKey(this.prefix, draftId);
  }

  private channel(draftId: string): string {
    return eventsChannel(this.prefix, draftId);
  }
}

/**
 * Redis' cjson encodes an empty Lua table as `{}` (an object) rather than
 * `[]`, so a fully-drafted pool round-trips as an object. Coerce the array
 * fields back to arrays before handing state to callers.
 */
function normalizeState(state: DraftState): DraftState {
  if (!Array.isArray(state.availablePlayerIds)) state.availablePlayerIds = [];
  if (!Array.isArray(state.picks)) state.picks = [];
  return state;
}
