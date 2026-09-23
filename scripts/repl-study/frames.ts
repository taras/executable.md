/**
 * The Product Owner's focus study, as fourteen addressable states.
 *
 * Each frame of the approved study carries a numbered target list, a focused
 * number, and a `meta` record naming what Tab and Shift+Tab do from there. That
 * is the acceptance source for #839, so it is transcribed here rather than
 * paraphrased: `study` is the label the study prints, `id` is the identity this
 * harness answers with, and `tab` and `shift` are the identities the study's
 * prose names.
 *
 * `url` is what makes a frame reachable — `deno task repl:study --frame 07`
 * opens it — and `head` is how far the execution had got when it was taken,
 * which is journal truth and deliberately not in the URL.
 */

import { journalThrough } from "./journal.ts";
import type { FixtureName } from "./model.ts";
import { hydrate } from "./store.ts";
import type { ReplState } from "./store.ts";

export interface StudyTarget {
  /** The number the study's overlay writes beside this target. */
  readonly n: number;
  readonly id: string;
  readonly kind: "region" | "control" | "field";
  /** The label the study prints. The harness writes its own, from state. */
  readonly study: string;
}

export interface StudyFrame {
  readonly id: string;
  readonly title: string;
  /** What the study says produced this frame. */
  readonly key: string;
  readonly url: string;
  /** The journal marker the execution had recorded. Absent is a fresh REPL. */
  readonly head?: string;
  readonly focus: string;
  readonly fixture: FixtureName;
  /** Whether the study drew the numbered overlay in this frame. */
  readonly overlay: boolean;
  readonly targets: readonly StudyTarget[];
  /** The identity Tab lands on, and the study's own wording for it. */
  readonly tab: string;
  readonly shift: string;
  readonly meta: { readonly tab: string; readonly shift: string; readonly trap: boolean };
}

const REGIONS: readonly StudyTarget[] = [
  { n: 1, id: "region:sessions", kind: "region", study: "Sessions / Journal / State" },
  { n: 2, id: "region:transcript", kind: "region", study: "Transcript" },
  { n: 3, id: "region:bindings", kind: "region", study: "Bindings" },
  { n: 4, id: "region:input", kind: "region", study: "REPL input" },
  { n: 5, id: "region:history", kind: "region", study: "Execution History" },
];

const PAUSE: StudyTarget = { n: 6, id: "control:transport.pause", kind: "control", study: "Pause" };
const CONTINUE: StudyTarget = {
  n: 6,
  id: "control:transport.continue",
  kind: "control",
  study: "Continue",
};
const RETURN_HEAD: StudyTarget = {
  n: 7,
  id: "control:transport.return-head",
  kind: "control",
  study: "Return to paused head",
};
const FORK: StudyTarget = {
  n: 8,
  id: "control:transport.fork",
  kind: "control",
  study: "Fork from here",
};

export const FRAMES: readonly StudyFrame[] = [
  {
    id: "01",
    title: "Empty REPL · focus in the input",
    key: "initial focus on load",
    url: "xmd://repl/e1/input",
    focus: "region:input",
    fixture: "empty",
    overlay: false,
    targets: [REGIONS[3]],
    tab: "region:history",
    shift: "region:bindings",
    meta: { tab: "region 5 · Execution History", shift: "region 3 · Bindings", trap: false },
  },
  {
    id: "02",
    title: "Focus map overlay activated",
    key: "F1 · toggle focus map",
    url: "xmd://repl/e1/input",
    focus: "region:input",
    fixture: "empty",
    overlay: true,
    targets: REGIONS,
    tab: "region:history",
    shift: "region:bindings",
    meta: { tab: "5 · Execution History", shift: "3 · Bindings", trap: false },
  },
  {
    id: "03",
    title: "Forward Tab · into Execution History",
    key: "Tab",
    url: "xmd://repl/e1/history",
    focus: "region:history",
    fixture: "empty",
    overlay: true,
    targets: REGIONS,
    tab: "region:sessions",
    shift: "region:input",
    meta: { tab: "1 · Sessions — the ring wraps", shift: "4 · REPL input", trap: false },
  },
  {
    id: "04",
    title: "Reverse Shift+Tab · back to Bindings",
    key: "Shift+Tab ×2 from region 5",
    url: "xmd://repl/e1/bindings",
    focus: "region:bindings",
    fixture: "empty",
    overlay: true,
    targets: REGIONS,
    tab: "region:input",
    shift: "region:transcript",
    meta: { tab: "4 · REPL input", shift: "2 · Transcript", trap: false },
  },
  {
    id: "05",
    title: "Running transcript · footer controls reachable",
    key: "Tab ×2 from the transcript",
    url: "xmd://repl/e1/history/entry-1/document",
    head: "cp-06",
    focus: "control:transport.pause",
    fixture: "nested",
    overlay: true,
    targets: [...REGIONS, PAUSE],
    tab: "region:sessions",
    shift: "region:history",
    meta: {
      tab: "1 · Sessions — leaves the footer",
      shift: "5 · Execution History region",
      trap: false,
    },
  },
  {
    id: "06",
    title: "Three Agent sessions · background activity does not steal focus",
    key: "no keypress — reviewer session starts streaming",
    url: "xmd://repl/e1/transcript/entry-1/document",
    head: "cp-13",
    focus: "region:transcript",
    fixture: "drawer",
    overlay: true,
    targets: REGIONS,
    tab: "region:bindings",
    shift: "region:sessions",
    meta: { tab: "3 · Bindings", shift: "1 · Sessions", trap: false },
  },
  {
    id: "07",
    title: "Project-details Elicit · focus trapped in the drawer",
    key: 'execution suspends at <Elicit as="project">',
    url: "xmd://repl/e1/transcript/entry-1/document/+project",
    head: "cp-14",
    focus: "field:drawer.project.name",
    fixture: "drawer",
    overlay: true,
    targets: [
      { n: 1, id: "field:drawer.project.name", kind: "field", study: "Project name" },
      { n: 2, id: "field:drawer.project.description", kind: "field", study: "Description" },
      {
        n: 3,
        id: "control:drawer.project.schema",
        kind: "control",
        study: "Schema disclosure · ⌥S",
      },
      { n: 4, id: "control:drawer.project.submit", kind: "control", study: "Submit" },
      {
        n: 5,
        id: "region:history",
        kind: "region",
        study: "Execution History · still reachable",
      },
    ],
    tab: "field:drawer.project.description",
    shift: "region:history",
    meta: {
      tab: "2 · Description",
      shift: "5 · Execution History — the one way out of the trap",
      trap: true,
    },
  },
  {
    id: "08",
    title: "Plan-review Elicit · scroll region then decisions",
    key: "Tab ×1 from the review scroll region",
    url: "xmd://repl/e1/transcript/entry-1/document/plan/+review",
    head: "cp-08",
    focus: "control:drawer.review.approve",
    fixture: "nested",
    overlay: true,
    targets: [
      {
        n: 1,
        id: "control:drawer.review.scroll",
        kind: "control",
        study: "Plan review · scroll region",
      },
      { n: 2, id: "control:drawer.review.approve", kind: "control", study: "Approve" },
      { n: 3, id: "control:drawer.review.request", kind: "control", study: "Request changes" },
      { n: 4, id: "control:drawer.review.stop", kind: "control", study: "Stop" },
      { n: 5, id: "control:drawer.review.submit", kind: "control", study: "Submit" },
      { n: 6, id: "region:history", kind: "region", study: "Execution History" },
    ],
    tab: "control:drawer.review.request",
    shift: "control:drawer.review.scroll",
    meta: { tab: "3 · Request changes", shift: "1 · review scroll region", trap: true },
  },
  {
    id: "09",
    title: "README-confirmation Elicit · Approve and Decline",
    key: "Tab ×1 from the preview region",
    url: "xmd://repl/e1/transcript/entry-1/document/+confirm",
    head: "cp-16",
    focus: "control:drawer.confirm.approve",
    fixture: "drawer",
    overlay: true,
    targets: [
      {
        n: 1,
        id: "control:drawer.confirm.preview",
        kind: "control",
        study: "README preview · scroll region",
      },
      { n: 2, id: "control:drawer.confirm.approve", kind: "control", study: "Approve" },
      { n: 3, id: "control:drawer.confirm.decline", kind: "control", study: "Decline" },
      { n: 4, id: "region:history", kind: "region", study: "Execution History" },
    ],
    tab: "control:drawer.confirm.decline",
    shift: "control:drawer.confirm.preview",
    meta: { tab: "3 · Decline", shift: "1 · README preview", trap: true },
  },
  {
    id: "10",
    title: "Paused at the live head",
    key: "Enter on Pause, from frame 05",
    url: "xmd://repl/e1/history/entry-1/document",
    head: "cp-18",
    focus: "control:transport.continue",
    fixture: "paused",
    overlay: true,
    targets: [...REGIONS, CONTINUE, RETURN_HEAD],
    tab: "control:transport.return-head",
    shift: "region:history",
    meta: { tab: "7 · Return to paused head", shift: "5 · Execution History region", trap: false },
  },
  {
    id: "11",
    title: "Execution History navigation · checkpoint selected",
    key: "← ← · step back two checkpoints",
    url: "xmd://repl/e1/history/entry-1/document?at=cp-16",
    head: "cp-18",
    focus: "region:history",
    fixture: "paused",
    overlay: true,
    targets: [...REGIONS, CONTINUE, RETURN_HEAD],
    tab: "control:transport.continue",
    shift: "region:input",
    meta: { tab: "6 · Continue", shift: "4 · REPL input", trap: false },
  },
  {
    id: "12",
    title: "Historical inspection · reconstructed, read-only",
    key: "Enter on the selected checkpoint",
    url: "xmd://repl/e1/history/entry-1/document/plan?at=cp-04&inspect",
    head: "cp-18",
    focus: "control:transport.fork",
    fixture: "paused",
    overlay: true,
    targets: [
      ...REGIONS,
      {
        n: 6,
        id: "control:transport.continue",
        kind: "control",
        study: "Continue · disabled while inspecting",
      },
      RETURN_HEAD,
      FORK,
    ],
    tab: "region:sessions",
    shift: "control:transport.return-head",
    meta: { tab: "1 · Journal — the ring wraps", shift: "7 · Return to paused head", trap: false },
  },
  {
    id: "13",
    title: "Return to live execution",
    key: "Enter on Return to paused head, then Continue",
    url: "xmd://repl/e1/history/entry-1/document",
    head: "cp-19",
    focus: "control:transport.pause",
    fixture: "drawer",
    overlay: true,
    targets: [...REGIONS, PAUSE],
    tab: "region:sessions",
    shift: "region:history",
    meta: { tab: "1 · Sessions", shift: "5 · Execution History region", trap: false },
  },
  {
    id: "14",
    title: "Settled entry · REPL input ready for Entry 2",
    key: "no keypress — Entry 1 completes",
    url: "xmd://repl/e1/input?draft=%3CPlan%3E",
    head: "cp-22",
    focus: "region:input",
    fixture: "settled",
    overlay: true,
    targets: [
      ...REGIONS,
      { n: 6, id: "control:input.run", kind: "control", study: "Run · enabled again" },
    ],
    tab: "control:input.run",
    shift: "region:bindings",
    meta: { tab: "6 · Run", shift: "3 · Bindings", trap: false },
  },
];

export function frame(id: string): StudyFrame | undefined {
  return FRAMES.find((one) => one.id === id);
}

/**
 * One frame, as a state.
 *
 * The URL and the journal do all of the rebuilding. The frame then declares
 * where focus was, because focus is disposable and no URL claims to carry it —
 * which is exactly why the evidence has to check that the declared identity is
 * still a live target in the state the URL rebuilt.
 */
export function stateFor(subject: StudyFrame): ReplState {
  const state = hydrate(subject.url, journalThrough(subject.head));
  return { ...state, focus: subject.focus, overlay: subject.overlay };
}
