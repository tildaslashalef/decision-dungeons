// The single store the UI reads. Views subscribe and re-render the parts
// they own; nothing else holds UI state.

import type { Decision } from "../contract/answer.ts";
import type { DeciderView, PublicConfig } from "../contract/api.ts";
import type { Request } from "../contract/request.ts";
import type { Outcome } from "../dungeons/dungeon.ts";
import type { CaseSetInfo } from "../dungeons/text/cases.ts";

export interface Selection {
  dungeon: string;
  level: string;
  decider: string;
  model: string;
  seed: number;
  /** Evaluation mode: the dungeon's safety nets off (`Dungeon.evaluation`). */
  evaluation: boolean;
  /** The case set a text dungeon plays (`Dungeon.caseSets`). */
  caseSet: string;
}

/** One decision as the debug sidebar shows it. */
export interface DebugEntry {
  id: number;
  time: string;
  request: Request;
  /** Browser-measured: includes HTTP and the server's validation. */
  roundTripMs?: number;
  decision?: Decision;
  error?: { code: string; message: string };
}

export type PlayStatus =
  | "loading"
  | "deciding"
  | "waiting"
  | "paused"
  | "finished"
  | "failed";

export interface PlayState {
  selection: Selection;
  /** The dungeon's run; owned by the play loop, read by the dungeon's view. Null while loading. */
  run: unknown;
  outcome: Outcome;
  status: PlayStatus;
  error?: { code: string; message: string };
  /** The request being decided now, or the last one decided. */
  current?: DebugEntry;
}

export interface State {
  route: "gate" | "lobby" | "config" | "play";
  deciders?: DeciderView[];
  /** Each text dungeon's case sets, once listed. */
  caseSets?: Record<string, CaseSetInfo[]>;
  caseSetsError?: string | undefined;
  decidersError?: string | undefined;
  config?: PublicConfig;
  configError?: string | undefined;
  /** The last config-page save result, shown under its section. */
  configNotice?: { section: string; text: string; error: boolean };
  selection: Selection;
  play?: PlayState | undefined;
  debugOpen: boolean;
  debug: DebugEntry[];
}

type Listener = (state: State, previous: State) => void;

export class Store {
  private listeners = new Set<Listener>();
  constructor(private state: State) {}

  get(): State {
    return this.state;
  }

  set(patch: Partial<State>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    for (const listener of this.listeners) listener(this.state, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Decisions kept for the sidebar's history. */
export const DEBUG_HISTORY = 12;
