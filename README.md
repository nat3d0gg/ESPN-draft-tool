# ESPN-draft-tool

A TypeScript toolkit for running a fantasy draft with **live Redis sync**, so a
draft board, bots, and spectators all see picks the instant they happen.

## Live Redis sync

Redis is the authoritative store for each draft's state. Every mutation is:

- **Atomic** — picks run through a server-side Lua script that verifies the
  player is still available, removes them from the pool, records the pick,
  advances the clock, and bumps a revision counter in a single round trip. Two
  clients can't draft the same player.
- **Broadcast** — each change is published on a per-draft pub/sub channel, so
  any number of subscribers stay in sync in real time.

### Install

```bash
npm install
```

Requires a running Redis (`redis://127.0.0.1:6379` by default; override with the
`REDIS_URL` env var).

### Usage

```ts
import Redis from "ioredis";
import { DraftSync } from "espn-draft-tool";

const redis = new Redis();
const subscriber = new Redis(); // pub/sub needs its own connection

const sync = new DraftSync({ redis, subscriber });

await sync.createDraft({
  draftId: "2026-league",
  teams: [
    { id: 1, name: "The Gronk Squad", slot: 1 },
    { id: 2, name: "Purple Reign", slot: 2 },
  ],
  players: [
    { id: 3117251, fullName: "Christian McCaffrey", position: "RB" },
    { id: 4362628, fullName: "Ja'Marr Chase", position: "WR" },
  ],
  rounds: 2,
});

// Subscribe anywhere to receive picks live.
const unsubscribe = await sync.subscribe("2026-league", (event) => {
  if (event.type === "pick") {
    console.log(`Pick ${event.pick.overall}: player ${event.pick.playerId}`);
  }
});

// Record a pick — atomic, and broadcast to every subscriber.
await sync.makePick("2026-league", 1, 3117251);

const state = await sync.getState("2026-league");
```

### API

| Method | Description |
| --- | --- |
| `createDraft(input)` | Initialize (or overwrite) a draft's state and publish a `sync` event. |
| `getState(draftId)` | Read the current authoritative state. |
| `makePick(draftId, teamId, playerId)` | Atomically record a pick; throws if the player is taken or the draft is missing/complete. |
| `reset(draftId)` | Return a draft to `pending` with all players available. |
| `subscribe(draftId, listener)` | Receive live `DraftEvent`s; returns an async unsubscribe function. |

Event types: `pick`, `status`, `reset`, `sync`.

### Key layout

```
draft:{draftId}:state    JSON string — authoritative DraftState
draft:{draftId}:events   pub/sub channel — DraftEvent stream
```

The prefix (`draft`) is configurable via `new DraftSync({ prefix })`.

## Scripts

```bash
npm run build      # compile to dist/
npm run typecheck  # type-check only
npm test           # run the test suite (needs Redis)
npm run example    # live draft demo (needs Redis)
```
