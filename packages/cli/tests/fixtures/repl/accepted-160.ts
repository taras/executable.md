/**
 * The accepted 160x36 screen, as literal expectations.
 *
 * Transcribed from the capture the Product Owner accepted — attempt 4 of the
 * #971 checkpoint, at revision c5626b3bc306fea4c19fbeae36494abe8fa5317e — and
 * from nothing else. Every number here is what that screen actually drew, so a
 * test comparing against it is comparing against the reviewed appearance rather
 * than against the constants that produced it: a palette or geometry change
 * that moves the screen fails here even though production agrees with itself.
 *
 * Coordinates are zero-based cells; widths and heights are whole cells.
 * Colours are 24-bit, as the renderer reports them back.
 */

/** One rectangle of the accepted screen. */
export interface AcceptedBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One cell of the accepted screen, with what it was drawn in. */
export interface AcceptedCell {
  readonly x: number;
  readonly y: number;
  readonly c: string;
  readonly fg: number | null;
  readonly bg: number | null;
  readonly attrs: readonly number[];
}

/** What the accepted screen is, by the parts a test can compare. */
export interface AcceptedScreen {
  readonly revision: string;
  readonly attempt: number;
  readonly size: { readonly columns: number; readonly rows: number };
  readonly regions: readonly {
    readonly region: string;
    readonly id: string;
    readonly bounds: AcceptedBounds;
  }[];
  readonly named: readonly { readonly id: string; readonly bounds: AcceptedBounds }[];
  readonly contents: readonly {
    readonly region: string;
    readonly id: string;
    readonly kind: string;
    readonly bounds: AcceptedBounds;
  }[];
  readonly targets: readonly { readonly key: string; readonly bounds: AcceptedBounds }[];
  readonly focus: string;
  readonly ancestry: {
    readonly scopes: readonly string[];
    readonly ancestry: readonly {
      readonly key: string;
      readonly kind: string;
      readonly name: string;
    }[];
    readonly scope: { readonly key: string; readonly kind: string; readonly name: string };
    readonly entries: readonly { readonly key: string; readonly order: number }[];
  };
  readonly cellProbes: readonly AcceptedCell[];
  readonly textRows: readonly { readonly y: number; readonly text: string }[];
}

export const ACCEPTED_160 = Object.freeze({
  revision: "c5626b3bc306fea4c19fbeae36494abe8fa5317e",
  attempt: 4,
  size: {
    columns: 160,
    rows: 36,
  },
  regions: [
    {
      region: "sidebar",
      id: "box:sidebar",
      bounds: {
        x: 0,
        y: 1,
        width: 36,
        height: 33,
      },
    },
    {
      region: "transcript",
      id: "box:transcript",
      bounds: {
        x: 36,
        y: 1,
        width: 66,
        height: 33,
      },
    },
    {
      region: "inspection",
      id: "box:inspection",
      bounds: {
        x: 102,
        y: 1,
        width: 58,
        height: 33,
      },
    },
    {
      region: "footer",
      id: "box:footer",
      bounds: {
        x: 0,
        y: 34,
        width: 160,
        height: 2,
      },
    },
  ],
  named: [
    {
      id: "box:identity",
      bounds: {
        x: 0,
        y: 0,
        width: 160,
        height: 1,
      },
    },
    {
      id: "box:body",
      bounds: {
        x: 0,
        y: 1,
        width: 160,
        height: 33,
      },
    },
    {
      id: "box:footer",
      bounds: {
        x: 0,
        y: 34,
        width: 160,
        height: 2,
      },
    },
    {
      id: "box:history",
      bounds: {
        x: 0,
        y: 34,
        width: 160,
        height: 1,
      },
    },
    {
      id: "box:guidance",
      bounds: {
        x: 0,
        y: 35,
        width: 160,
        height: 1,
      },
    },
    {
      id: "box:draft",
      bounds: {
        x: 37,
        y: 30,
        width: 65,
        height: 4,
      },
    },
    {
      id: "box:tray",
      bounds: {
        x: 103,
        y: 24,
        width: 57,
        height: 10,
      },
    },
    {
      id: "box:transcript:header",
      bounds: {
        x: 37,
        y: 1,
        width: 65,
        height: 1,
      },
    },
    {
      id: "box:sidebar:header",
      bounds: {
        x: 0,
        y: 1,
        width: 36,
        height: 1,
      },
    },
    {
      id: "box:inspection:tabs",
      bounds: {
        x: 103,
        y: 1,
        width: 57,
        height: 1,
      },
    },
  ],
  contents: [
    {
      region: "sidebar",
      id: "box:sidebar:body",
      kind: "body",
      bounds: {
        x: 1,
        y: 3,
        width: 34,
        height: 31,
      },
    },
    {
      region: "transcript",
      id: "box:transcript:content",
      kind: "pane",
      bounds: {
        x: 37,
        y: 1,
        width: 65,
        height: 33,
      },
    },
    {
      region: "transcript",
      id: "box:transcript:body",
      kind: "body",
      bounds: {
        x: 39,
        y: 3,
        width: 61,
        height: 27,
      },
    },
    {
      region: "inspection",
      id: "box:inspection:content",
      kind: "pane",
      bounds: {
        x: 103,
        y: 1,
        width: 57,
        height: 33,
      },
    },
    {
      region: "inspection",
      id: "box:inspection:body",
      kind: "body",
      bounds: {
        x: 104,
        y: 3,
        width: 55,
        height: 21,
      },
    },
    {
      region: "inspection",
      // The accepted capture had this at height 2: the queue drew one box per
      // queued message, however many rows that message's text took. The window
      // now admits and slices *rows*, so the body this identity marks is the
      // one row it begins on and the rest of that message are its siblings.
      // That is the only figure in this fixture that moved, and it moved from
      // the structure rather than the screen: every pinned row and every
      // styled cell probe below still reads exactly as it was captured, this
      // box's x, y and width included.
      id: "box:queue:text:0",
      kind: "body",
      bounds: {
        x: 104,
        y: 25,
        width: 51,
        height: 1,
      },
    },
  ],
  targets: [
    {
      key: "entries:heading",
      bounds: {
        x: 38,
        y: 1,
        width: 9,
        height: 1,
      },
    },
    {
      key: "footer:input",
      bounds: {
        x: 39,
        y: 30,
        width: 52,
        height: 1,
      },
    },
    {
      key: "draft:stop",
      bounds: {
        x: 92,
        y: 30,
        width: 8,
        height: 1,
      },
    },
    {
      key: "sidekick:configure",
      bounds: {
        x: 139,
        y: 1,
        width: 20,
        height: 1,
      },
    },
    {
      key: "tray:todo",
      bounds: {
        x: 104,
        y: 24,
        width: 6,
        height: 1,
      },
    },
    {
      key: "tray:queue",
      bounds: {
        x: 112,
        y: 24,
        width: 7,
        height: 1,
      },
    },
    {
      key: "follow",
      bounds: {
        x: 137,
        y: 24,
        width: 12,
        height: 1,
      },
    },
    {
      key: "sidekick:stop",
      bounds: {
        x: 151,
        y: 24,
        width: 8,
        height: 1,
      },
    },
    {
      key: "queue:q1:remove",
      bounds: {
        x: 156,
        y: 25,
        width: 3,
        height: 1,
      },
    },
    {
      key: "queue:q2:remove",
      bounds: {
        x: 156,
        y: 27,
        width: 3,
        height: 1,
      },
    },
    {
      key: "queue:q3:remove",
      bounds: {
        x: 156,
        y: 30,
        width: 3,
        height: 1,
      },
    },
    {
      key: "sidekick:message",
      bounds: {
        x: 104,
        y: 32,
        width: 55,
        height: 1,
      },
    },
    {
      key: "footer:history",
      bounds: {
        x: 97,
        y: 34,
        width: 11,
        height: 1,
      },
    },
    {
      key: "footer:exit",
      bounds: {
        x: 109,
        y: 34,
        width: 8,
        height: 1,
      },
    },
    {
      key: "footer:pause",
      bounds: {
        x: 118,
        y: 34,
        width: 9,
        height: 1,
      },
    },
  ],
  focus: "footer:input",
  ancestry: {
    scopes: ["entry-2", "Checklist-1"],
    ancestry: [
      {
        key: "entry-2",
        kind: "entry",
        name: "entry-2",
      },
      {
        key: "Checklist-1",
        kind: "component",
        name: "Checklist",
      },
    ],
    scope: {
      key: "Checklist-1",
      kind: "component",
      name: "Checklist",
    },
    entries: [
      {
        key: "entry-1",
        order: 1,
      },
      {
        key: "entry-2",
        order: 2,
      },
    ],
  },
  cellProbes: [
    {
      x: 1,
      y: 0,
      c: "X",
      fg: 15133937,
      bg: 1120027,
      attrs: [],
    },
    {
      x: 1,
      y: 1,
      c: "T",
      fg: 13623530,
      bg: 922133,
      attrs: [1],
    },
    {
      x: 1,
      y: 2,
      c: " ",
      fg: null,
      bg: 790548,
      attrs: [],
    },
    {
      x: 36,
      y: 1,
      c: "│",
      fg: 1844523,
      bg: 724239,
      attrs: [],
    },
    {
      x: 102,
      y: 1,
      c: "│",
      fg: 1844523,
      bg: 658446,
      attrs: [],
    },
    {
      x: 104,
      y: 2,
      c: " ",
      fg: null,
      bg: 658446,
      attrs: [],
    },
    {
      x: 38,
      y: 30,
      c: " ",
      fg: null,
      bg: 658703,
      attrs: [],
    },
    {
      x: 39,
      y: 30,
      c: ">",
      fg: 9147804,
      bg: 658703,
      attrs: [1],
    },
    {
      x: 39,
      y: 31,
      c: "<",
      fg: 5147548,
      bg: 658703,
      attrs: [],
    },
    {
      x: 39,
      y: 32,
      c: " ",
      fg: null,
      bg: 658703,
      attrs: [],
    },
    {
      x: 1,
      y: 34,
      c: "H",
      fg: 9147804,
      bg: 526603,
      attrs: [],
    },
    {
      x: 1,
      y: 35,
      c: "E",
      fg: 13161177,
      bg: 1120027,
      attrs: [],
    },
    {
      x: 104,
      y: 24,
      c: " ",
      fg: 8095117,
      bg: 856597,
      attrs: [],
    },
    {
      x: 104,
      y: 25,
      c: "[",
      fg: 14805485,
      bg: 856597,
      attrs: [],
    },
    {
      x: 105,
      y: 7,
      c: "S",
      fg: 9293550,
      bg: 658446,
      attrs: [],
    },
    {
      x: 105,
      y: 14,
      c: "C",
      fg: 13940459,
      bg: 658446,
      attrs: [],
    },
    {
      x: 105,
      y: 20,
      c: "R",
      fg: 10474409,
      bg: 658446,
      attrs: [],
    },
    {
      x: 95,
      y: 1,
      c: "A",
      fg: 8377320,
      bg: 922133,
      attrs: [],
    },
    {
      x: 119,
      y: 1,
      c: "I",
      fg: 13623530,
      bg: 922133,
      attrs: [1],
    },
    {
      x: 21,
      y: 1,
      c: "A",
      fg: 9147804,
      bg: 922133,
      attrs: [1],
    },
    {
      x: 43,
      y: 15,
      c: "C",
      fg: 8377320,
      bg: 724239,
      attrs: [],
    },
    {
      x: 55,
      y: 15,
      c: "t",
      fg: 9414584,
      bg: 724239,
      attrs: [],
    },
    {
      x: 65,
      y: 15,
      c: "o",
      fg: 14070903,
      bg: 724239,
      attrs: [],
    },
    {
      x: 50,
      y: 16,
      c: "}",
      fg: 10194640,
      bg: 724239,
      attrs: [],
    },
  ],
  textRows: [
    {
      y: 1,
      text: " TRANSCRIPT          All sessions ▾ │   Entries › Entry 2 › Checklist                        ● ACTIVE │   BINDINGS    SIDEKICK               [configure claude] ",
    },
    {
      y: 2,
      text: "                                    │                                                                 │                                                         ",
    },
    {
      y: 5,
      text: "   codex · sess-architect-7f2c      │  │  Reading checkout.md and                                     │     fix it?                                             ",
    },
    {
      y: 6,
      text: "   [A] Review checkout… · streaming │  │  architecture.md                                             │                                                         ",
    },
    {
      y: 8,
      text: "   Sidekick                         │  │  # Review the checkout total                                 │     total, so I computed it in checkout.md.             ",
    },
    {
      y: 9,
      text: "   claude · chat · sess-sidekick-4… │  │                                                              │                                                         ",
    },
    {
      y: 13,
      text: "   [S] I started the Architect rev… │  │  ```                                                         │                                                         ",
    },
    {
      y: 15,
      text: '                                    │  │  <Checklist title="Checkout total"                           │     merge.                                              ',
    },
    {
      y: 16,
      text: "                                    │  │  steps={3} />                                                │                                                         ",
    },
    {
      y: 18,
      text: "                                    │  │  Compute the total once,    after the                        │     it asks for.                                        ",
    },
    {
      y: 19,
      text: "                                    │  │  items are summed, so that checkout.md                       │                                                         ",
    },
    {
      y: 20,
      text: "                                    │  │  and cart.md can never disagree about                        │ [R] Entry 2 · ● ACTIVE                                  ",
    },
    {
      y: 21,
      text: "                                    │  │  what the customer pays.                                     │                                                         ",
    },
    {
      y: 24,
      text: "                                    │                                                                 │   TODO    QUEUE                    [x] Follow    [stop] ",
    },
    {
      y: 25,
      text: "                                    │                                                                 │ [U] When that finishes, explain the requested         X ",
    },
    {
      y: 26,
      text: "                                    │                                                                 │     changes.                                            ",
    },
    {
      y: 27,
      text: "                                    │                                                                 │ [C] Post the Architect's requested changes as a       X ",
    },
    {
      y: 28,
      text: "                                    │                                                                 │     review comment on PR #212, quoting each one in      ",
    },
    {
      y: 29,
      text: "                                    │      [↓ later]                                                  │     full.                                               ",
    },
    {
      y: 30,
      text: "                                    │  > DRAFT                                                [stop]  │ [U] Then put a fix for the empty-cart case in the     X ",
    },
    {
      y: 31,
      text: "                                    │  <Checkout cart={cart} />                                       │     draft.                                              ",
    },
    {
      y: 32,
      text: "                                    │                                                                 │   › message the sidekick                                ",
    },
    {
      y: 33,
      text: '     [↓ later]                      │  <PriceSummary items={cart.items} currency="USD" />             │ Also say what an empty cart renders.                    ',
    },
    {
      y: 34,
      text: " HISTORY  1 ✓  2 ●  ── HEAD · LIVE                                                                 [history]   [exit]   [pause]                                 ",
    },
    {
      y: 35,
      text: " Entry 2 running · Enter unavailable until it finishes · Type here · Tab/Shift+Tab move                                                                         ",
    },
  ],
}) satisfies AcceptedScreen;
