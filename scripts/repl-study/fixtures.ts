/**
 * The six moments the harness can show, taken from the approved study.
 *
 * Between them they carry every transcript and history trait #838 asks for:
 * nested visible scopes with lifecycle rails, collapsed completed work, prose
 * long enough to wrap, generated XMD replacing the expression that produced it,
 * concurrent session activity, an Elicit drawer, a paused head with a historical
 * selection, marker runs dense enough to collide, nesting deeper than the band's
 * rows, and a settled entry.
 *
 * The content is the study's own: the `Create a project README` program, its
 * `Plan` component, the three Agent sessions, and the twelve recorded
 * checkpoints of the Journal Time Travel animation.
 */

import type { Checkpoint, Drawer, Fixture, Session, TranscriptRow } from "./model.ts";
import { FIXTURE_NAMES } from "./model.ts";

const RETURNED_PROGRAM = [
  "# Create a project README",
  "",
  "Provide the project name and a one-sentence description.",
  "",
  '<Elicit as="project" schema={projectSchema}>',
  "  Enter the project details.",
  "</Elicit>",
  "",
  "This is the README that will be created:",
  "",
  '<CodeBlock value={readme} language="markdown" />',
];

const README = ["# Northstar", "", "A lightweight workspace for coordinating coding agents."];

const SESSIONS: readonly Session[] = [
  {
    id: "plan-a91f7c",
    agent: "planner",
    state: "completed",
    label: "✓ completed",
    turn: "turn 1 · returned 59 lines",
    selected: true,
  },
  {
    id: "review-b72e1d",
    agent: "reviewer",
    state: "active",
    label: "● responding",
    turn: "turn 1 · streaming",
    note: "streaming · background update · selection unchanged",
  },
  {
    id: "implement-c31d2e",
    agent: "implementer",
    state: "queued",
    label: "· queued",
    turn: "no turn yet",
  },
];

/**
 * The recorded timeline of the study's animation.
 *
 * Two of these share a second with a neighbour, and three sit deeper than the
 * band has rows for. Both are deliberate: a band that cannot show them has to
 * summarize rather than overprint, and the scrubber still has to reach them.
 */
const CHECKPOINTS: readonly Checkpoint[] = [
  {
    at: 2,
    kind: "entry",
    label: "Entry 1 submitted",
    scope: "REPL",
    depth: 0,
    records: ["repl.entry.submitted", "source.frozen 8 lines"],
  },
  {
    at: 5,
    kind: "event",
    label: "document scope entered",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["scope.enter document", "capability.granted write"],
  },
  {
    at: 12,
    kind: "event",
    label: "Plan entered",
    scope: "Entry 1 › document › Plan",
    depth: 2,
    records: ["scope.enter Plan", "inputs.bound content", "component.resolved Plan.md"],
  },
  {
    at: 18,
    kind: "event",
    label: "planning inputs prepared",
    scope: "… › Plan › PlanInputs",
    depth: 3,
    records: ["binding.published syntax", "binding.published inputs"],
  },
  {
    at: 29,
    kind: "event",
    label: "planning Agent response admitted",
    scope: "… › Plan › Prompt",
    depth: 3,
    records: ["agent.turn.admitted plan-a91f7c", "binding.published draft"],
  },
  {
    at: 30,
    kind: "event",
    label: "draft checked",
    scope: "… › Plan › Check",
    depth: 4,
    records: ["binding.published responseKind", "binding.published check"],
  },
  {
    at: 41,
    kind: "event",
    label: "review returned Approve",
    scope: "… › Plan › Elicit",
    depth: 3,
    records: ["elicit.answered review"],
  },
  {
    at: 47,
    kind: "event",
    label: "Plan replaced by returned program",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["node.replaced Plan → 59 lines", "scope.exit Plan"],
  },
  {
    at: 49,
    kind: "event",
    label: "project Elicit requested",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["elicit.requested project", "drawer.opened"],
  },
  {
    at: 52,
    kind: "event",
    label: "project Elicit answered",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["elicit.answered project", "binding.published project"],
  },
  {
    at: 53,
    kind: "event",
    label: "confirmation Elicit requested",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["elicit.requested confirmation"],
  },
  {
    at: 57,
    kind: "event",
    label: "README.md written",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["effect.file.write README.md", "63 bytes · +3 lines"],
  },
  {
    at: 60,
    kind: "event",
    label: "Evaluate exited",
    scope: "Entry 1 › document",
    depth: 1,
    records: ["scope.exit Evaluate", "teardown.complete"],
  },
  {
    at: 61,
    kind: "entry",
    label: "Entry 1 completed",
    scope: "REPL",
    depth: 0,
    records: ["repl.entry.completed", "bindings.published 0"],
  },
];

function upTo(seconds: number): readonly Checkpoint[] {
  return CHECKPOINTS.filter((checkpoint) => checkpoint.at <= seconds);
}

const NESTED_ROWS: readonly TranscriptRow[] = [
  {
    kind: "prose",
    text: "← opened from Entry 1 · live execution projection, not an editor",
    depth: 0,
    emphasis: "dim",
  },
  { kind: "prose", text: "document", depth: 0, emphasis: "title" },
  {
    kind: "prose",
    text: "repl:entry-1 · submitted source is immutable while running",
    depth: 0,
    emphasis: "dim",
  },
  {
    kind: "lifecycle",
    source: '<Evaluate allow={["write"]}>',
    depth: 0,
    phase: "enter",
    pair: "evaluate",
  },
  { kind: "prose", text: "Create a project README", depth: 1, emphasis: "title" },
  {
    kind: "prose",
    depth: 1,
    text: "Provide the project name and a one-sentence description. The Plan component drafts the program that asks for them, reviews its own draft, and returns it for admission into this document scope.",
  },
  {
    kind: "lifecycle",
    source: '<Plan as="draft" session={planner}>',
    depth: 1,
    phase: "active",
    pair: "plan",
  },
  { kind: "section", name: "Read the Prompt", published: "prompt", state: "collapsed", depth: 2 },
  {
    kind: "section",
    name: "Prepare the planning inputs",
    published: "syntax, inputs",
    state: "collapsed",
    depth: 2,
  },
  {
    kind: "section",
    name: "Create the first draft",
    published: "draft",
    state: "collapsed",
    depth: 2,
  },
  {
    kind: "section",
    name: "Check the draft",
    published: "responseKind, check",
    state: "expanded",
    depth: 2,
  },
  { kind: "lifecycle", source: '<Let as="check">', depth: 3, phase: "active", pair: "check" },
  {
    kind: "lifecycle",
    source: "  <Classify value={draft} schema={checkSchema} />",
    depth: 4,
    phase: "settled",
  },
  {
    kind: "lifecycle",
    source: '<Agent.Ask session={reviewer} as="review">',
    depth: 3,
    phase: "waiting",
    pair: "ask",
  },
  {
    kind: "prose",
    text: "Review the generated Plan and choose Approve, Request changes or Stop.",
    depth: 4,
  },
  {
    kind: "prose",
    depth: 4,
    text: "The reviewer has the draft, the schema it was checked against, and the capabilities the document would be granted if the Plan is admitted. Nothing it returns runs until this scope admits it.",
  },
  { kind: "lifecycle", source: '<Syntax as="syntax" />', depth: 4, phase: "settled" },
  {
    kind: "lifecycle",
    source: '<PlanInputs session={props.session} as="inputs" />',
    depth: 4,
    phase: "settled",
  },
  {
    kind: "lifecycle",
    source: "</Agent.Ask>",
    depth: 3,
    phase: "waiting",
    pair: "ask",
    close: true,
  },
  { kind: "lifecycle", source: "</Let>", depth: 3, phase: "active", pair: "check", close: true },
  { kind: "section", name: "Review the draft", published: "review", state: "collapsed", depth: 2 },
  {
    kind: "section",
    name: "Admit the approved Plan",
    published: "admitted",
    state: "collapsed",
    depth: 2,
  },
];

const GENERATED_ROWS: readonly TranscriptRow[] = [
  {
    kind: "prose",
    text: "← opened from Entry 1 · live execution projection, not an editor",
    depth: 0,
    emphasis: "dim",
  },
  { kind: "prose", text: "document", depth: 0, emphasis: "title" },
  {
    kind: "lifecycle",
    source: '<Evaluate allow={["write"]}>',
    depth: 0,
    phase: "enter",
    pair: "evaluate",
  },
  { kind: "prose", text: "Create a project README", depth: 1, emphasis: "title" },
  {
    kind: "lifecycle",
    source: '<Plan as="draft" session={planner}>',
    depth: 1,
    phase: "exit",
    pair: "plan",
  },
  {
    kind: "section",
    name: "Admit the approved Plan",
    published: "admitted",
    state: "collapsed",
    depth: 2,
  },
  { kind: "lifecycle", source: "</Plan>", depth: 1, phase: "exit", pair: "plan", close: true },
  {
    kind: "fence",
    label: "XMD",
    lines: RETURNED_PROGRAM,
    caption: "returned program · 59 lines · replaces the Plan expression, then evaluates here",
    depth: 1,
  },
  { kind: "prose", text: "Create a project README", depth: 1, emphasis: "title" },
  { kind: "prose", text: "Provide the project name and a one-sentence description.", depth: 1 },
  {
    kind: "lifecycle",
    source: '<Elicit as="project" schema={projectSchema}>',
    depth: 1,
    phase: "enter",
    pair: "elicit",
  },
  { kind: "prose", text: "Enter the project details.", depth: 2 },
  { kind: "lifecycle", source: "</Elicit>", depth: 1, phase: "enter", pair: "elicit", close: true },
];

const DRAWER_ROWS: readonly TranscriptRow[] = [
  {
    kind: "prose",
    text: "← opened from Entry 1 · live execution projection, not an editor",
    depth: 0,
    emphasis: "dim",
  },
  { kind: "prose", text: "document", depth: 0, emphasis: "title" },
  {
    kind: "lifecycle",
    source: '<Evaluate allow={["write"]}>',
    depth: 0,
    phase: "enter",
    pair: "evaluate",
  },
  {
    kind: "section",
    name: "Ask for the project details",
    published: "project",
    state: "expanded",
    depth: 1,
  },
  {
    kind: "lifecycle",
    source: '<Elicit as="project" schema={projectSchema}>',
    depth: 1,
    phase: "waiting",
    pair: "elicit",
  },
  { kind: "prose", text: "Enter the project details.", depth: 2 },
  {
    kind: "lifecycle",
    source: "</Elicit>",
    depth: 1,
    phase: "waiting",
    pair: "elicit",
    close: true,
  },
  { kind: "prose", text: "▲ suspended · answer in the drawer below", depth: 1, emphasis: "strong" },
];

const INSPECTED_ROWS: readonly TranscriptRow[] = [
  {
    kind: "prose",
    text: "reconstructed from the journal · no live action is possible here",
    depth: 0,
    emphasis: "dim",
  },
  { kind: "prose", text: "Plan", depth: 0, emphasis: "title" },
  {
    kind: "lifecycle",
    source: '<Plan as="draft" session={planner}>',
    depth: 0,
    phase: "active",
    pair: "plan",
  },
  { kind: "section", name: "Read the Prompt", published: "prompt", state: "collapsed", depth: 1 },
  {
    kind: "section",
    name: "Prepare the planning inputs",
    published: "syntax, inputs",
    state: "expanded",
    depth: 1,
  },
  { kind: "lifecycle", source: '<Syntax as="syntax" />', depth: 2, phase: "settled" },
  {
    kind: "lifecycle",
    source: '<PlanInputs session={props.session} as="inputs" />',
    depth: 2,
    phase: "active",
  },
  {
    kind: "prose",
    text: "XMD catalog · 47 symbols · component, control, agent, io",
    depth: 2,
    emphasis: "dim",
  },
];

const SETTLED_ROWS: readonly TranscriptRow[] = [
  { kind: "prose", text: "Create a project README", depth: 0, emphasis: "title" },
  { kind: "prose", text: "Provide the project name and a one-sentence description.", depth: 0 },
  {
    kind: "fence",
    label: "MARKDOWN",
    lines: README,
    depth: 0,
    caption: "README.md · 63 bytes · +3 lines",
  },
  { kind: "prose", text: "README.md was created for Northstar.", depth: 0, emphasis: "strong" },
  { kind: "prose", text: "no REPL bindings published · 1 file written", depth: 0, emphasis: "dim" },
];

/** The three suspensions the approved story opens. */
export const DRAWER_KINDS = ["project", "review", "confirm"] as const;

export type DrawerKind = (typeof DRAWER_KINDS)[number];

export function isDrawerKind(value: string): value is DrawerKind {
  return (DRAWER_KINDS as readonly string[]).includes(value);
}

/**
 * The three drawers, keyed by the name a route opens them with.
 *
 * `model.ts` has carried all three shapes since #838, but only the project form
 * had content. Study frames 08 and 09 are the other two, and a drawer a route
 * can name has to be a drawer the harness can draw.
 */
const DRAWERS: Record<DrawerKind, Drawer> = {
  project: {
    kind: "project",
    heading: "INPUT REQUIRED",
    origin:
      'suspended at <Elicit as="project"> \u00b7 document scope \u00b7 validated against the Elicit schema',
    prompt: "Enter the project details.",
    fields: [
      { label: "Project name", value: "Northstar" },
      { label: "Description", value: "A lightweight workspace for coordinating coding agents." },
    ],
    schema: ["{", "  name: string (required),", "  description: string (required)", "}"],
    validation: "both fields valid",
    submit: "Submit  \u2318\u21b5",
  },
  review: {
    kind: "review",
    heading: "REVIEW REQUIRED",
    origin: 'suspended at <Elicit as="review"> \u00b7 Plan scope \u00b7 59 lines returned',
    plan: RETURNED_PROGRAM.slice(0, 6),
    more: "\u25b8 53 more lines \u00b7 \u2325\u2193 scrolls the Plan",
    decisions: [
      { label: "Approve", chosen: true },
      { label: "Request changes", chosen: false, note: "adds a required feedback field" },
      { label: "Stop", chosen: false },
    ],
    submit: "Submit  \u2318\u21b5",
  },
  confirm: {
    kind: "confirm",
    heading: "CONFIRMATION REQUIRED",
    origin: 'suspended at <Elicit as="confirmation"> \u00b7 document scope',
    prompt: "Create README.md with the content shown above?",
    preview: README,
    actions: [
      { label: "Approve", primary: true },
      { label: "Decline", primary: false },
    ],
    hint: "\u2318\u21b5 approves \u00b7 Esc closes the drawer without answering it",
  },
};

export function drawerOf(kind: DrawerKind): Drawer {
  return DRAWERS[kind];
}

const FIXTURES: Record<string, Fixture> = {
  empty: {
    name: "empty",
    moment: "a fresh REPL, before anything has run",
    crumb: "REPL",
    sidebar: {
      tab: "sessions",
      heading: "No sessions yet",
      placeholder: [
        "Agent sessions appear here as executions open them.",
        "They persist after an entry settles.",
      ],
    },
    sessions: [],
    bindings: {
      scopeName: "REPL scope",
      bindings: [],
      placeholder: [
        "No REPL bindings yet",
        "Values named with as appear here for the active scope.",
      ],
    },
    input: {
      label: "REPL INPUT",
      hint: "⇧⏎ newline",
      placeholder: "Enter XMD or invoke a document…",
      runEnabled: true,
    },
    history: { elapsed: "00:00", headAt: 0, checkpoints: [], transport: "idle" },
  },

  nested: {
    name: "nested",
    moment: "Plan running inside the document scope, three sections settled",
    crumb: "REPL › Entry 1 › document › Plan · active",
    sidebar: {
      tab: "sessions",
      heading: "SESSIONS · 1",
      subheading: "chronological · selection follows you, not activity",
    },
    entry: {
      id: "Entry 1",
      title: "Create a project README",
      state: "running",
      elapsed: "31.4",
      sourceLines: 8,
      scopeNote: "↳ Plan scope open",
      rows: NESTED_ROWS,
    },
    sessions: SESSIONS.slice(0, 1),
    bindings: {
      scopeName: "Plan scope",
      bindings: [
        {
          name: "prompt",
          lines: ['"Create an XMD program that asks me for a', 'project name and a description…"'],
        },
        {
          name: "syntax",
          note: "prose",
          lines: ["XMD catalog · 47 symbols", "component, control, agent, io"],
        },
        {
          name: "inputs",
          note: "json",
          lines: ["{", '  surface: "component",', '  session: "plan-a91f7c",', "  budget: 3", "}"],
        },
        {
          name: "draft",
          note: "XMD source · 59 lines",
          lines: ["# Create a project README", '<Elicit as="project" schema={…}>'],
        },
      ],
    },
    input: {
      label: "DRAFT · ENTRY 2",
      hint: "Run unavailable while Entry 1 is active",
      runEnabled: false,
    },
    history: {
      elapsed: "00:31",
      headAt: 31,
      checkpoints: upTo(31),
      transport: "live",
    },
  },

  generated: {
    name: "generated",
    moment: "the Plan's returned program replacing the expression that produced it",
    crumb: "REPL › Entry 1 › document · active",
    sidebar: {
      tab: "sessions",
      heading: "SESSIONS · 2",
      subheading: "chronological · selection follows you, not activity",
    },
    entry: {
      id: "Entry 1",
      title: "Create a project README",
      state: "running",
      elapsed: "48.1",
      sourceLines: 8,
      scopeNote: "↳ document scope open",
      rows: GENERATED_ROWS,
    },
    sessions: SESSIONS.slice(0, 2),
    bindings: {
      scopeName: "document scope",
      bindings: [
        {
          name: "admitted",
          note: "XMD source · 59 lines · sealed",
          lines: ["# Create a project README"],
        },
      ],
    },
    input: {
      label: "DRAFT · ENTRY 2",
      hint: "Run unavailable while Entry 1 is active",
      runEnabled: false,
    },
    history: {
      elapsed: "00:48",
      headAt: 48,
      checkpoints: upTo(48),
      transport: "live",
      compressed: { at: 35, note: "4.9s agent wait · compressed" },
    },
  },

  drawer: {
    name: "drawer",
    moment: "suspended at the project Elicit while three sessions are in flight",
    crumb: "REPL › Entry 1 › document · suspended",
    sidebar: {
      tab: "sessions",
      heading: "SESSIONS · 3",
      subheading: "chronological · selection follows you, not activity",
    },
    entry: {
      id: "Entry 1",
      title: "Create a project README",
      state: "running",
      elapsed: "48.9",
      sourceLines: 8,
      scopeNote: "↳ document scope suspended",
      rows: DRAWER_ROWS,
    },
    sessions: SESSIONS,
    bindings: {
      scopeName: "document scope",
      bindings: [{ name: "readme", note: "markdown · 3 lines", lines: ["# Northstar"] }],
    },
    drawer: DRAWERS.project,
    input: {
      label: "DRAFT · ENTRY 2",
      hint: "Run unavailable while Entry 1 is active",
      runEnabled: false,
    },
    history: {
      elapsed: "00:49",
      headAt: 49,
      checkpoints: upTo(49),
      transport: "live",
      compressed: { at: 35, note: "4.9s agent wait · compressed" },
    },
  },

  paused: {
    name: "paused",
    moment: "paused at the head, inspecting the recorded Plan scope",
    crumb: "REPL › Entry 1 › document › Plan",
    badge: "RECONSTRUCTED AT 00:12 · READ-ONLY",
    readOnly: true,
    sidebar: {
      tab: "journal",
      heading: "ENTRY 1 · CREATE PROJECT README",
      subheading: "inspecting recorded history · read-only",
    },
    entry: {
      id: "Entry 1",
      title: "Create a project README",
      state: "running",
      elapsed: "53.0",
      sourceLines: 8,
      scopeNote: "↳ reconstructed · read-only",
      rows: INSPECTED_ROWS,
    },
    sessions: SESSIONS,
    bindings: {
      scopeName: "Plan scope · as recorded",
      bindings: [{ name: "prompt", lines: ['"Create an XMD program that asks…"'] }],
    },
    input: {
      label: "DRAFT · ENTRY 2",
      hint: "suspended · inspecting recorded history",
      runEnabled: false,
    },
    history: {
      elapsed: "00:53",
      headAt: 53,
      selectedAt: 12,
      checkpoints: upTo(53),
      transport: "inspecting",
      compressed: { at: 35, note: "4.9s agent wait · compressed" },
    },
  },

  settled: {
    name: "settled",
    moment: "Entry 1 settled, the input ready for Entry 2",
    crumb: "REPL · Entry 1 settled",
    sidebar: { tab: "sessions", heading: "SESSIONS · 3", subheading: "persist after settling" },
    entry: {
      id: "Entry 1",
      title: "Create a project README",
      state: "completed",
      elapsed: "41.2",
      sourceLines: 8,
      scopeNote: "▸ source · 8 lines",
      rows: SETTLED_ROWS,
    },
    sessions: SESSIONS,
    bindings: {
      scopeName: "REPL scope",
      bindings: [],
      placeholder: [
        "Entry 1 published none",
        "Values named with as appear here for the active scope.",
      ],
    },
    input: {
      label: "REPL INPUT",
      hint: "ready for Entry 2",
      placeholder: "Enter XMD or invoke a document…",
      runEnabled: true,
    },
    history: {
      elapsed: "01:01",
      headAt: 61,
      checkpoints: CHECKPOINTS,
      transport: "idle",
      compressed: { at: 35, note: "4.9s agent wait · compressed" },
    },
  },
};

export function fixture(name: string): Fixture {
  const found = FIXTURES[name];
  if (!found) {
    throw new Error(`no such fixture: ${name}`);
  }
  return found;
}

export function fixtures(): readonly Fixture[] {
  return FIXTURE_NAMES.map((name) => fixture(name));
}
