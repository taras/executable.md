/**
 * `xmd upgrade` — the runtime-neutral host around the upgrade command document
 * (specs/upgrade-command-spec.md).
 *
 * Every invocation executes one root: the packaged upgrade command document,
 * an ordinary streaming text root. That document owns the whole of the policy —
 * which release is selected, how two versions compare, which consent an install
 * needs, what a refusal says — and its rendered body *is* what the command
 * prints. It is Markdown so that a person deciding whether to let a program
 * replace its own binary can read the rules rather than infer them from a stack
 * of TypeScript.
 *
 * ```text
 * the entrypoint states what this xmd is
 *   -> read the exact packaged document
 *   -> build the four phase components, if this host has installation authority
 *   -> execute the document with fixed props and nothing else
 *   -> stream what it renders to the caller's consumer, segment by segment
 * ```
 *
 * Nothing is handed back to print. A text root's completion value is the text
 * the consumer already received, so this returns a `Result` with no value.
 *
 * This module reaches for nothing. It does not ask which runtime is running,
 * resolve PATH, open the installation, contact GitHub, or decide what may be
 * replaced. A runtime-named entrypoint states all of that in an
 * {@link UpgradeAssembly}, and only an eligible compiled macOS or Linux host
 * states an {@link UpgradeAssembly.authority} — so on every other host the
 * document has no component to reach and refuses with the entrypoint's own
 * remedy instead.
 */

import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";

import { retainedSource, useNormalizedOutput } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";
import { executeInstalled } from "@executablemd/core/host";
import type { DurableStream } from "@executablemd/durable-streams";

import { readPackagedDocument, UPGRADE_COMMAND_DOCUMENT } from "./packaged-document.ts";
// The document's own eval block imports `semver` at run time, through a
// dynamic import of a compiled block. `deno compile` walks TypeScript and
// never parses the packaged Markdown, so without this static anchor
// `--exclude-unused-npm` prunes the package from the binary and the first
// comparison a compiled `xmd upgrade` reaches fails to resolve it.
import "semver";

/**
 * The identity the upgrade command document runs under.
 *
 * Stable and internal: no path selects it, no include resolves it, and a
 * position reading `(<upgrade-command>:12:1)` says the source is the CLI's own.
 */
export const UPGRADE_COMMAND_IDENTITY = "<upgrade-command>";

/**
 * How this `xmd` is running — never how its files originally arrived.
 *
 * A package manager's database, PATH, a shell profile and the files beside the
 * binary all describe history, and history is exactly what nothing here can
 * observe honestly. What an entrypoint does know is which entrypoint it is, so
 * that is what it states.
 */
export type UpgradeProvenance =
  | "compiled"
  | "compiled-windows"
  | "deno-source"
  | "npm-node"
  | "bun-source";

/** What one `xmd upgrade` invocation was asked to do. */
export interface UpgradeCommand {
  /** The exact tag the caller named, or `null` for the latest stable release. */
  requestedTag: string | null;
  /** Report the comparison and change nothing. */
  status: boolean;
  /** Consent to installing an older release. */
  allowDowngrade: boolean;
  /** Consent to installing an exact prerelease tag. */
  allowPrerelease: boolean;
}

/**
 * What a runtime-named entrypoint states about the `xmd` that is running.
 *
 * Closed on purpose. Every field is a decision only an entrypoint can make, and
 * the one that carries authority is the last: a host that supplies no
 * {@link authority} gives the document no component through which anything
 * could be read, downloaded or replaced.
 */
export interface UpgradeAssembly {
  readonly provenance: UpgradeProvenance;
  /** The version this binary reports, from the manifest it was built with. */
  readonly currentVersion: string;
  /** The executable path this process was invoked as, spelled exactly. */
  readonly executablePath: string;
  /** Node's `process.platform` for the machine this is running on. */
  readonly platform: string;
  /** Node's `process.arch` for the machine this is running on. */
  readonly architecture: string;
  /** The release target for that platform, when the release publishes one. */
  readonly target?: string;
  /**
   * The four phase components an eligible compiled host contributes:
   * `Upgrade.Releases`, `Upgrade.Download`, `Upgrade.Verify` and
   * `Upgrade.Replace`.
   *
   * Called once, inside this command's own scope, before the document exists —
   * so what the phases close over belongs to one invocation, and the
   * installation lock they take is released by leaving that scope however the
   * command ends.
   */
  authority?(command: UpgradeCommand): Operation<readonly IdentityComponent[]>;
}

/**
 * The transcript with blank runs collapsed, still delivered as it is produced.
 *
 * A branch the command did not take contributes no prose, but the engine still
 * emits the blank lines that surrounded it — so a document with as many
 * branches as this one arrives with a dozen blank lines between paragraphs.
 * Collapsing them is whitespace normalization, which is what the document's
 * rendered form is entitled to; it is done here so every consumer sees the same
 * transcript.
 *
 * Only newlines are ever held back. Text is passed on the moment it arrives, so
 * a phase's milestone still reaches the reader before the next phase begins.
 */
function collapsingBlankRuns(consume: UpgradeConsumer): {
  consume: UpgradeConsumer;
  finish(): Operation<void>;
} {
  let pending = 0;
  let started = false;
  return {
    *consume(chunk) {
      let out = "";
      for (const character of chunk) {
        if (character === "\n") {
          pending += 1;
          continue;
        }
        if (started) {
          out += "\n".repeat(Math.min(pending, 2));
        }
        pending = 0;
        out += character;
        started = true;
      }
      if (out.length > 0) {
        yield* consume(out);
      }
    },
    *finish() {
      if (started) {
        yield* consume("\n");
      }
    },
  };
}

/** Who receives the document's rendered output, chunk by chunk, as it is made. */
export interface UpgradeConsumer {
  (chunk: string): Operation<void>;
}

/** Everything one `xmd upgrade` invocation runs with. */
export interface UpgradeRun {
  command: UpgradeCommand;
  assembly: UpgradeAssembly;
  /**
   * Where this run's durable events go: one invocation-local in-memory stream,
   * or the file `--journal` named and the CLI exclusively created.
   *
   * The caller owns the choice, because only the caller knows whether somebody
   * asked for a diagnostic trace. Neither stream gives any phase resume
   * semantics: nothing here is ever read back.
   */
  stream: DurableStream;
  /**
   * Who reads the transcript.
   *
   * Supplied rather than chosen here, because writing to a terminal is a
   * decision only the command line can make — and this module must not import
   * one. An interactive caller writes each chunk as it arrives; a piped one
   * drains the same stream and writes once; a test observes it.
   */
  consume: UpgradeConsumer;
}

/**
 * Run the packaged upgrade command document, streaming what it renders.
 *
 * The document *is* the output. Its root segments enter `execution.output` in
 * source order as they complete, so a reader watches the release being
 * selected, downloaded, verified and installed rather than waiting for a report
 * about work that already finished. Consumption happens inside the same scope
 * as the execution and while the producer is alive; a buffered read here would
 * turn the transcript back into the synthesized summary this replaced.
 *
 * The completion value is never printed. For a text root that value is the
 * rendered text, and it has already been delivered chunk by chunk — printing it
 * again would say everything twice.
 */
export function* runUpgrade(run: UpgradeRun): Operation<Result<void>> {
  return yield* scoped(function* (): Operation<Result<void>> {
    let source: string;
    let components: readonly IdentityComponent[];
    try {
      source = yield* readPackagedDocument(UPGRADE_COMMAND_DOCUMENT);
      components =
        run.assembly.authority === undefined ? [] : yield* run.assembly.authority(run.command);
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }

    try {
      // What the CLI installs for every run it renders. A raw capture would
      // show whitespace the operator never sees.
      yield* useNormalizedOutput();

      const execution = yield* executeInstalled(
        {
          ...retainedSource(UPGRADE_COMMAND_IDENTITY, source),
          stream: run.stream,
          // No repository component search. What the document may name is what
          // this command declares, so a file in the caller's tree cannot answer
          // for any `Upgrade.*` phase.
          includes: [],
          secretDetection: true,
          props: {
            requestedTag: run.command.requestedTag,
            status: run.command.status,
            allowDowngrade: run.command.allowDowngrade,
            allowPrerelease: run.command.allowPrerelease,
            installation: {
              provenance: run.assembly.provenance,
              currentVersion: run.assembly.currentVersion,
              executablePath: run.assembly.executablePath,
              platform: run.assembly.platform,
              architecture: run.assembly.architecture,
              target: run.assembly.target ?? null,
            },
          },
        },
        [{ components }],
      );

      // Drains while the document is still producing. A consumer that fails
      // raises here, and leaving this scope cancels the execution and waits for
      // its teardown before anything is reported.
      const rendered = collapsingBlankRuns(run.consume);
      yield* forEach(rendered.consume, execution.output);
      yield* rendered.finish();

      // The completion value is discarded on purpose: for a text root it is the
      // rendered text, and the consumer already has it.
      const completed = yield* execution;
      return completed.ok ? Ok(undefined) : completed;
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
