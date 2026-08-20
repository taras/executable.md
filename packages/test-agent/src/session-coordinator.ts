/**
 * Session ownership for one `<TestAgent>` partition
 * (specs/test-agent-spec.md §Scenarios).
 *
 * The test agent advertises native launch, so every session, prompt and launch
 * it serves passes through a coordinator before reaching ACPX. A host that
 * installs none refuses, which is right for a host that cannot see whether a
 * native UI is in the session — and wrong for a document whose agent is a
 * worker this process started and owns outright.
 *
 * So this answers the same question deterministically, in memory, with the
 * semantics the Deno adapter gives: one live owner at a time, and an owner that
 * never proved it stopped leaves the session owned. What it deliberately does
 * not have is a machine-wide namespace. Its lifetime is the partition that
 * constructed it, which is why sibling `<Test>` elements naming the same agent,
 * session and directory do not contend — they are not two owners of one
 * session, they are two sessions.
 */

import { ensure, Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import {
  AgentSessionBusy,
  agentSessionKeyDigest,
  AgentSessionRecoveryRequired,
} from "@executablemd/runtime";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwner,
  AgentSessionOwnership,
} from "@executablemd/runtime";

/**
 * A coordinator that owns exactly the sessions of the partition holding it.
 *
 * Injected through `createAcpxProvider()`'s ordinary dependency seam, so the
 * provider path a test drives is the provider path a run takes.
 */
export function createDeterministicSessionCoordinator(): AgentSessionCoordinator {
  /** Held right now, by digest. */
  const occupied = new Set<string>();
  /** What the last owner left behind. Absent is the same as idle. */
  const retained = new Map<string, "active" | "idle">();

  return {
    coordinate<T>(
      key: AgentSessionKey,
      owner: AgentSessionOwner,
      body: (ownership: AgentSessionOwnership) => Operation<T>,
    ): Operation<Result<T>> {
      // Scoped for the same reason the Deno adapter is: ownership lasts as long
      // as the work it protects, not as long as the caller.
      return scoped(function* (): Operation<Result<T>> {
        const digest = agentSessionKeyDigest(key);
        if (occupied.has(digest)) {
          return Err(
            new AgentSessionBusy(
              `another owner is using session "${key.sessionKey}" — ${owner.kind} work cannot ` +
                `start while it is held.`,
            ),
          );
        }
        occupied.add(digest);
        yield* ensure(() => {
          occupied.delete(digest);
        });

        if (retained.get(digest) === "active") {
          return Err(
            new AgentSessionRecoveryRequired(
              `session "${key.sessionKey}" was left owned by work that did not finish, so it ` +
                `stays owned until it is recovered deliberately.`,
            ),
          );
        }
        retained.set(digest, "active");

        let quiesced = false;
        // Registered before the body runs, so the idle mark is published on
        // every ordinary exit — and on none of the others.
        yield* ensure(() => {
          if (quiesced) {
            retained.set(digest, "idle");
          }
        });

        return Ok(
          yield* body({
            quiesced() {
              quiesced = true;
            },
          }),
        );
      });
    },
  };
}
