import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";
import { DraftSync } from "../src/sync.js";
import type { DraftEvent, DraftTeam, Player } from "../src/types.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const teams: DraftTeam[] = [
  { id: 1, name: "Team A", slot: 1 },
  { id: 2, name: "Team B", slot: 2 },
];

const players: Player[] = [
  { id: 100, fullName: "Player 100", position: "RB" },
  { id: 101, fullName: "Player 101", position: "WR" },
  { id: 102, fullName: "Player 102", position: "QB" },
  { id: 103, fullName: "Player 103", position: "TE" },
];

describe("DraftSync", () => {
  let redis: Redis;
  let subscriber: Redis;
  let sync: DraftSync;

  before(() => {
    redis = new Redis(REDIS_URL);
    subscriber = new Redis(REDIS_URL);
    sync = new DraftSync({ redis, subscriber, prefix: "test-draft" });
  });

  after(async () => {
    await redis.flushdb();
    redis.disconnect();
    subscriber.disconnect();
  });

  it("creates a draft with all players available", async () => {
    const state = await sync.createDraft({
      draftId: "d1",
      teams,
      players,
      rounds: 2,
    });
    assert.equal(state.status, "pending");
    assert.deepEqual(state.availablePlayerIds, [100, 101, 102, 103]);
    assert.equal(state.onTheClock, 1);
    assert.equal(state.revision, 0);
  });

  it("records a pick, removes the player, and advances the clock", async () => {
    const state = await sync.makePick("d1", 1, 100);
    assert.equal(state.status, "in_progress");
    assert.equal(state.picks.length, 1);
    assert.equal(state.picks[0]?.playerId, 100);
    assert.equal(state.picks[0]?.round, 1);
    assert.equal(state.picks[0]?.overall, 1);
    assert.ok(!state.availablePlayerIds.includes(100));
    assert.equal(state.onTheClock, 2);
    assert.equal(state.revision, 1);
  });

  it("rejects drafting an already-taken player", async () => {
    await assert.rejects(() => sync.makePick("d1", 2, 100), /not available/);
  });

  it("rejects an unknown draft", async () => {
    await assert.rejects(() => sync.makePick("nope", 1, 100), /not found/);
  });

  it("marks the draft complete when all rounds are used", async () => {
    // 2 teams x 2 rounds = 4 picks. One already made above.
    await sync.makePick("d1", 2, 101);
    await sync.makePick("d1", 1, 102);
    const final = await sync.makePick("d1", 2, 103);
    assert.equal(final.status, "complete");
    assert.equal(final.picks.length, 4);
    await assert.rejects(() => sync.makePick("d1", 1, 999), /complete/);
  });

  it("broadcasts pick events to subscribers", async () => {
    await sync.createDraft({ draftId: "d2", teams, players, rounds: 2 });

    const received: DraftEvent[] = [];
    const unsubscribe = await sync.subscribe("d2", (event) => {
      received.push(event);
    });

    await sync.makePick("d2", 1, 100);
    await sync.makePick("d2", 2, 101);

    // Give pub/sub a moment to deliver.
    await sleep(50);
    await unsubscribe();

    const picks = received.filter((e) => e.type === "pick");
    assert.equal(picks.length, 2);
    assert.equal(picks[0]?.type === "pick" && picks[0].pick.playerId, 100);
    assert.equal(picks[1]?.type === "pick" && picks[1].pick.playerId, 101);
  });

  it("concurrent picks of the same player only succeed once", async () => {
    await sync.createDraft({ draftId: "d3", teams, players, rounds: 4 });
    const results = await Promise.allSettled([
      sync.makePick("d3", 1, 100),
      sync.makePick("d3", 2, 100),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
  });

  it("resets a draft back to pending with all players available", async () => {
    const state = await sync.reset("d1");
    assert.equal(state.status, "pending");
    assert.equal(state.picks.length, 0);
    assert.deepEqual(state.availablePlayerIds, [100, 101, 102, 103]);
    assert.equal(state.onTheClock, 1);
  });
});
