/**
 * The build a `<TestAgent>` partition observes
 * (specs/native-agent-session-launch-spec.md §Executable binding).
 *
 * A session whose identity XMD chose is only meaningful while the build that
 * accepted it can be recognized later, and the provider will not act on one
 * without an observer to ask. There is no real executable here, so this answers
 * the same question deterministically: one stable digest and one canonical
 * version for the life of the partition.
 *
 * Its lifetime is that partition, which is what makes two sibling `<Test>`
 * elements two worlds rather than two views of one. A harness that wants to
 * watch a build drift replaces what this whole seam answers, rather than
 * reaching for a control the production path also has.
 */

import { createHash } from "node:crypto";
import { TEST_AGENT_BUILD_VERSION } from "./provider.ts";
import type { ExecutableObserver } from "@executablemd/runtime";

export interface ControlledExecutableObserver {
  observer: ExecutableObserver;
  /** What the next observation answers. Change it to drift the build. */
  observed: { path: string; digest: string; versionOutput: string };
  /** Every command this partition was asked about, in order. */
  asked: string[];
}

export function createControlledExecutableObserver(
  seed = "test-agent",
): ControlledExecutableObserver {
  const controlled: ControlledExecutableObserver = {
    asked: [],
    observed: {
      // Never a real path: nothing is spawned, and the value exists only so
      // that a test can prove it does not reach a record.
      path: `/xmd-test-agent/${seed}/ui`,
      digest: createHash("sha256").update(seed).digest("hex"),
      versionOutput: `${TEST_AGENT_BUILD_VERSION}\n`,
    },
    observer: {
      // deno-lint-ignore require-yield
      *observe(command) {
        controlled.asked.push(command);
        return {
          path: controlled.observed.path,
          digest: { algorithm: "sha256", value: controlled.observed.digest },
          versionOutput: controlled.observed.versionOutput,
        };
      },
    },
  };
  return controlled;
}
