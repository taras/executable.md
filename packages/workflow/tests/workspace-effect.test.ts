import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { readTextFile } from "@effectionx/fs";
import { glob } from "@executablemd/runtime";
import { type Operation, scoped } from "effection";
import {
  claimDurablePublicationIdentity,
  durableCall,
  durableRun,
  InMemoryStream,
  type DurableEvent,
  type Json,
  type Result,
  type Workflow,
} from "@executablemd/durable-streams";
import { createDurableWorkspaceOperation, WorkspaceCoordinationProviderError } from "../mod.ts";
import {
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../src/workspace/effect.ts";

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function yieldEvents(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield");
}

function* workspaceStep(name: string, execute: () => Operation<Json>): Workflow<void> {
  yield createDurableWorkspaceOperation({ type: "workspace", name }, execute);
}

interface InvocationCollisionApi {
  coordinate(request: unknown): Operation<unknown>;
}

const WorkspaceInvocationCollision = createApi<InvocationCollisionApi>(
  "executablemd.workflow.workspace.coordination.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the collision handler did not delegate");
    },
  },
);

function successfulProvider(observe?: (authority: WorkspaceCoordinationAuthority) => void): {
  provider: WorkspaceCoordinationProvider;
  counts: { providers: number; executions: number; publications: number };
} {
  const counts = { providers: 0, executions: 0, publications: 0 };
  return {
    counts,
    provider: {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        counts.providers += 1;
        observe?.(authority);
        const value = yield* authority.execute();
        counts.executions += 1;
        const result: Result = { status: "ok", value };
        yield* authority.publish(result);
        counts.publications += 1;
        return result;
      },
    },
  };
}

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Every name that would mean a host reached the shared coordination surface.
 *
 * Storage and runtime implementation types, the adapter's private transaction
 * identities, runtime detection, and process globals.
 */
const FORBIDDEN = [
  "DatabaseSync",
  "SQLite",
  "sqlite",
  "Cloudflare",
  "DOFS",
  "dofs",
  "savepoint",
  "Savepoint",
  "SAVEPOINT",
  "RunConnection",
  "WorkflowRunConnections",
  "WorkflowRunTransactionToken",
  "ConnectionGeneration",
  "TransactionIdentity",
  "Deno",
  "Bun",
  "globalThis",
  "navigator",
];

/**
 * A module specifier only one host can resolve.
 *
 * Named by shape rather than one at a time: a list of the host modules anyone
 * thought of is a list of the ones that had already been noticed, and the
 * import that crosses this boundary next is the one nobody wrote down.
 */
function hostModule(specifier: string): boolean {
  return (
    /^(node|bun|deno|cloudflare):/.test(specifier) ||
    specifier.includes("/deno/") ||
    specifier.endsWith("/deno.ts") ||
    specifier.includes("vendor/") ||
    specifier === "@effectionx/process"
  );
}

/**
 * Source with its comments removed.
 *
 * These modules describe in prose that they name no host, and a search of the
 * whole file would find that description rather than a boundary crossing.
 */
function code(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const following = source[index + 1];
    if (character === "/" && following === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && following === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      output += character;
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") {
          output += source[index];
          index += 1;
        }
        output += source[index];
        index += 1;
      }
      output += character;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Every module this source imports, however the import is written. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

function forbiddenNames(source: string): string[] {
  const scanned = code(source);
  const crossings = FORBIDDEN.filter((name) => scanned.includes(name));
  for (const specifier of specifiers(scanned)) {
    if (hostModule(specifier) && !crossings.includes(specifier)) {
      crossings.push(specifier);
    }
  }
  return crossings;
}

describe("Tier DLC — Workspace coordination selection", () => {
  it("DLC10: a missing Workspace provider fails before execution or publication", function* () {
    const stream = new InMemoryStream();
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("missing", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC11: explicit Workspace selection leaves unrelated durable operations ordinary", function* () {
    const stream = new InMemoryStream();
    const publicationIdentity = claimDurablePublicationIdentity(stream);
    const coordinated: string[] = [];
    const ordinary: string[] = [];
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        expect(authority.publicationIdentity).toBe(publicationIdentity);
        expect(Reflect.get(authority.publicationIdentity ?? {}, "append")).toBe(undefined);
        expect(Reflect.get(authority.publicationIdentity ?? {}, "readAll")).toBe(undefined);
        coordinated.push("workspace");
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* workspaceStep("selected", function* () {
        return "workspace";
      });
      yield* durableCall("ordinary", function* () {
        ordinary.push("ordinary");
        return "ordinary";
      });
      return "done";
    }

    expect(
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
    ).toBe("done");
    expect(coordinated).toEqual(["workspace"]);
    expect(ordinary).toEqual(["ordinary"]);
    expect(yieldEvents(stream.snapshot())).toHaveLength(2);
  });

  it("DLC12: replayed Workspace operations never require a live provider", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "workspace", name: "replayed" },
        result: { status: "ok", value: "stored" },
      },
    ]);
    let executions = 0;
    function* workflow(): Workflow<string> {
      yield* workspaceStep("replayed", function* () {
        executions += 1;
        return "live";
      });
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(executions).toBe(0);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC13: the whole shared coordination surface stays runtime-neutral", function* () {
    // The scanner has to be able to fail, and it has to read code rather than
    // prose: these modules explain in their own comments that they name no
    // host, and a substring search would find the explanation.
    expect(code(`const value = "DOFS"; // Cloudflare\n/* SQLite */`)).toBe(
      `const value = "DOFS"; \n`,
    );
    expect(forbiddenNames(`import { DatabaseSync } from "node:sqlite";`)).toEqual([
      "DatabaseSync",
      "sqlite",
      "node:sqlite",
    ]);
    expect(forbiddenNames("// the Deno adapter owns DOFS and its savepoints")).toEqual([]);

    // A host module is a crossing by its shape, not because someone listed it.
    // `node:crypto` names nothing else on this list, and shared source did
    // import it while an earlier version of this test reported a clean
    // boundary.
    expect(forbiddenNames(`import { randomUUID } from "node:crypto";`)).toEqual(["node:crypto"]);
    expect(forbiddenNames(`export { x } from "node:os";`)).toEqual(["node:os"]);
    expect(forbiddenNames(`const m = await import("bun:sqlite");`)).toEqual([
      "sqlite",
      "bun:sqlite",
    ]);
    expect(forbiddenNames(`import "../deno.ts";`)).toEqual(["../deno.ts"]);
    expect(forbiddenNames("// run ids used to come from node:crypto")).toEqual([]);
    expect(forbiddenNames(`const note = "node:crypto";`)).toEqual([]);

    const found = (yield* glob({
      root: REPOSITORY,
      patterns: [
        "packages/workflow/mod.ts",
        "packages/workflow/src/**/*.ts",
        "packages/durable-streams/*.ts",
      ],
      // Whole packages rather than named modules, so a coordination module
      // added later is covered without this list being remembered. The single
      // exception carries its reason: the HTTP stream is a client for a remote
      // durable stream and reaches the platform's own `fetch`.
      exclude: ["packages/workflow/src/deno/**", "packages/durable-streams/http-stream.ts"],
    }))
      .map((entry) => entry.path)
      .sort();

    // A pattern that matched nothing would report a clean boundary, so the
    // surface every Workspace effect actually crosses is named here.
    expect(found).toEqual(
      expect.arrayContaining([
        "packages/durable-streams/durability.ts",
        "packages/durable-streams/effect.ts",
        "packages/durable-streams/guard.ts",
        "packages/durable-streams/live-coordinator.ts",
        "packages/durable-streams/types.ts",
        "packages/workflow/mod.ts",
        "packages/workflow/src/storage/api.ts",
        "packages/workflow/src/workspace/api.ts",
        "packages/workflow/src/workspace/effect.ts",
      ]),
    );
    expect(found.some((path) => path.includes("/src/deno/"))).toBe(false);

    const crossings: Record<string, string[]> = {};
    for (const path of found) {
      const names = forbiddenNames(yield* readTextFile(join(REPOSITORY, path)));
      if (names.length > 0) {
        crossings[path] = names;
      }
    }
    expect(crossings).toEqual({});
  });

  it("DLC15: live Workspace invocation authority is one-shot", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    let executions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        capturedAuthority = authority;
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("one-shot", function* () {
        executions += 1;
        return null;
      });
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive its live invocation authority");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "late" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    const activationFailure = yield* raised(
      capturedAuthority.activateFailure(new Error("late activation")),
    );
    expect(activationFailure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(1);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC17: a forged contextual result cannot complete or resume a live invocation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    let laterExecutions = 0;
    function* workflow(): Workflow<void> {
      try {
        yield* workspaceStep("forged-result", function* () {
          return "not reached";
        });
      } catch {
        // The durable fail-stop boundary, rather than workflow recovery, decides termination.
      }
      yield* durableCall("after-forgery", function* () {
        laterExecutions += 1;
        return null;
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        // deno-lint-ignore require-yield
        *coordinate(): Operation<unknown> {
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(counts).toEqual({ providers: 0, executions: 0, publications: 0 });
    expect(laterExecutions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC18: invocation phases are unreachable without a selected provider", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    let collisionCalls = 0;
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("direct-phases", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          collisionCalls += 1;
          return yield* next(...args);
        },
      });
      return yield* raised(durableRun(workflow, { stream }));
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(collisionCalls).toBe(0);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC19: contextual middleware cannot replace the authoritative published Result", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    function* workflow(): Workflow<string> {
      const result = yield createDurableWorkspaceOperation(
        { type: "workspace", name: "replace-result" },
        function* () {
          return "authoritative";
        },
      );
      if (typeof result !== "string") {
        throw new Error("the Workspace operation did not return its string result");
      }
      return result;
    }

    const value = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          yield* next(...args);
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(value).toBe("authoritative");
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toEqual([
      expect.objectContaining({ result: { status: "ok", value: "authoritative" } }),
    ]);
  });

  it("DLC20: post-completion middleware cannot suppress, throw, or duplicate work", function* () {
    for (const behavior of ["suppress", "throw", "duplicate"]) {
      const stream = new InMemoryStream();
      claimDurablePublicationIdentity(stream);
      const { provider, counts } = successfulProvider();
      function* workflow(): Workflow<string> {
        const result = yield createDurableWorkspaceOperation(
          { type: "workspace", name: behavior },
          function* () {
            return behavior;
          },
        );
        if (typeof result !== "string") {
          throw new Error("the Workspace operation did not return its string result");
        }
        return result;
      }

      const value = yield* scoped(function* () {
        yield* WorkspaceInvocationCollision.around({
          *coordinate(args, next): Operation<unknown> {
            const response = yield* next(...args);
            if (behavior === "throw") {
              throw new Error("post-completion middleware failure");
            }
            if (behavior === "duplicate") {
              yield* next(...args);
            }
            return behavior === "suppress" ? { type: "published" } : response;
          },
        });
        return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
      });

      expect(value).toBe(behavior);
      expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
      expect(yieldEvents(stream.snapshot())).toHaveLength(1);
    }
  });

  it("DLC21: retained contextual continuation cannot reuse a completed invocation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    let retained: ((request: unknown) => Operation<unknown>) | undefined;
    let retainedRequest: unknown;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("retained-continuation", function* () {
        return null;
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          retained = (request) => next(request);
          retainedRequest = args[0];
          return yield* next(...args);
        },
      });
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });
    if (retained === undefined) {
      throw new Error("the collision middleware did not retain its continuation");
    }

    expect(yield* raised(retained(retainedRequest))).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC22: minimum-priority collision middleware receives no invocation capability", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    const observed: unknown[] = [];
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-priority", function* () {
        return "published";
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(args): Operation<unknown> {
            observed.push(args[0]);
            return { type: "published" };
          },
        },
        { at: "min" },
      );
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(observed).toEqual([]);
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC23: minimum-priority middleware cannot replace first-failure activation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const first = new Error("authoritative infrastructure failure");
    let activated: Error | undefined;
    let collisions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        activated = yield* authority.activateFailure(first);
        throw activated;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-failure", function* () {
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(): Operation<unknown> {
            collisions += 1;
            return { type: "failure", failure: new Error("replacement") };
          },
        },
        { at: "min" },
      );
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(collisions).toBe(0);
    expect(activated).toBe(first);
    expect(failure).toBe(first);
    expect(stream.snapshot()).toEqual([]);
  });
});
