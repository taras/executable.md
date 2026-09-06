/**
 * The build a `<TestAgent>` partition observes
 * (specs/native-agent-session-launch-spec.md §Executable binding).
 *
 * A session whose identity XMD chose is only meaningful while the build that
 * accepted it can be recognized later, and the provider will not act on one
 * without an observer to ask. There is no real executable here, so this answers
 * the same question deterministically: one stable digest, one declared help
 * surface and one canonical version for the life of the partition.
 *
 * The whole observation is injected rather than any one answer being patched,
 * because that is what keeps the production path unweakened: a scenario that
 * wants a capability to go missing removes a declaration from what this
 * answers, and the same probe reads it.
 *
 * Its lifetime is that partition, which is what makes two sibling `<Test>`
 * elements two worlds rather than two views of one.
 */

import { createHash } from "node:crypto";
import { TEST_AGENT_BUILD_VERSION, TEST_AGENT_HELP } from "./provider.ts";
import type { ExecutableMetadata, ExecutableObserver } from "@executablemd/runtime";

/** One query's answer, in the shape a real observation produces. */
function reported(stdout: string): ExecutableMetadata[string] {
  return { settled: true, code: 0, stdout, stderr: "" };
}

export interface ControlledExecutableObserver {
  observer: ExecutableObserver;
  /** What the next observation answers. Change it to drift the build. */
  observed: { path: string; digest: string; metadata: Record<string, ExecutableMetadata[string]> };
  /** Every command this partition was asked about, in order. */
  asked: string[];
  /** Every metadata query it was asked to run, as `name argv…`, in order. */
  queried: string[];
}

export function createControlledExecutableObserver(
  seed = "test-agent",
): ControlledExecutableObserver {
  const controlled: ControlledExecutableObserver = {
    asked: [],
    queried: [],
    observed: {
      // Never a real path: nothing is spawned, and the value exists only so
      // that a test can prove it does not reach a record.
      path: `/xmd-test-agent/${seed}/ui`,
      digest: createHash("sha256").update(seed).digest("hex"),
      metadata: {
        help: reported(TEST_AGENT_HELP),
        version: reported(`${TEST_AGENT_BUILD_VERSION}\n`),
      },
    },
    observer: {
      // deno-lint-ignore require-yield
      *observe(command, options) {
        controlled.asked.push(command);
        for (const query of options?.metadata ?? []) {
          controlled.queried.push([query.name, ...query.args].join(" "));
        }
        return {
          path: controlled.observed.path,
          digest: { algorithm: "sha256", value: controlled.observed.digest },
          metadata: controlled.observed.metadata,
        };
      },
    },
  };
  return controlled;
}
