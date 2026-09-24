/**
 * Every state the component catalog renders, from fixtures alone.
 *
 * One documented command draws each of these through the mounted component
 * tree, at each layout profile. A catalog entry is a *location* — a URL and how
 * far the execution had recorded — because that is what the interface is
 * addressed by; the components it mounts follow from projecting that state.
 *
 * The long tail #840 also asks for — large values, long source, code blocks,
 * tables, deep nesting, dense history, secrets and an invisible helper scope —
 * is a later slice. What is here is the baseline the rest hangs off.
 */

import type { Operation } from "effection";

import { paint } from "./paint.ts";
import { PROFILE_SIZES, useTerm } from "./capture.ts";
import type { Size } from "./capture.ts";
import { journalThrough } from "./journal.ts";
import { hydrate, layoutOf } from "./store.ts";
import { useReplTree } from "./tree.ts";
import { enterRoute } from "./drive.ts";
import { project } from "./view.ts";
import { applyAnsi, createGrid, gridText } from "./screen.ts";
import type { Profile } from "./layout.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** How far the execution had recorded. A URL never carries this. */
  readonly head?: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  { id: "empty", title: "An empty REPL, before anything has run", url: "xmd://repl/e1/input" },
  {
    id: "nested",
    title: "Nested execution, with the Plan scope open",
    url: "xmd://repl/e1/transcript/entry-1/document",
    head: "cp-06",
  },
  {
    id: "sessions",
    title: "Three concurrent Agent sessions",
    url: "xmd://repl/e1/sessions/entry-1/document",
    head: "cp-13",
  },
  {
    id: "drawer-project",
    title: "The project Elicit drawer",
    url: "xmd://repl/e1/transcript/entry-1/document/+project",
    head: "cp-14",
  },
  {
    id: "drawer-review",
    title: "The plan-review Elicit drawer",
    url: "xmd://repl/e1/transcript/entry-1/document/plan/+review",
    head: "cp-08",
  },
  {
    id: "drawer-confirm",
    title: "The README confirmation drawer",
    url: "xmd://repl/e1/transcript/entry-1/document/+confirm",
    head: "cp-16",
  },
  {
    id: "bindings-plan",
    title: "Bindings at the Plan scope",
    url: "xmd://repl/e1/bindings/entry-1/document/plan",
    head: "cp-06",
  },
  {
    id: "bindings-document",
    title: "Bindings at the document scope",
    url: "xmd://repl/e1/bindings/entry-1/document",
    head: "cp-13",
  },
  {
    id: "inspecting",
    title: "Historical inspection, reconstructed and read-only",
    url: "xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect",
    head: "cp-18",
  },
  {
    id: "drawer-historical",
    title: "A recorded drawer, rendered without anything to act on",
    url: "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-04&inspect",
    head: "cp-18",
  },
  {
    id: "settled",
    title: "A settled entry, the input ready for the next one",
    url: "xmd://repl/e1/input?draft=%3CPlan%3E",
    head: "cp-22",
  },
];

export function entry(id: string): CatalogEntry | undefined {
  return CATALOG.find((one) => one.id === id);
}

export interface CatalogFrame {
  readonly name: string;
  readonly entry: CatalogEntry;
  readonly profile: Profile;
  readonly size: Size;
  readonly text: string;
}

/**
 * One catalog state, rendered through the mounted component tree.
 *
 * The tree is mounted, entered, handed the projected view and walked — the same
 * path the interactive harness takes, so a catalog capture cannot show
 * something the running REPL would not.
 */
export function renderCatalog(subject: CatalogEntry, profile: Profile): Operation<CatalogFrame> {
  return {
    *[Symbol.iterator]() {
      const size = PROFILE_SIZES[profile];
      const state = hydrate(subject.url, journalThrough(subject.head));
      const tree = yield* useReplTree(state, size);
      yield* enterRoute(tree, state);
      const term = yield* useTerm(size);
      const result = term.render(
        paint({ tree, view: project(state), layout: layoutOf(state, size) }).ops,
        { deltaTime: 0 },
      );
      if (result.errors.length > 0) {
        throw new Error(`the renderer reported ${JSON.stringify(result.errors)}`);
      }
      const grid = applyAnsi(createGrid(size.cols, size.rows), Uint8Array.from(result.output));
      return {
        name: `${subject.id}.${profile}`,
        entry: subject,
        profile,
        size,
        text: gridText(grid),
      };
    },
  };
}

/** The whole catalog, at the profiles a reader can check it at. */
export function renderAll(): Operation<CatalogFrame[]> {
  return {
    *[Symbol.iterator]() {
      const frames: CatalogFrame[] = [];
      for (const subject of CATALOG) {
        for (const profile of ["wide", "narrow"] as const) {
          frames.push(yield* renderCatalog(subject, profile));
        }
      }
      return frames;
    },
  };
}

/** What a catalog capture is written as: the state it shows, then the screen. */
export function catalogText(frame: CatalogFrame): string {
  const header = `${frame.name} · ${frame.size.cols} × ${frame.size.rows} · ${frame.entry.title}`;
  return `${header}\n${frame.text.replace(/\n+$/, "")}\n`;
}
