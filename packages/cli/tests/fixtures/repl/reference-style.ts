/**
 * The colours the accepted presentation is stated in, independent of the
 * product that draws them.
 *
 * Every value here is a literal transcribed from the corrected Terminal
 * Interface archive — SHA-256
 * `86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`, the same
 * bytes kept at `.reviewer/issue-881/evidence/reference.zip` — out of the `S`,
 * `C` and `Y` constants its `xmd-repl-timetravel.jsx` and
 * `xmd-repl-agent-sessions.jsx` declare. The extract those were read from is
 * `.reviewer/issue-881/evidence/reference-style-extract.txt`, and the names
 * below are the archive's own.
 *
 * Nothing here reads the product. A test that asked `REPL_PALETTE` what colour
 * a delimiter is would agree with the product however the product drifted, and
 * the one thing these regressions exist to catch is the product drifting away
 * from this archive. So the two sides are stated separately and compared in the
 * cells a frame actually wrote.
 */

/** The archive these literals were transcribed from. */
export const REFERENCE_ARCHIVE = Object.freeze({
  sha256: "86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b",
  sources: Object.freeze(["xmd-repl-timetravel.jsx", "xmd-repl-agent-sessions.jsx"]),
  extract: ".reviewer/issue-881/evidence/reference-style-extract.txt",
});

/** The archive's `S`: what each area of the screen is painted with. */
export const SURFACE = Object.freeze({
  /** `app` — whatever no pane, drawer or footer row of its own covers. */
  app: 0x0b0d0f,
  /** `side` — the Sessions and catalog column. */
  side: 0x090b0c,
  /** `center` — the transcript, and the one routed outlet a narrow frame has. */
  center: 0x0c0e11,
  /** `bind` — the bindings and recorded-answer column. */
  bind: 0x0a0c0e,
  /** `drawer` — the whole rectangle a drawer covers the body with. */
  drawer: 0x0e1316,
  /** `input` — the single-row draft, and anything else a keystroke reaches. */
  input: 0x0a0d0f,
  /** `edge` — what parts one pane from the next. */
  edge: 0x161c21,
  /** `field` — a value being edited. */
  field: 0x090c0e,
});

/** The archive's `C`: what a reading means, rather than what it is made of. */
export const SEMANTIC = Object.freeze({
  /** `src` — document text and ordinary prose. */
  src: 0xc8d2d9,
  /** `active` — where the next keystroke lands. */
  active: 0x7fd3e8,
  /** `tick` — something that closed `ok`. */
  tick: 0x5aa87c,
  /** `hold` — something nobody has answered yet. */
  hold: 0xc99a3f,
  /** `intro` — a heading, a drawer's title, something you activate. */
  intro: 0xcfe0ea,
  /** `out` — what a run produced, and a value that has been entered. */
  out: 0xe6ecf1,
  /** `label` — what a field is called. */
  label: 0x8b959c,
  /** `dim` — a hint, and the metadata around a result. */
  dim: 0x7b858d,
  /** `exit` — a refusal, and something that closed `err`. */
  exit: 0xc2766e,
});

/** The archive's `Y`: what the characters of a source or a value *are*. */
export const SYNTAX = Object.freeze({
  /** `del` — the characters that open and close a tag. */
  del: 0x4e8b9c,
  /** `tag` — what a tag is called. */
  tag: 0x7fd3e8,
  /** `attr` — what an attribute is called. */
  attr: 0x8fa7b8,
  /** `str` — a quoted attribute value, its quotes included. */
  str: 0xd6b477,
  /** `brace` — the braces around a reference. */
  brace: 0x9b8ed0,
  /** `ref` — what a reference names. */
  ref: 0xb7aee0,
  /** `num` — a JSON number. */
  num: 0xd69a6a,
  /** `head` — a heading written in the source being shown. */
  head: 0xc7c4e6,
  /** `prose` — source with no stronger reading. */
  prose: 0xc8d2d9,
  /** `punct` — characters that join a reading rather than say anything. */
  punct: 0x7c868d,
  /** `key` — a JSON key. */
  key: 0x8fa7b8,
  /** `jstr` — a JSON string, its quotes included. */
  jstr: 0x9ec49a,
  /** `bool` — a JSON boolean. */
  bool: 0x9b8ed0,
  /** `nul` — the one JSON value that is an absence. */
  nul: 0x8b959c,
});

/**
 * The two cues this terminal keeps that the archive states differently.
 *
 * The archive marks a selected row and a focused one with a badge, a variable
 * font size and an animation, none of which a terminal has. The accepted
 * presentation retains this product's own `*` cue and row surface instead, and
 * names the value: these are the retained terminal adaptations, stated here so
 * a regression asserting one is not reading it back off the product either.
 */
export const RETAINED = Object.freeze({
  /** Behind a selected row, for the whole width the frame measured it at. */
  selectedSurface: 0x122026,
});

/** Bold, as the installed engine reports an attribute parameter back. */
export const REFERENCE_BOLD = 1;
