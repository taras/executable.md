/**
 * What the REPL is showing, said semantically.
 *
 * A fixture describes execution — which scopes are open, what phase each one is
 * in, which sections have settled, what the sessions are doing, which values a
 * scope published, where the recorded head is — and nothing about a terminal. No
 * row, column, width or byte appears in this file or in any value built from it.
 * `layout.ts` decides where things go and `render.ts` decides what cells they
 * become, so a rendering change cannot quietly become application state.
 */

/** The lifecycle phase of one component, as the study's study names it. */
export type Phase = "enter" | "active" | "waiting" | "exit" | "settled" | "failed" | "pending";

/** One line of the execution projection. */
export type TranscriptRow =
  /** A component boundary or expression, carrying its lifecycle phase. */
  | {
      readonly kind: "lifecycle";
      readonly source: string;
      readonly depth: number;
      readonly phase: Phase;
      /** Rows sharing a pair name are one scope's opening and closing boundary. */
      readonly pair?: string;
      readonly close?: boolean;
    }
  /** Rendered prose the execution produced. Long text wraps. */
  | {
      readonly kind: "prose";
      readonly text: string;
      readonly depth: number;
      readonly emphasis?: "title" | "strong" | "dim";
    }
  /** Generated Markdown or XMD, shown before and after it is admitted. */
  | {
      readonly kind: "fence";
      readonly label: string;
      readonly lines: readonly string[];
      readonly caption?: string;
      readonly depth: number;
    }
  /** Completed work, collapsed to the bindings it published. */
  | {
      readonly kind: "section";
      readonly name: string;
      readonly published: string;
      readonly state: "collapsed" | "expanded";
      readonly depth: number;
    };

/** One transcript entry: immutable source, and the execution it opened. */
export interface Entry {
  readonly id: string;
  readonly title: string;
  readonly state: "running" | "completed";
  readonly elapsed: string;
  readonly sourceLines: number;
  readonly scopeNote: string;
  readonly rows: readonly TranscriptRow[];
}

export interface Session {
  readonly id: string;
  readonly agent: string;
  readonly state: "queued" | "active" | "completed";
  readonly label: string;
  readonly turn: string;
  readonly selected?: boolean;
  readonly note?: string;
}

export interface Binding {
  readonly name: string;
  readonly note?: string;
  readonly lines: readonly string[];
}

/**
 * One semantic checkpoint on the recorded timeline.
 *
 * `kind` is the study's major/minor distinction: an entry boundary is major,
 * every other recorded moment is minor. `depth` is how deeply nested the scope
 * that produced it was, which is what the band runs out of room for first.
 */
export interface Checkpoint {
  readonly at: number;
  readonly kind: "entry" | "event";
  readonly label: string;
  readonly scope: string;
  readonly depth: number;
  readonly records: readonly string[];
}

export type TransportMode = "idle" | "live" | "paused" | "inspecting";

export interface History {
  readonly elapsed: string;
  /** Recorded seconds at the head. The head is the newest recorded moment. */
  readonly headAt: number;
  /** Where a historical selection sits, when the fixture has one. */
  readonly selectedAt?: number;
  readonly checkpoints: readonly Checkpoint[];
  readonly transport: TransportMode;
  /** A long wait the band compresses rather than drawing to scale. */
  readonly compressed?: { readonly at: number; readonly note: string };
}

export type Drawer =
  | {
      readonly kind: "project";
      readonly heading: string;
      readonly origin: string;
      readonly prompt: string;
      readonly fields: readonly { readonly label: string; readonly value: string }[];
      readonly schema: readonly string[];
      readonly validation: string;
      readonly submit: string;
    }
  | {
      readonly kind: "review";
      readonly heading: string;
      readonly origin: string;
      readonly plan: readonly string[];
      readonly more: string;
      readonly decisions: readonly {
        readonly label: string;
        readonly chosen: boolean;
        readonly note?: string;
      }[];
      readonly submit: string;
    }
  | {
      readonly kind: "confirm";
      readonly heading: string;
      readonly origin: string;
      readonly prompt: string;
      readonly preview: readonly string[];
      readonly actions: readonly { readonly label: string; readonly primary: boolean }[];
      readonly hint: string;
    };

export interface SidebarState {
  readonly tab: "sessions" | "journal" | "state";
  /** Shown instead of a list when there is nothing to list. */
  readonly placeholder?: readonly string[];
  readonly heading?: string;
  readonly subheading?: string;
}

export interface BindingsPane {
  readonly scopeName: string;
  readonly bindings: readonly Binding[];
  readonly placeholder?: readonly string[];
}

export interface InputBand {
  readonly label: string;
  readonly hint: string;
  readonly placeholder?: string;
  readonly runEnabled: boolean;
}

export const FIXTURE_NAMES = [
  "empty",
  "nested",
  "generated",
  "drawer",
  "paused",
  "settled",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface Fixture {
  readonly name: FixtureName;
  /** One line naming the moment, shown by the harness itself, not the REPL. */
  readonly moment: string;
  readonly crumb: string;
  /** The study's `RECONSTRUCTED AT … · READ-ONLY` or `PAUSED AT HEAD`. */
  readonly badge?: string;
  readonly readOnly?: boolean;
  readonly sidebar: SidebarState;
  readonly entry?: Entry;
  readonly sessions: readonly Session[];
  readonly bindings: BindingsPane;
  readonly drawer?: Drawer;
  readonly input: InputBand;
  readonly history: History;
}

export function isFixtureName(value: string): value is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(value);
}
