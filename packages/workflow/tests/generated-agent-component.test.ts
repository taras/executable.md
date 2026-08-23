/**
 * Tier WGAC — `<Evaluate source={…} />`, the registered generated-XMD boundary
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The claim under test is the split between availability and authority.
 * Registering the component is what makes the operation reachable from a
 * trusted workflow document; it carries none of the ceilings the operation runs
 * under, and nothing a document writes can supply or widen one.
 *
 * So these drive the real component through a real attachment against a real
 * run database. A stand-in for the run's storage would be a stand-in for the
 * exact thing being claimed: that the roots come from the run rather than from
 * the element.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  collect,
  Component,
  content,
  execute,
  inlineSource,
  registerComponents,
  retainedSource,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { createContext } from "effection";
import type { Context } from "effection";
import type { Json, Workflow } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../mod.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../src/deno/workspace/host.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import { createEvaluate } from "../src/deno/workspace/evaluate.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";

/**
 * The engine's expansion context, addressed by the name it publishes under.
 *
 * Reconstructed here on purpose: a context is identified by its name, so any
 * loaded copy — a repository `.ts` component, a middleware package — can bind
 * this one for its descendants. That is the reach this probe exercises.
 */
const CurrentExpansion: Context<{ id: string; name: string } | undefined> = createContext<
  { id: string; name: string } | undefined
>("expand.current", undefined);

/** What a loaded component publishes, and what the engine hands. */
const FORGED = "published-identity";
const HANDED = "handed-identity";

const URL_ADMITTED = "https://api.example.test/admitted";
const URL_OTHER = "https://api.example.test/other";

/** What the substituted transport was asked to perform. */
interface Transport {
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
}

function* useTransport(): Operation<Transport> {
  const performed: Transport["performed"] = [];
  yield* API.Fetch.around(
    {
      // deno-lint-ignore require-yield
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        performed.push({ url, init });
        return {
          status: 200,
          headers: { get: () => null, entries: () => [] },
          // deno-lint-ignore require-yield
          *text(): Operation<string> {
            return "answered";
          },
        };
      },
    },
    { at: "min" },
  );
  return { performed };
}

interface Attempt {
  output?: Json;
  failure?: string;
  events: DurableEvent[];
  performed: Transport["performed"];
}

/**
 * Run one document with this run's Workspace attached.
 *
 * The contextual working directory is pinned somewhere the run may not reach and
 * a host Files provider is installed outside the attachment, so any read that
 * fell through to the caller's filesystem would fail rather than quietly
 * succeed.
 */
function runDocument(
  database: WorkflowRunDatabase,
  source: string,
  options: WorkflowWorkspaceOptions = {},
): Operation<Attempt> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return "/nowhere-the-workflow-may-reach";
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    const transport = yield* useTransport();
    let output: Json | undefined;
    let failure: string | undefined;
    try {
      output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* execute({ ...inlineSource(source), stream: database.journal }),
          );
        }),
        options,
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const events = yield* database.journal.readAll();
    return {
      ...(output === undefined ? {} : { output }),
      ...(failure === undefined ? {} : { failure }),
      events,
      performed: transport.performed,
    };
  });
}

/** Every generated-XMD admission this run recorded. */
function admissions(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** The policy one admission was recorded under, as the journal holds it. */
function policyOf(event: DurableEvent): Record<string, Json> | undefined {
  if (event.type !== "yield") {
    return undefined;
  }
  const input = event.description.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input;
}

/**
 * What the run reported, whether it rendered it or failed with it.
 *
 * A refused observation is not printed — `<Evaluate>` is deliberately not
 * wrapped in `printErrors`, so a refusal stops the authored document rather than
 * becoming text the next turn could read as an observation. Which of the two
 * happened is asserted separately where it matters.
 */
function reported(attempt: Attempt): string {
  if (attempt.failure !== undefined) {
    return attempt.failure;
  }
  return typeof attempt.output === "string" ? attempt.output : JSON.stringify(attempt.output);
}

/** Put one file in the run's Workspace, the way an earlier step would have. */
function* plant(database: WorkflowRunDatabase, path: string, content: string): Operation<void> {
  const written = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* workspace.filesystem.writeFile(`/${path}`, content);
    const root = yield* workspace.capture();
    yield* workspace.publish(root.rootId);
  });
  if (!written.ok) {
    throw written.error;
  }
}

describe("Tier WGAC — the registered Evaluate component", () => {
  it("WGAC3: it takes only `source`, and refuses content", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      // Paired content: a `source` this element rendered is not a fragment
      // anybody handed it.
      const paired = yield* runDocument(
        database,
        `<Evaluate source="text">\n<File path="notes.md" />\n</Evaluate>\n`,
      );
      expect(reported(paired)).toContain("renders no content of its own");
      expect(admissions(paired.events)).toHaveLength(0);
    });

    const second = yield* useStorageRoot();
    yield* withStorage(second, function* () {
      const database = yield* createRun();
      // A closed schema: nothing beside `source` is accepted, so a document
      // cannot state a root, an identity or a request here.
      const widened = yield* runDocument(
        database,
        `<Evaluate source="text" selectedRoot="workspace://elsewhere" />\n`,
      );
      expect(reported(widened)).toMatch(/selectedRoot|additional/i);
      expect(admissions(widened.events)).toHaveLength(0);
    });

    const third = yield* useStorageRoot();
    yield* withStorage(third, function* () {
      const database = yield* createRun();
      const missing = yield* runDocument(database, `<Evaluate />\n`);
      expect(reported(missing)).toMatch(/source/i);
      expect(admissions(missing.events)).toHaveLength(0);
    });
  });

  it("WGAC4: the roots come from the run, and follow it as it moves", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      // Two observations with a Workspace write between them. The write
      // publishes a new root, so the second observation is admitted against a
      // different current root than the first — which is what makes this a test
      // of "the root this run is on" rather than "some root this run retains".
      const attempt = yield* runDocument(
        database,
        `<Evaluate source={'<File path="notes.md" />'} as="first" />\n\n` +
          `<File path="between.md">written between observations</File>\n\n` +
          `<Evaluate source={'<File path="notes.md" />'} as="second" />\n\n` +
          `<Json value={second} />\n`,
      );

      expect(attempt.failure).toBe(undefined);
      // Both observations read the run's own Workspace, through the ordinary
      // transaction-bound Files provider. `<Evaluate>` answers with a value, so
      // the document renders it where it wants text — which is what `<Json>` is
      // for, and what the representative document does into its next prompt.
      expect(reported(attempt)).toContain("the retained note");
      expect(reported(attempt)).toContain('"name": "File"');

      const recorded = admissions(attempt.events);
      expect(recorded).toHaveLength(2);
      const first = policyOf(recorded[0]!);
      const second = policyOf(recorded[1]!);

      // The run moved between them, and the stated ceiling moved with it.
      expect(typeof first?.selectedRoot).toBe("string");
      expect(second?.selectedRoot).not.toBe(first?.selectedRoot);

      // And the last one is the run's authoritative current root, read back
      // independently rather than from the record under test.
      const current = yield* transactWorkspaceRoots(database, (workspace) =>
        workspace.currentRoot(),
      );
      expect(current.ok).toBe(true);
      expect(second?.selectedRoot).toBe(current.ok ? current.value : undefined);

      const retained = Array.isArray(second?.roots) ? second.roots : [];
      expect(retained.length).toBeGreaterThan(1);
      expect(retained).toContain(second?.selectedRoot);
      // Deterministic order, because a continuation compares these positionally.
      expect(retained).toEqual([...retained].sort());
    });
  });

  it("WGAC4: generated source cannot reach this registration, live though it is", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      // `Evaluate` is a live registered component in this very scope. The
      // fragment still cannot name it: the evaluator resolves only its own
      // closed table of pinned identities, and consults no registration at all.
      // Were it otherwise, generated source could re-enter the host boundary and
      // state its own ceilings.
      const attempt = yield* runDocument(
        database,
        `<Evaluate source={'<Evaluate source="<File path=\\'notes.md\\' />" />'} />\n`,
      );

      expect(reported(attempt)).toContain("did not admit");
      // One admission, and it refused. No second one from a nested evaluation.
      expect(admissions(attempt.events)).toHaveLength(1);
      expect(reported(attempt)).not.toContain("the retained note");
    });
  });

  it("WGAC6: two Evaluate sites stay distinct under a component that rebinds what it can", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      const attempt = yield* scoped(function* () {
        // A loaded component that binds the expansion context for its
        // descendants. An Effection context is addressed by name, so this is a
        // thing any component or middleware package can do — which is exactly
        // why a durable name may not be read from one.
        yield* registerComponents([
          {
            name: "Forge",
            origin: "test://forge",
            props: { type: "object", properties: {}, additionalProperties: false },
            *fn(): Operation<string> {
              yield* CurrentExpansion.set({ id: "forged-identity", name: "Evaluate" });
              // And the composable channel a component *does* have: content
              // projection runs inside this frame, so anything reachable from a
              // Context or a contextual Api handler installed here is reachable
              // from the `<Evaluate>` sites below.
              yield* Component.around({
                // deno-lint-ignore require-yield
                *hasContent(_args, _next) {
                  return false;
                },
              });
              return yield* content();
            },
          },
        ]);
        return yield* runDocument(
          database,
          `<Forge>\n<Evaluate source={'<File path="notes.md" />'} />\n\n` +
            `<Evaluate source={'<File path="notes.md" />'} />\n</Forge>\n`,
        );
      });

      expect(attempt.failure).toBe(undefined);
      const recorded = admissions(attempt.events);
      expect(recorded).toHaveLength(2);

      // Two sites, two durable names. One shared name would make the second
      // site replay the first site's admitted fragment.
      const names = recorded.map((event) => (event.type === "yield" ? event.description.name : ""));
      expect(new Set(names).size).toBe(2);
      // And neither of them is the identity the component published.
      for (const name of names) {
        expect(name).not.toContain("forged-identity");
      }
    });
  });

  it("WGAC7: the durable name is the invocation the engine handed, not the published context", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      // The implementation, invoked the way the engine invokes it, with the two
      // identities deliberately pulled apart: a forged expansion context saying
      // one thing and the engine's own argument saying another. Through the
      // engine they always agree, because it republishes the context for each
      // invocation it enters — which is exactly why agreeing there proves
      // nothing about which one is load-bearing.
      const evaluate = createEvaluate(database, {});
      const events = yield* scoped(function* () {
        yield* useHostFiles();
        yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            // What the engine supplies at an invocation, supplied here because
            // the call below stands in for one. Note which side of the seam it
            // is on: `hasContent()` is the composable channel and a caller can
            // answer it; the identity is the argument, which nothing composes.
            yield* Component.around({
              // deno-lint-ignore require-yield
              *hasContent(_args, _next) {
                return false;
              },
            });
            yield* CurrentExpansion.set({ id: FORGED, name: "Evaluate" });

            // The trusted-host seam: inside the durable execution, outside any
            // component invocation, which is the only place the two identities
            // can be handed apart.
            const execution = yield* executeInstalled(
              {
                ...retainedSource("workflows/probe.md", "The host evaluated a fragment.\n"),
                stream: database.journal,
              },
              [
                {
                  *prepare(): Workflow<void> {
                    yield* evaluate({ source: `<File path="notes.md" />` }, { id: HANDED });
                  },
                },
              ],
            );
            const result = yield* execution;
            if (!result.ok) {
              throw result.error;
            }
          }),
        );
        return yield* database.journal.readAll();
      });

      const recorded = admissions(events);
      expect(recorded).toHaveLength(1);
      const name = recorded[0]?.type === "yield" ? recorded[0].description.name : "";
      // Named after what the engine handed, and after nothing that was published.
      expect(name).toContain(HANDED);
      expect(name).not.toContain(FORGED);
    });
  });

  it("WGAC5: the exact Fetch ceiling is the host's, and an empty one admits no request", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      // No configured requests: `<Fetch>` is not on the allowlist at all.
      const refused = yield* runDocument(
        database,
        `<Evaluate source={'<Fetch url="${URL_ADMITTED}" />'} />\n`,
      );
      expect(reported(refused)).toContain("did not admit");
      expect(refused.performed).toHaveLength(0);
    });

    const second = yield* useStorageRoot();
    yield* withStorage(second, function* () {
      const database = yield* createRun();
      const attempt = yield* runDocument(
        database,
        `<Evaluate source={'<Fetch url="${URL_ADMITTED}" />'} />\n`,
        { evaluation: { requests: [{ url: URL_ADMITTED }] } },
      );
      expect(attempt.failure).toBe(undefined);
      expect(attempt.performed.map((call) => call.url)).toEqual([URL_ADMITTED]);
    });

    const third = yield* useStorageRoot();
    yield* withStorage(third, function* () {
      const database = yield* createRun();
      // A different request under the same ceiling performs nothing.
      const outside = yield* runDocument(
        database,
        `<Evaluate source={'<Fetch url="${URL_OTHER}" />'} />\n`,
        { evaluation: { requests: [{ url: URL_ADMITTED }] } },
      );
      expect(reported(outside)).toContain("did not admit");
      expect(outside.performed).toHaveLength(0);
    });
  });
});
