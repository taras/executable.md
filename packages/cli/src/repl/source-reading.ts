/**
 * One entry, as the thing a reader came to look at: what it produced, and the
 * source that produced it with what each part of it is doing.
 *
 * Private to this REPL. It takes a frozen model entry, whatever the session's
 * lifecycle reading currently says, and the live output of a run still going,
 * and answers one immutable list of logical lines. It measures nothing, draws
 * nothing and reads no context: a description asks it what to show and the
 * frame decides how wide that is.
 *
 * ## Output first, then source
 *
 * A reader opens an entry to see what it came to. The source is why it came to
 * that, and it is long — so the result is above it and both share one window,
 * which is what makes scrolling down from an answer into the reason for it one
 * movement rather than two panes to reconcile.
 *
 * ## Static syntax is not execution
 *
 * `inspectSource` says where the executable elements of a text are written. It
 * says nothing about whether any of them ran: a retained prefix shows the same
 * elements it always showed, and a cold process reconstructs no phase at all.
 * So an element acquires a phase only from an observation actually attributed
 * to it — matched on this entry, its lineage and its recorded source position —
 * and source nothing was observed in gets the rail that means *nothing was
 * observed here*, never a borrowed one.
 *
 * ## Generated source replaces, and keeps its own offsets
 *
 * An `<Evaluate>` that admitted a generated fragment shows that fragment where
 * its producer was written, because the producer is an implementation detail of
 * text the reader is being asked to read. The enclosure bytes stay exactly as
 * authored and only what they enclose is substituted, so the opening and
 * closing tags a reader sees are the ones in their file.
 *
 * The fragment is a *child region* rather than a splice: its offsets index its
 * own text, which is the only space its own recorded positions were ever
 * counted in. Splicing would renumber them and attribute its elements to the
 * wrong bytes of somebody else's file.
 */

import { inspectSource } from "@executablemd/core";
import type { SourceElement } from "@executablemd/core";
import type { ReplEntry, ReplGenerated, ReplScope } from "./model.ts";
import type { ReplLifecycleReading, ReplOccurrence } from "./lifecycle.ts";
import { styleOf } from "./presentation-style.ts";
import type { ReplPresentationRole, ReplRowStyle } from "./presentation-style.ts";
import { tokenRuns } from "./description.ts";
import type { ReplTokenRun } from "./description.ts";
import { sourceRuns } from "./presentation-text.ts";

/** What this terminal draws for each phase, glyph and word together. */
const BADGES: Readonly<
  Record<
    "enter" | "active" | "waiting" | "exit" | "settled" | "failed",
    {
      readonly glyph: string;
      readonly word: string;
      readonly role: ReplPresentationRole;
    }
  >
> = Object.freeze({
  enter: Object.freeze({ glyph: "▶", word: "ENTER", role: "lifecycle-enter" }),
  active: Object.freeze({ glyph: "●", word: "ACTIVE", role: "lifecycle-active" }),
  waiting: Object.freeze({ glyph: "●", word: "WAITING", role: "lifecycle-waiting" }),
  exit: Object.freeze({ glyph: "◀", word: "EXIT", role: "lifecycle-exit" }),
  settled: Object.freeze({ glyph: "✓", word: "SETTLED", role: "lifecycle-settled" }),
  failed: Object.freeze({ glyph: "×", word: "FAILED", role: "lifecycle-failed" }),
});

/**
 * Every reading a badge can hold, so the stable status column is a measurement
 * rather than a guess.
 *
 * The widest is a cleanup wait, which is two readings at once; a frame reserves
 * for that and every phase-only change afterwards reuses the same reservation
 * and the same source cuts. Cancellation keeps this terminal's existing word
 * rather than acquiring a glyph the archive never gave it.
 */
export const READING_STATUSES: readonly string[] = Object.freeze([
  ...Object.values(BADGES).map((one) => `${one.glyph} ${one.word}`),
  `${BADGES.exit.glyph} ${BADGES.exit.word} · ${BADGES.waiting.glyph} ${BADGES.waiting.word}`,
  "cancelled",
]);

/** One line of a reading, before anything has been fitted to a width. */
export interface ReplReadingLine {
  /** Stable within one reading, so a window and a target agree on a row. */
  readonly key: string;
  /** The logical text of this line. Never trimmed, never shortened. */
  readonly text: string;
  /** What each part of that text is. Concatenates to exactly `text`. */
  readonly runs: readonly ReplTokenRun[];
  /** Which region this line is in, as a rail role. */
  readonly rail: ReplPresentationRole;
  /** How deeply nested the region is, counted from the entry's own source. */
  readonly depth: number;
  /**
   * What the element owning this line is doing, or none.
   *
   * Present on the first line of an observed element's opening delimiter and on
   * the first line of its closing one, and nowhere else: a badge on every
   * wrapped continuation would say the phase changed between two halves of one
   * tag.
   */
  readonly badge: readonly ReplTokenRun[] | undefined;
  readonly style: ReplRowStyle;
}

/** One captioned part of a reading. */
export interface ReplReadingSection {
  readonly caption: string;
  readonly captionStyle: ReplRowStyle;
  readonly lines: readonly ReplReadingLine[];
}

/** One entry's whole reading: what it produced, then what produced it. */
export interface ReplReading {
  readonly output: ReplReadingSection;
  readonly source: ReplReadingSection;
}

/** Nothing to read. What a prefix that admitted no entry shows. */
export const NO_READING: ReplReading = Object.freeze({
  output: Object.freeze({
    caption: "No entry output recorded at this checkpoint.",
    captionStyle: styleOf("metadata"),
    lines: Object.freeze([]),
  }),
  source: Object.freeze({
    caption: "Source",
    captionStyle: styleOf("pane-heading"),
    lines: Object.freeze([]),
  }),
});

/**
 * One reading as the flat list of logical lines it is drawn as.
 *
 * Captions included, because a caption is a row of the reading rather than a
 * fixed heading above it: the two halves share one vertical window, so
 * scrolling from a result down into the source that produced it has to carry
 * the words that say which is which.
 */
export function readingLines(reading: ReplReading): readonly ReplReadingLine[] {
  return Object.freeze([
    caption("output", reading.output),
    ...reading.output.lines,
    caption("source", reading.source),
    ...reading.source.lines,
  ]);
}

function caption(key: string, section: ReplReadingSection): ReplReadingLine {
  return Object.freeze({
    key: `caption:${key}`,
    text: section.caption,
    runs: tokenRuns([{ text: section.caption, token: section.captionStyle.role }]),
    rail: "rail-pending",
    depth: 0,
    badge: undefined,
    style: section.captionStyle,
  });
}

/** What a reading is being built for. */
export interface ReplReadingRequest {
  readonly entry: ReplEntry;
  /** This session's observations, or an empty reading for a retained prefix. */
  readonly lifecycle: ReplLifecycleReading;
  /** Text a run still going has emitted, or empty. */
  readonly live: string;
  /** Whether this reading is a retained position rather than the live head. */
  readonly inspected: boolean;
}

/**
 * One entry as output then source.
 *
 * The two halves are decided from the typed record, never from the text that
 * came out of it: a document whose own prose contains the word `failed` is
 * still output, and a root that closed `err` is a failure whatever it rendered.
 */
export function entryReading(request: ReplReadingRequest): ReplReading {
  return Object.freeze({
    output: outputSection(request),
    source: sourceSection(request),
  });
}

/**
 * What this entry produced.
 *
 * Four readings, and exactly one of them is true at a time. Live text is
 * labelled as live because it is still arriving and the reader must not take a
 * partial document for a finished one; a retained final result replaces it once
 * and stops being labelled. A root that settled having rendered nothing is not
 * an absence of information — it is the outcome, which is said instead.
 */
function outputSection(request: ReplReadingRequest): ReplReadingSection {
  const { entry, live, inspected } = request;
  const terminal = entry.terminal;
  if (terminal === undefined) {
    // Still going. Its own emitted text, if any has arrived.
    if (live.length > 0) {
      return Object.freeze({
        caption: "Output · live",
        captionStyle: styleOf("waiting", { inspected }),
        lines: plain(live, "output:live", styleOf("output", { inspected })),
      });
    }
    return Object.freeze({
      caption: "No entry output recorded at this checkpoint.",
      captionStyle: styleOf("metadata", { inspected }),
      lines: Object.freeze([]),
    });
  }
  if (terminal.output.length > 0) {
    return Object.freeze({
      caption: "Output",
      captionStyle: styleOf("pane-heading", { inspected }),
      lines: plain(terminal.output, "output", styleOf("output", { inspected })),
    });
  }
  // Settled with nothing rendered. The outcome is the reading, and it is read
  // from the recorded status rather than from any word in any prose.
  const outcome: ReplPresentationRole =
    terminal.status === "ok"
      ? "successful-outcome"
      : terminal.status === "err"
        ? "failed-outcome"
        : "waiting";
  const said = terminal.status === "cancelled" ? "cancelled" : `closed ${terminal.status}`;
  // The reason, and only where there is one to give. An `ok`, a cancellation and
  // an entry that never settled have no reason to show, and inventing text for
  // them would describe a failure that did not happen. Its own row, so the
  // outcome and the reason are two rows a window can move rather than one row
  // this pane has to break in the middle.
  const reason =
    terminal.status === "err" && terminal.message !== undefined
      ? plain(
          `failed: ${terminal.message}`,
          "output:reason",
          styleOf("failed-outcome", { inspected }),
        )
      : [];
  return Object.freeze({
    caption: "No rendered output.",
    captionStyle: styleOf("metadata", { inspected }),
    lines: Object.freeze([
      ...plain(said, "output:outcome", styleOf(outcome, { inspected })),
      ...reason,
    ]),
  });
}

/** Text as lines nothing has been observed in. */
function plain(text: string, prefix: string, style: ReplRowStyle): readonly ReplReadingLine[] {
  return Object.freeze(
    text.split("\n").map((one, index) =>
      Object.freeze({
        key: `${prefix}:${index}`,
        text: one,
        runs: tokenRuns([{ text: one, token: style.role }]),
        rail: "rail-pending" as const,
        depth: 0,
        badge: undefined,
        style,
      }),
    ),
  );
}

/**
 * The source this entry admitted, with what each part of it is doing.
 *
 * A refusal is not a blank pane: inspection refusing this text means the
 * scanner would refuse it too, and a reader looking at source the engine will
 * not accept needs to be told that rather than shown unmarked prose. The exact
 * text is still shown, because it is theirs.
 */
function sourceSection(request: ReplReadingRequest): ReplReadingSection {
  const { entry, inspected } = request;
  const lines: ReplReadingLine[] = [];
  const build = new Build(request, lines);
  build.region(entry.source, "document", entry.scope, undefined, 0, "src");
  return Object.freeze({
    caption: "Source",
    captionStyle: styleOf("pane-heading", { inspected }),
    lines: Object.freeze(lines),
  });
}

/** Where one element's phase and its rail came from. */
interface Observation {
  readonly rail: ReplPresentationRole;
  readonly opening: readonly ReplTokenRun[];
  readonly closing: readonly ReplTokenRun[] | undefined;
}

/** Source nothing has been observed in. Not a phase: an absence of one. */
const UNOBSERVED: Observation = Object.freeze({
  rail: "rail-pending",
  opening: Object.freeze([]),
  closing: undefined,
});

/**
 * One reading under construction.
 *
 * A class rather than a pile of threaded parameters because the recursion
 * carries six things through every generated child region and one of them — the
 * row counter — has to stay unique across all of them.
 */
class Build {
  readonly #request: ReplReadingRequest;
  readonly #lines: ReplReadingLine[];
  #next = 0;

  constructor(request: ReplReadingRequest, lines: ReplReadingLine[]) {
    this.#request = request;
    this.#lines = lines;
  }

  /**
   * One text as reading lines, recursing into the elements it is written with.
   *
   * `owner` is the scope whose recorded positions index this text, and
   * `generated` names the fragment this text *is* when it is one. The two
   * together are what an observation is matched on, which is why neither is
   * ever guessed from a name or a sibling.
   */
  region(
    text: string,
    kind: "document" | "fragment",
    owner: ReplScope | undefined,
    generated: string | undefined,
    depth: number,
    prefix: string,
  ): void {
    const read = inspectSource(text, kind);
    if (!read.ok) {
      // The scanner refuses this text. Its exact bytes are still the reader's,
      // and the refusal is said rather than drawn as ordinary prose.
      this.#say(
        `this source cannot be read: ${read.error.message}`,
        "failed-outcome",
        UNOBSERVED.rail,
        depth,
        `${prefix}:refused`,
      );
      this.#plain(text, depth, UNOBSERVED.rail, prefix);
      return;
    }
    this.#elements(text, read.value, 0, text.length, owner, generated, depth, prefix);
  }

  /**
   * The elements written between two offsets, and the prose between them.
   *
   * Nesting comes from canonical interval containment and from nothing else —
   * not from a name, not from indentation, not from the order two tags happen
   * to appear in. An element whose whole span lies inside another's is that
   * one's child; one that merely follows it is its sibling.
   */
  #elements(
    text: string,
    elements: readonly SourceElement[],
    from: number,
    to: number,
    owner: ReplScope | undefined,
    generated: string | undefined,
    depth: number,
    prefix: string,
  ): void {
    let at = from;
    for (const [index, element] of elements.entries()) {
      const span = spanOf(element);
      if (span.start < from || span.end > to) {
        continue;
      }
      if (span.start < at) {
        // Inside one already emitted as a child of an earlier element.
        continue;
      }
      if (span.start > at) {
        this.#plain(
          text.slice(at, span.start),
          depth,
          UNOBSERVED.rail,
          `${prefix}:${index}:before`,
        );
      }
      this.#element(text, elements, element, owner, generated, depth, `${prefix}:${index}`);
      at = span.end;
    }
    if (at < to) {
      this.#plain(text.slice(at, to), depth, UNOBSERVED.rail, `${prefix}:tail`);
    }
  }

  /**
   * One element: its opening delimiter, what it encloses, its closing one.
   *
   * The rail runs the whole way through, continuations and generated children
   * included, because it says which region a row is in. The badge appears on
   * the first line of each delimiter only.
   */
  #element(
    text: string,
    elements: readonly SourceElement[],
    element: SourceElement,
    owner: ReplScope | undefined,
    generated: string | undefined,
    depth: number,
    prefix: string,
  ): void {
    // One reading per actual call, in the order they were observed, each in
    // its own source group. An element nothing was observed of is read once
    // and unobserved, which is the same shape with no call in it.
    const calls = this.#occurrences(element, owner, generated);
    if (calls.length === 0) {
      this.#call(text, elements, element, owner, generated, depth, prefix, undefined);
      return;
    }
    for (const [index, one] of calls.entries()) {
      this.#call(
        text,
        elements,
        element,
        owner,
        generated,
        depth,
        calls.length === 1 ? prefix : `${prefix}@${index}`,
        one,
      );
    }
  }

  /** One call of one element, as its delimiters and what they enclose. */
  #call(
    text: string,
    elements: readonly SourceElement[],
    element: SourceElement,
    owner: ReplScope | undefined,
    generated: string | undefined,
    depth: number,
    prefix: string,
    call: ReplOccurrence | undefined,
  ): void {
    const observed = this.#observed(call);
    // A self-closing element has one delimiter, so whatever would have been
    // said beside its closing tag is said beside the only tag it has. Dropping
    // it would leave an element that plainly settled reading as unobserved.
    const opening =
      element.closing === undefined ? (observed.closing ?? observed.opening) : observed.opening;
    this.#delimiter(
      text.slice(element.opening.start, element.opening.end),
      depth,
      observed.rail,
      `${prefix}:open`,
      opening,
    );
    // What this element's enclosure holds: the fragment it generated, if it
    // admitted one, and otherwise the source its author wrote there.
    const replacement = this.#generated(element, owner, generated);
    if (replacement !== undefined) {
      this.region(
        replacement.source,
        "fragment",
        replacement.scope,
        replacement.identity,
        depth + 1,
        `${prefix}:gen`,
      );
    } else if (element.closing !== undefined) {
      this.#elements(
        text,
        elements,
        element.opening.end,
        element.closing.start,
        owner,
        generated,
        depth + 1,
        `${prefix}:in`,
      );
    }
    if (element.closing !== undefined) {
      this.#delimiter(
        text.slice(element.closing.start, element.closing.end),
        depth,
        observed.rail,
        `${prefix}:close`,
        observed.closing,
      );
    }
  }

  /**
   * A delimiter as lines, with its badge on the first of them.
   *
   * A tag written across several lines is several lines here too, and only the
   * first carries the reading — a second badge on a continuation would say the
   * phase belonged to half a tag.
   */
  #delimiter(
    text: string,
    depth: number,
    rail: ReplPresentationRole,
    prefix: string,
    badge: readonly ReplTokenRun[] | undefined,
  ): void {
    const shown = badge !== undefined && badge.length > 0 ? badge : undefined;
    for (const [index, one] of text.split("\n").entries()) {
      this.#push({
        key: `${prefix}:${index}`,
        text: one,
        runs: sourceRuns(one),
        rail,
        depth,
        badge: index === 0 ? shown : undefined,
        style: styleOf("source", { inspected: this.#request.inspected }),
      });
    }
  }

  /**
   * Prose as lines, each cut only at its own explicit newline.
   *
   * A blank logical line stays one row: dropping it would edit the shape of
   * somebody's document, and the whole point of this pane is that it is theirs.
   */
  #plain(text: string, depth: number, rail: ReplPresentationRole, prefix: string): void {
    if (text.length === 0) {
      return;
    }
    const pieces = text.split("\n");
    // A region that began right after a newline ends its predecessor's row
    // rather than opening an empty one of its own.
    for (const [index, one] of pieces.entries()) {
      if (one.length === 0 && (index === 0 || index === pieces.length - 1)) {
        continue;
      }
      this.#push({
        key: `${prefix}:${index}`,
        text: one,
        runs: sourceRuns(one),
        rail,
        depth,
        badge: undefined,
        style: styleOf("source", { inspected: this.#request.inspected }),
      });
    }
  }

  #say(
    text: string,
    role: ReplPresentationRole,
    rail: ReplPresentationRole,
    depth: number,
    key: string,
  ): void {
    this.#push({
      key,
      text,
      runs: tokenRuns([{ text, token: role }]),
      rail,
      depth,
      badge: undefined,
      style: styleOf(role, { inspected: this.#request.inspected }),
    });
  }

  #push(line: Omit<ReplReadingLine, "key"> & { readonly key: string }): void {
    this.#next += 1;
    this.#lines.push(Object.freeze({ ...line, key: `${line.key}#${this.#next}` }));
  }

  /**
   * What has actually been observed of this element, or nothing.
   *
   * Matched on the entry's own lifecycle reading, the recorded source position
   * and the fragment that position belongs to. A retained prefix has no
   * observations at all, so every element in it reads as unobserved — which is
   * the truth: static syntax does not prove execution.
   */
  #observed(one: ReplOccurrence | undefined): Observation {
    if (one === undefined) {
      return UNOBSERVED;
    }
    const waiting = one.waiting.length > 0;
    switch (one.phase) {
      case "enter":
        return reading(waiting ? "rail-waiting" : "rail-active", waiting ? ["waiting"] : ["enter"]);
      case "active":
        return reading(
          waiting ? "rail-waiting" : "rail-active",
          waiting ? ["waiting"] : ["active"],
        );
      // An element whose body returned is releasing what it acquired. The wait
      // is said as well as the exit, and the rail stays the exit's: a cleanup
      // wait is a thing happening *during* exit, not instead of it.
      case "exit":
        return reading("rail-exit", [], waiting ? ["exit", "waiting"] : ["exit"]);
      case "settled":
        return reading("rail-settled", [], ["settled"]);
      case "failed":
        return reading("rail-settled", [], ["failed"]);
      // This terminal's existing word for a reading that stopped. The archive
      // gave cancellation no glyph, and inventing one would make it a seventh
      // phase nobody specified.
      case "cancelled":
        return Object.freeze({
          rail: "rail-settled" as const,
          opening: Object.freeze([]),
          closing: tokenRuns([{ text: "cancelled", token: "waiting" }]),
        });
    }
  }

  /**
   * Every call of this element, in the order they were observed.
   *
   * A document that writes one element inside a `<Loop>`, or writes the same
   * element twice, produces several *calls* of it at one source position. Each
   * is its own reading: showing only the last would say the earlier ones never
   * happened, and showing one badge for all of them would say several calls
   * were one.
   */
  #occurrences(
    element: SourceElement,
    owner: ReplScope | undefined,
    generated: string | undefined,
  ): readonly ReplOccurrence[] {
    const { lifecycle, entry } = this.#request;
    if (lifecycle.entry !== entry.key) {
      return [];
    }
    const path = owner?.path;
    const found: ReplOccurrence[] = [];
    for (const one of lifecycle.occurrences) {
      const position = one.position;
      if (position === undefined || position.offset !== element.opening.start) {
        continue;
      }
      if (position.generatedSource !== generated) {
        continue;
      }
      if (generated === undefined && path !== undefined && position.path !== path) {
        continue;
      }
      found.push(one);
    }
    return found;
  }

  /**
   * The generated fragment this element admitted, or nothing.
   *
   * Exactly one `Evaluate` opening at the owner's canonical recorded position.
   * Nothing is matched by name, by sibling order or by what the fragment looks
   * like: an ambiguous or absent ownership keeps the producer on screen, which
   * is what the author actually wrote, instead of attributing somebody's
   * generated text to the wrong enclosure.
   */
  #generated(
    element: SourceElement,
    owner: ReplScope | undefined,
    generated: string | undefined,
  ):
    | { readonly source: string; readonly scope: ReplScope | undefined; readonly identity: string }
    | undefined {
    if (owner === undefined || element.name !== "Evaluate") {
      return undefined;
    }
    const admitted = owner.generated.filter((one) => admittedAt(one, element, owner, generated));
    if (admitted.length !== 1) {
      return undefined;
    }
    const one = admitted[0];
    const source = one.source;
    if (source === undefined) {
      return undefined;
    }
    // The scope this fragment was admitted as, so its own elements are matched
    // against its own recorded positions.
    const scope = owner.scopes.find(
      (child) => child.kind === "generated" && child.marker === one.marker,
    );
    return { source, scope, identity: one.marker };
  }
}

/**
 * Whether one admitted fragment belongs to this element's enclosure.
 *
 * A refusal keeps the producer visible; so does a fragment whose recorded
 * position is not this opening, or belongs to a different text than the one
 * being read.
 */
function admittedAt(
  one: ReplGenerated,
  element: SourceElement,
  owner: ReplScope,
  generated: string | undefined,
): boolean {
  if (one.decision !== "admitted" || one.source === undefined) {
    return false;
  }
  const scope = owner.scopes.find(
    (child) => child.kind === "generated" && child.marker === one.marker,
  );
  const position = scope?.position;
  if (position === undefined) {
    return false;
  }
  return position.offset === element.opening.start && position.generatedSource === generated;
}

function reading(
  rail: ReplPresentationRole,
  opening: readonly (keyof typeof BADGES)[],
  closing?: readonly (keyof typeof BADGES)[],
): Observation {
  return Object.freeze({
    rail,
    opening: badgeRuns(opening),
    closing: closing === undefined ? undefined : badgeRuns(closing),
  });
}

/**
 * One badge as its runs.
 *
 * Glyph and word together, as the accepted presentation insists, so a reading
 * survives a reader who cannot tell two of these colours apart. Two readings in
 * one badge keep their own accents and are joined by a separator that is
 * neither of them.
 */
function badgeRuns(phases: readonly (keyof typeof BADGES)[]): readonly ReplTokenRun[] {
  const parts: { readonly text: string; readonly token: ReplPresentationRole }[] = [];
  for (const [index, phase] of phases.entries()) {
    const badge = BADGES[phase];
    if (index > 0) {
      parts.push({ text: " · ", token: "punctuation" });
    }
    parts.push({ text: `${badge.glyph} ${badge.word}`, token: badge.role });
  }
  return tokenRuns(parts);
}

function spanOf(element: SourceElement): { readonly start: number; readonly end: number } {
  return {
    start: element.opening.start,
    end: element.closing === undefined ? element.opening.end : element.closing.end,
  };
}
