import { useArtifactReturnHost } from "./artifact-return-deno.ts";
import { collect, execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { state } from "../../../components/Ticket/control.ts";

export const props = {
  type: "object",
  properties: {
    fixture: { type: "object" },
    mode: { enum: ["changed", "removed", "missing"] },
  },
  required: ["fixture", "mode"],
  additionalProperties: false,
};
const example = fileURLToPath(new URL("../../../", import.meta.url));
const resultSchema = z.object({
  handoff: z.string(),
  apiConflict: z.record(z.string(), z.json()),
  artifacts: z.array(z.string()),
  evidence: z.array(z.json()),
});
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
export default function* RetainedRepair(value: unknown) {
  const { fixture, mode } = z.object({
    fixture: z.object({
      root: z.string(),
      directory: z.string(),
      repository: z.string(),
    }),
    mode: z.enum(["changed", "removed", "missing"]),
  }).parse(value);
  yield* useArtifactReturnHost(fixture.root, fixture.repository);
  let accepted: z.infer<typeof resultSchema> | undefined;
  let saved: z.infer<typeof state> | undefined;
  yield* API.Files.around({
    *readTextFile([input], next) {
      const result = yield* next(input);
      if (
        accepted === undefined && result.ok &&
        input.cwd.includes("/migration-0/continuations")
      ) {
        const parsed = state.safeParse(JSON.parse(result.value));
        if (
          parsed.success &&
          parsed.data.checkpoint.hold?.kind === "needs_discovery"
        ) {
          saved = parsed.data;
          const path = saved.calls.at(-1)?.result;
          check(
            path !== undefined && path !== null,
            "missing accepted call result",
          );
          if (path === undefined || path === null) {
            throw new Error("Missing result");
          }
          accepted = resultSchema.parse(JSON.parse(yield* readTextFile(path)));
          if (mode === "removed") {
            yield* rm(path);
          } else {
            yield* writeTextFile(
              path,
              JSON.stringify({
                ...accepted,
                handoff: "REPLACEMENT request",
                apiConflict: { observed: "REPLACEMENT conflict" },
              }),
            );
          }
          if (mode === "missing") {
            yield* rm(saved.documents[path].snapshot);
          }
        }
      }
      return result;
    },
  });
  const task = {
    work: "test",
    repository: fixture.repository,
    directory: fixture.directory,
    request: "api-repair",
    inputs: [],
    sessions: {
      planner: "original-planner",
      implementor: "original-implementor",
      architect: "conditional-architect",
    },
    providers: { architect: "codex", planner: "claude", implementor: "claude" },
    maxCorrections: 1,
    maxResponseCorrections: 3,
    maxApiRepairs: 1,
  };
  const source = `<Adversarial.Run task={${
    JSON.stringify(task)
  }} plannerGuide={${
    JSON.stringify({
      path: fixture.root + "/planner.md",
      content: "Planner test instructions.",
    })
  }} implementorGuide={${
    JSON.stringify({
      path: fixture.root + "/implementor.md",
      content: "Implementor test instructions.",
    })
  }} as="work" /><Output><Json value={{status:work.status,reason:work.reason ?? null,history:work.history}} /></Output>`;
  const output = yield* collect(
    yield* execute({
      ...inlineSource(source),
      includes: [example + "/tests/components", example + "/components"],
      stream: new InMemoryStream(),
    }),
  );
  const work = z.object({
    status: z.string(),
    reason: z.unknown(),
    history: z.array(z.json()),
  }).parse(JSON.parse(String(output)));
  check(
    accepted !== undefined && saved !== undefined,
    "actual settled migration consumer was not intercepted",
  );
  const nextPath = fixture.directory + "/foundation-2/called.json";
  if (mode === "missing") {
    check(
      work.status === "hold" && !(yield* exists(nextPath)),
      "missing retained evidence dispatched repair",
    );
    check(
      String(work.reason).includes("retained role result"),
      "hold did not name retained evidence",
    );
  } else {
    check(
      work.status === "feedback_ready",
      "retained repair did not finish: " + JSON.stringify(work),
    );
    const called = z.object({
      session: z.string(),
      initialize: z.boolean(),
      conflict: z.json(),
    }).parse(JSON.parse(yield* readTextFile(nextPath)));
    check(
      called.session === "original-planner" && !called.initialize,
      "repair replaced the original Planner",
    );
    check(
      JSON.stringify(called.conflict) ===
        JSON.stringify({
          ...accepted?.apiConflict,
          artifacts: accepted?.artifacts,
          evidence: accepted?.evidence,
          request: accepted?.handoff,
        }),
      "repair used replacement original result",
    );
    const migration = z.object({ session: z.string(), initialize: z.boolean() })
      .parse(
        JSON.parse(
          yield* readTextFile(
            fixture.directory + "/migration-1/attempts/0000/called.json",
          ),
        ),
      );
    check(
      migration.session === "original-implementor" && !migration.initialize,
      "repair reset the Implementor",
    );
  }
  check(
    saved?.calls.length === 1 && saved.manifest.maxApiRepairs === 1 &&
      saved.manifest.maxCorrections === 1 &&
      saved.manifest.maxResponseCorrections === 3,
    "repair changed call or correction standing",
  );
  return { mode, status: work.status };
}
