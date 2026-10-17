/**
 * What this host says about itself, and what it says it does not know.
 *
 * `<REPL.Environment />` is a read, and this is what it reads. A reply about to
 * write an entry that touches a path, a platform or a capability needs the facts
 * rather than an assumption about them, and the one thing worse than a fact it
 * does not have is a plausible one it was handed instead.
 *
 * ## Absent is stated, never filled in
 *
 * A fact this host cannot state appears with no value and is rendered as an
 * explicit unknown. It is not omitted — a reply cannot tell an omission from a
 * fact nobody thought to report — and it is not defaulted, because a default is
 * a guess wearing a fact's clothes. The chapter a reply reads says the same
 * thing in the other direction: what the read does not report, it does not know.
 *
 * ## Contextual at the ask, stated at the entrypoint
 *
 * Two sources, and the split is deliberate. The working directory and the
 * platform are *contextual*: they are read through the host APIs at the moment
 * the read happens, so a reply that asked twice across a directory change is
 * told the truth both times rather than a snapshot somebody took at startup.
 * The runtime, the build and the release it belongs to come from the host the
 * runtime entrypoint installed, because only the program that is running knows
 * which program is running — shared code that sniffed for a global would report
 * whichever runtime it recognized rather than the one it is on.
 *
 * Nothing here performs anything else. There is no process, no filesystem read,
 * no network and no entry: a reply that asks what this host is does not thereby
 * make it do anything.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { cwd, platform } from "@executablemd/runtime";

import { ReplHost } from "../host.ts";
import type { ReplHostFact } from "../host.ts";

/** Why the facts could not be read, which is a refusal and not a snapshot. */
export class SidekickEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidekickEnvironmentError";
  }
}

/**
 * The host facts, as one snapshot a reply reads.
 *
 * `session` is what the root knows about this execution and the host does not:
 * where a declared component name is looked for, and how an Agent permission
 * request is answered here. They come last because they are the narrowest —
 * facts about this command rather than about the machine.
 *
 * A failure to read any of it refuses. The alternative is a snapshot with a
 * silent hole in it, which is exactly the thing a reply is told it may rely on.
 */
export function* replEnvironment(session: readonly ReplHostFact[]): Operation<Result<string>> {
  let facts: readonly ReplHostFact[];
  try {
    const where = yield* cwd();
    const machine = yield* platform();
    facts = [
      { label: "working directory", value: where },
      { label: "platform", value: `${machine.os} ${machine.arch}` },
      ...(yield* ReplHost.operations.environment()),
      ...session,
    ];
  } catch (error) {
    return Err(
      new SidekickEnvironmentError(
        `this host's facts could not be read, so none of them are reported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  return Ok(describeEnvironment(facts));
}

/**
 * The snapshot as the text an operation retains.
 *
 * Labelled lines in the order they were assembled, and a closing sentence that
 * states the rule rather than leaving it to be inferred. The rule is in the
 * snapshot and not only in the chapter because the snapshot is what comes back
 * as feedback: a reply reads this with or without having read the teaching.
 */
export function describeEnvironment(facts: readonly ReplHostFact[]): string {
  const lines = ["Host facts, as they stand at this moment:"];
  for (const fact of facts) {
    lines.push(
      fact.value === undefined
        ? `- ${fact.label}: not known to this host`
        : `- ${fact.label}: ${fact.value}`,
    );
  }
  lines.push(
    "A fact listed as not known is not known. Anything not listed is not reported " +
      "either: in both cases, stop rather than assume a value for it.",
  );
  return lines.join("\n");
}
