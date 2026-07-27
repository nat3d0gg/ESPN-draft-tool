/**
 * Core domain types for an ESPN fantasy draft.
 *
 * These are intentionally minimal and transport-agnostic so they can be
 * serialized to Redis, sent over a WebSocket, or persisted elsewhere.
 */

export interface Player {
  /** ESPN player id (stable across a season). */
  id: number;
  fullName: string;
  /** Position abbreviation, e.g. "QB", "RB", "WR", "TE", "K", "D/ST". */
  position: string;
  /** NFL team abbreviation, e.g. "SF". */
  proTeam?: string;
  /** Pre-draft average draft position, used for ranking suggestions. */
  averageDraftPosition?: number;
}

export interface DraftPick {
  /** 1-based overall pick number. */
  overall: number;
  /** 1-based round number. */
  round: number;
  /** Fantasy team id making the pick. */
  teamId: number;
  /** The drafted player's id. */
  playerId: number;
  /** Epoch milliseconds the pick was recorded. */
  timestamp: number;
}

export interface DraftTeam {
  id: number;
  name: string;
  /** Draft slot (1-based). */
  slot: number;
}

export interface DraftState {
  draftId: string;
  status: "pending" | "in_progress" | "complete";
  teams: DraftTeam[];
  picks: DraftPick[];
  /** Player ids still available to be drafted. */
  availablePlayerIds: number[];
  /** Overall pick number that is on the clock (1-based). */
  onTheClock: number;
  /** Monotonically increasing revision, bumped on every mutation. */
  revision: number;
  updatedAt: number;
}

/** Events published over the live sync channel. */
export type DraftEvent =
  | { type: "pick"; draftId: string; pick: DraftPick; revision: number }
  | { type: "status"; draftId: string; status: DraftState["status"]; revision: number }
  | { type: "reset"; draftId: string; revision: number }
  | { type: "sync"; draftId: string; state: DraftState };
