/**
 * Binding a session to the exact executable build that established it
 * (specs/native-agent-session-launch-spec.md §Durable binding).
 *
 * The failure this exists to prevent is silent. When one Claude build creates
 * a session and another is asked to resume it, nothing errors: the runtime
 * reports a healthy session, the turn completes, and only the content shows
 * that the conversation is gone. That was the observed cause of issue #519's
 * first failed gate — 2.1.235 created, 2.1.232 resumed.
 *
 * So a bound session records which build it was established against and
 * refuses rather than resumes when that build cannot be reproduced. The
 * refusal is raised while ACP still owns the session, before anything detaches
 * or spawns, because after the handoff there is nothing left to refuse with.
 *
 * What is retained is a canonical version and the digest of the file's bytes.
 * The live path is invocation-local: it is spawned and asked for a version,
 * and it never reaches a record or a diagnostic.
 */

import type { ExecutableBuildBindingV1 } from "@executablemd/core";
import { sameExecutableBuild } from "@executablemd/core";
import { type Operation, scoped } from "effection";
import {
  exec,
  ExecutableBinding,
  ExecutableObservationError,
  useQuietProcessOutput,
} from "@executablemd/runtime";
import type { NativeBinding } from "./native-launch.ts";

/** Why a binding could not be established or confirmed. */
export type BindingMismatch =
  | "executable-unavailable"
  | "version-unrecognized"
  | "version-changed"
  | "build-changed"
  | "unknown-binding-schema";

/**
 * A refusal that names the launcher and the mismatch, and nothing else.
 *
 * Versions are reportable because an author can act on them — they say which
 * build is expected and which is installed. Paths, raw command output,
 * environment and argv are not, and never appear here.
 */
export class ExecutableBindingRefused extends Error {
  override name = "ExecutableBindingRefused";
  launcher: string;
  mismatch: BindingMismatch;
  expectedVersion?: string;
  observedVersion?: string;

  constructor(options: {
    launcher: string;
    mismatch: BindingMismatch;
    message: string;
    expectedVersion?: string;
    observedVersion?: string;
  }) {
    super(options.message);
    this.launcher = options.launcher;
    this.mismatch = options.mismatch;
    if (options.expectedVersion !== undefined) {
      this.expectedVersion = options.expectedVersion;
    }
    if (options.observedVersion !== undefined) {
      this.observedVersion = options.observedVersion;
    }
  }
}

/** One executable build, as observed during this invocation. */
export interface ObservedBuild {
  /** Invocation-local. Spawned and asked for a version; never retained. */
  livePath: string;
  binding: ExecutableBuildBindingV1;
}

/**
 * Observe the build `binding.command` currently resolves to.
 *
 * The version is asked of the canonical path rather than of the command name,
 * so what gets reported is the build that will actually be spawned rather than
 * whatever a second resolution might find.
 */
export function* observeBuild(launcher: string, binding: NativeBinding): Operation<ObservedBuild> {
  let observed;
  try {
    observed = yield* ExecutableBinding.operations.observe(binding.command);
  } catch (error) {
    if (error instanceof ExecutableObservationError) {
      throw new ExecutableBindingRefused({
        launcher,
        mismatch: "executable-unavailable",
        message: `the ${launcher} executable could not be used (${error.refusal})`,
      });
    }
    throw error;
  }

  // The version is an answer, not output. Scoped so the suppression covers
  // this one child and nothing a caller runs afterwards.
  const result = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({ command: [observed.path, "--version"] });
  });
  const version = result.exitCode === 0 ? binding.version(result.stdout) : undefined;
  if (version === undefined) {
    throw new ExecutableBindingRefused({
      launcher,
      mismatch: "version-unrecognized",
      message:
        `the installed ${launcher} did not report a version this build recognizes, ` +
        `so the session it establishes could not be confirmed later`,
    });
  }

  return {
    livePath: observed.path,
    binding: {
      schema: "executable-build.v1",
      reportedVersion: version,
      executableDigest: observed.digest,
    },
  };
}

/**
 * Observe the current build and require it to be the retained one.
 *
 * A moved build is compatible — the retained fields say which build it is, not
 * where it was. A different build at the familiar path is not, and it is the
 * case worth naming: nothing about the path distinguishes them.
 *
 * V1 never rebinds. Adopting the newly observed build here would be the same
 * silent substitution the binding exists to prevent, just performed by XMD.
 */
export function* requireRetainedBuild(
  launcher: string,
  binding: NativeBinding,
  retained: ExecutableBuildBindingV1,
): Operation<ObservedBuild> {
  if (retained.schema !== "executable-build.v1") {
    throw new ExecutableBindingRefused({
      launcher,
      mismatch: "unknown-binding-schema",
      message: `this session was bound by a newer XMD and cannot be confirmed by this one`,
    });
  }

  const observed = yield* observeBuild(launcher, binding);
  if (sameExecutableBuild(observed.binding, retained)) {
    return observed;
  }

  const changedVersion = observed.binding.reportedVersion !== retained.reportedVersion;
  throw new ExecutableBindingRefused({
    launcher,
    mismatch: changedVersion ? "version-changed" : "build-changed",
    message: changedVersion
      ? `this session was established by a different ${launcher} build, and resuming it ` +
        `through the installed one would silently produce an empty conversation`
      : `the installed ${launcher} reports the expected version but is a different build, ` +
        `so the session it established cannot be confirmed`,
    expectedVersion: retained.reportedVersion,
    observedVersion: observed.binding.reportedVersion,
  });
}
