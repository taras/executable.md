/**
 * The teaching this CLI ships, and the index that tells a reply it is there.
 *
 * Six chapters and one bootstrap, as real Markdown beside this feature. They
 * are assets rather than string constants for the same reason `xmd plan`'s
 * document is: the reviewable file is the deployed artifact, and a generated
 * TypeScript mirror would make the thing shipped something other than the thing
 * read. They live under the CLI's `src/documents/`, which every build already
 * carries — `deno compile` embeds that directory whole and the npm build copies
 * it — so a chapter added beside the others needs no build change.
 *
 * ## The index is derived, not written
 *
 * A hand-written list of chapters is a second catalogue describing the first,
 * and it starts out true. So the names come from the admitted registrations —
 * the same entries the response ceiling is built from, so a chapter nothing
 * admits cannot be advertised and a chapter that is admitted cannot be left out
 * — and each line's purpose comes from the chapter's *own* opening sentence.
 * The guide format requires that opening to say when to read the chapter and
 * what it enables, which makes it the one statement of purpose there is.
 *
 * Reading a chapter performs no submission, runs no example and reaches no
 * shell. It returns Markdown, literally, and the exact text returned is what
 * the operation retains.
 */

import { readFile } from "node:fs/promises";
import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";

import { GUIDE_CHAPTERS } from "./controls.ts";
import type { GuideChapter } from "./controls.ts";

/** Why a chapter could not be read, which is a refusal and not a chapter. */
export class SidekickGuideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidekickGuideError";
  }
}

/** The orientation delivered before a conversation's first turn. */
export const SIDEKICK_BOOTSTRAP = "bootstrap.md";

/**
 * Which file holds which chapter.
 *
 * The one place the mapping is stated, and stated as a total record over the
 * chapter union: a chapter added to {@link GUIDE_CHAPTERS} without an asset is
 * a type error here rather than a refusal a reply discovers.
 */
const CHAPTERS: Readonly<Record<GuideChapter, string>> = {
  Entries: "entries.md",
  Bindings: "bindings.md",
  Effection: "effection.md",
  Lifetimes: "lifetimes.md",
  Recovery: "recovery.md",
  Environment: "environment.md",
};

/**
 * Where a Sidekick asset lives, as a URL beside this module's package.
 *
 * From the module's own URL, never from the working directory and never through
 * the component search path: the command has to find the same teaching whatever
 * directory a person is standing in, and a file in their repository must not be
 * able to answer for it.
 */
export function sidekickAssetUrl(name: string): URL {
  return new URL(`../../documents/sidekick/${name}`, import.meta.url);
}

/** Read one shipped asset, or say which build is missing it. */
function* readAsset(name: string): Operation<Result<string>> {
  const url = sidekickAssetUrl(name);
  try {
    return Ok(yield* until(readFile(url, "utf8")));
  } catch {
    // A refusal rather than a throw, because this is one control's outcome: a
    // reply that asked for a chapter gets told it is unavailable and may ask
    // for something else, and the retained operation records that.
    return Err(
      new SidekickGuideError(
        `the Sidekick asset ${name} is missing from this build (looked in ${url.href}).`,
      ),
    );
  }
}

/** The orientation text, as the first turn is given it. */
export function readSidekickBootstrap(): Operation<Result<string>> {
  return readAsset(SIDEKICK_BOOTSTRAP);
}

/**
 * Read one chapter, exactly as it is written.
 *
 * Literal Markdown. Nothing is rendered, interpolated or expanded on the way
 * out: what the file says is what the reply reads and what the operation
 * retains, so the text a person reviews is the text an agent was taught.
 */
export function readGuideChapter(chapter: GuideChapter): Operation<Result<string>> {
  return readAsset(CHAPTERS[chapter]);
}

/** One line of the index: a chapter, how to ask for it, and why. */
export interface GuideEntry {
  /** The admitted component name, as a reply must write it. */
  readonly name: string;
  /** The exact invocation, so nobody has to infer the spelling. */
  readonly invocation: string;
  /** When to read it, from the chapter's own opening. */
  readonly purpose: string;
}

/**
 * The index a conversation's first turn is given.
 *
 * `admitted` is the set of component names this response ceiling actually
 * registered. Passing it in rather than reading {@link GUIDE_CHAPTERS} directly
 * is the whole point: the index describes what is admitted, so a chapter that
 * is registered and a chapter that is advertised cannot diverge.
 *
 * A chapter whose asset cannot be read is left out rather than advertised with
 * no purpose — telling a reply to call something that will refuse is worse than
 * not mentioning it — and the refusal is still what it gets if it asks.
 */
export function* sidekickGuideIndex(
  admitted: ReadonlySet<string>,
): Operation<readonly GuideEntry[]> {
  const index: GuideEntry[] = [];
  for (const chapter of GUIDE_CHAPTERS) {
    const name = `Guide.${chapter}`;
    if (!admitted.has(name)) {
      continue;
    }
    const text = yield* readGuideChapter(chapter);
    if (!text.ok) {
      continue;
    }
    index.push(
      Object.freeze({
        name,
        invocation: `<${name} />`,
        purpose: opening(text.value),
      }),
    );
  }
  return Object.freeze(index);
}

/**
 * The index as the text a first turn is given.
 *
 * Name, exact invocation and purpose, one line each. The invocation is spelled
 * out rather than left to be inferred, because the first turn's whole job is to
 * make asking for help possible without first discovering how to ask.
 */
export function describeGuideIndex(entries: readonly GuideEntry[]): string {
  const lines = ["Guides you can read (each returns its chapter to you as feedback):"];
  for (const entry of entries) {
    lines.push(`- ${entry.invocation} — ${entry.purpose}`);
  }
  return lines.join("\n");
}

/**
 * The chapter's own statement of when to read it.
 *
 * The first paragraph after the title, which the guide format requires to be
 * exactly that. Taken from the chapter rather than restated here so there is
 * one sentence saying what a chapter is for, in the file a person reviews.
 *
 * Joined onto one line, because this is an index entry: the paragraph is
 * wrapped for reading as Markdown, and its line breaks mean nothing here.
 */
function opening(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("# "));
  const paragraph: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.join(" ");
}
