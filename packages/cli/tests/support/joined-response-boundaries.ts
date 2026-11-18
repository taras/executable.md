import { readTextFile, writeTextFile } from "@effectionx/fs";
import { API, Permissions } from "@executablemd/runtime";
import { scoped } from "effection";
import { join } from "node:path";
import { expect } from "@executablemd/test-support/expect";
import { describe } from "../../../../examples/adversarial-implementation/components/Ticket/text-storage.ts";
import { directRecovery, recoveryFixture, reconcile } from "./joined-response-recovery.ts";

export function proofBoundary(scenario: string) {
  return scoped(function* () {
    const fixture = yield* recoveryFixture();
    let writes = 0;
    let sourceCommands = 0;
    let denied = false;
    let proofChanged = false;
    const namedProof = JSON.parse(yield* readTextFile(fixture.proof));
    const before = fixture.native.host.fake.prompts.length;
    if (scenario === "selected-capacity") {
      yield* writeTextFile(
        fixture.note,
        "Unproved A6/A4/A8/A2/A7 and unfinished-root.\n" + "witness ".repeat(9000),
      );
      const proof = JSON.parse(yield* readTextFile(fixture.proof));
      proof.handoffInputs = [describe(fixture.note, yield* readTextFile(fixture.note))];
      yield* writeTextFile(fixture.proof, JSON.stringify(proof));
    }
    if (scenario.startsWith("repeat-")) {
      const accepted = yield* directRecovery(fixture);
      expect(accepted).toMatchObject({ publication: "confirmed", status: "paused" });
      const continuation = accepted.continuation;
      if (
        continuation === null ||
        Array.isArray(continuation) ||
        typeof continuation !== "object" ||
        typeof continuation.path !== "string"
      ) {
        throw new Error("Missing confirmed descriptor.");
      }
      yield* API.Files.around({
        *writeTextFile([input], next) {
          writes++;
          return yield* next(input);
        },
      });
      yield* API.Process.around({
        *exec([input], next) {
          sourceCommands++;
          return yield* next(input);
        },
      });
      if (scenario === "repeat-proof") {
        expect(yield* directRecovery(fixture, accepted)).toEqual(accepted);
        expect(writes).toBe(0);
        expect(sourceCommands).toBe(0);
      }
      const state = JSON.parse(yield* readTextFile(continuation.path));
      if (scenario === "repeat-proof") {
        fixture.proof = join(fixture.directory, "different-proof.json");
      } else if (scenario === "repeat-snapshot") {
        yield* writeTextFile(state.documents[fixture.proof].snapshot, "corrupt retained proof");
      } else {
        const path = state.checkpoint.feedback.find((path: string) =>
          path.endsWith("/disposition.json"),
        );
        const disposition = JSON.parse(yield* readTextFile(path));
        disposition.derivative.sha256 = "0".repeat(64);
        // A descriptor-valid contradictory disposition still cannot change its derivative link.
        const text = JSON.stringify(disposition);
        yield* writeTextFile(state.documents[path].snapshot, text);
        Object.assign(state.documents[path], describe(path, text));
        const retained = join(fixture.directory, "contradictory-continuation.json");
        const retainedText = JSON.stringify(state);
        yield* writeTextFile(retained, retainedText);
        accepted.continuation = describe(retained, retainedText);
      }
      const repeated = yield* directRecovery(fixture, accepted);
      expect(repeated).toMatchObject({ publication: "held", continuation: accepted.continuation });
      expect(writes).toBe(0);
      expect(sourceCommands).toBe(0);
      const reason = JSON.stringify(repeated);
      expect(reason).toContain(
        scenario === "repeat-proof"
          ? "proof reference"
          : scenario === "repeat-linkage"
            ? "linkage changed"
            : "Retained ticket text changed",
      );
    } else if (scenario === "public-props") {
      for (const name of ["role", "model", "revision", "candidate", "raw", "permission"]) {
        const child = yield* reconcile(fixture, "deno", fixture.recordPath, [
          "--props-" + name,
          "unauthorized",
        ]);
        expect(child.exitCode).not.toBe(0);
        let failed = false;
        try {
          yield* directRecovery(fixture, fixture.record, { [name]: "unauthorized" });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      }
      expect((yield* API.Fs.operations.stat(join(fixture.ticket, "reconciliations"))).exists).toBe(
        false,
      );
    } else {
      yield* API.Files.around({
        *readTextFile([input], next) {
          if (scenario === "current-permission" && join(input.cwd, input.path) === fixture.proof) {
            return yield* scoped(function* () {
              denied = true;
              yield* Permissions.around({
                files: ([verb], pass) => (verb === "read" ? false : pass(verb)),
              });
              return yield* next(input);
            });
          }
          return yield* next(input);
        },
        *writeTextFile([input], next) {
          if (scenario === "final-source" && input.path.endsWith("disposition.json")) {
            yield* writeTextFile(
              join(fixture.repository, "tracked"),
              "source changed before publication\n",
            );
          }
          const written = yield* next(input);
          if (
            scenario === "late-proof" &&
            !proofChanged &&
            input.path.endsWith("disposition.json")
          ) {
            proofChanged = true;
            yield* writeTextFile(
              namedProof.amendment.path,
              "Changed after validation before snapshots.\n",
            );
          }
          return written;
        },
      });
      const result = yield* directRecovery(fixture);
      expect(result).toMatchObject({
        publication: "held",
        continuation: fixture.record.continuation,
      });
      const reservation = join(fixture.ticket, "reconciliations");
      if (scenario === "current-permission") {
        expect(denied).toBe(true);
        expect((yield* API.Fs.operations.stat(reservation)).exists).toBe(false);
      } else {
        const children = yield* API.Fs.operations.readDirectory(reservation);
        const refusal = JSON.parse(
          yield* readTextFile(join(reservation, children[0].name, "publication-refusal.json")),
        );
        expect(refusal.status).toBe("refused");
        expect(refusal.reason).toContain(
          scenario === "final-source"
            ? "Source changed"
            : scenario === "late-proof"
              ? "recovery input changed"
              : "input capacity",
        );
      }
    }
    expect(fixture.native.host.fake.prompts.length).toBe(before);
    return { scenario, refused: true, writes, sourceCommands, noProviderCalls: true };
  });
}
