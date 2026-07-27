/**
 * Minimal end-to-end demo of live Redis sync.
 *
 * Run a local Redis, then:  npm run example
 *
 * It creates a draft, subscribes a "spectator" to the live channel, makes a
 * few picks, and prints each event as it arrives in real time.
 */
import Redis from "ioredis";
import { DraftSync } from "../src/index.js";
import type { DraftTeam, Player } from "../src/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const teams: DraftTeam[] = [
  { id: 1, name: "The Gronk Squad", slot: 1 },
  { id: 2, name: "Purple Reign", slot: 2 },
];

const players: Player[] = [
  { id: 3117251, fullName: "Christian McCaffrey", position: "RB", proTeam: "SF", averageDraftPosition: 1.2 },
  { id: 4362628, fullName: "Ja'Marr Chase", position: "WR", proTeam: "CIN", averageDraftPosition: 2.4 },
  { id: 3116406, fullName: "Tyreek Hill", position: "WR", proTeam: "MIA", averageDraftPosition: 3.1 },
  { id: 4241457, fullName: "Bijan Robinson", position: "RB", proTeam: "ATL", averageDraftPosition: 4.0 },
];

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  const subscriber = new Redis(REDIS_URL);
  const sync = new DraftSync({ redis, subscriber });

  const byId = new Map(players.map((p) => [p.id, p]));
  const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? `Team ${id}`;

  const unsubscribe = await sync.subscribe("2026-league", (event) => {
    if (event.type === "pick") {
      const p = byId.get(event.pick.playerId);
      console.log(
        `[live] R${event.pick.round} P${event.pick.overall}: ` +
          `${teamName(event.pick.teamId)} select ${p?.fullName ?? event.pick.playerId} (${p?.position})`,
      );
    } else {
      console.log(`[live] ${event.type} event (rev ${"revision" in event ? event.revision : "?"})`);
    }
  });

  await sync.createDraft({ draftId: "2026-league", teams, players, rounds: 2 });

  await sync.makePick("2026-league", 1, 3117251); // Team 1 -> CMC
  await sync.makePick("2026-league", 2, 4362628); // Team 2 -> Chase
  await sync.makePick("2026-league", 2, 3116406); // snake back to Team 2 -> Hill
  await sync.makePick("2026-league", 1, 4241457); // Team 1 -> Bijan

  // Let the last event flush before tearing down.
  await new Promise((r) => setTimeout(r, 100));

  const finalState = await sync.getState("2026-league");
  console.log(`\nDraft status: ${finalState?.status}`);
  console.log(`Picks made:   ${finalState?.picks.length}`);
  console.log(`Remaining:    ${finalState?.availablePlayerIds.length}`);

  await unsubscribe();
  redis.disconnect();
  subscriber.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
