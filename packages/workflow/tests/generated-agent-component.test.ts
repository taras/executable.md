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
import { scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import type { ComponentInvocation } from "@executablemd/core";
import {
  collect,
  Component,
  content,
  execute,
  inlineSource,
  registerComponents,
} from "@executablemd/core";
import { createContext } from "effection";
import type { Context } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../mod.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../src/deno/workspace/host.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
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

const URL_ADMITTED = "https://api.example.test/admitted";
/** What the fixture's first site observes, and what its record must restore. */
const ADMITTED_NOTE = "the alpha note as admitted\n";
const URL_OTHER = "https://api.example.test/other";

/** What the substituted transport was asked to perform. */
interface Transport {
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
}

function* useTransport(hold?: () => Operation<void>): Operation<Transport> {
  const performed: Transport["performed"] = [];
  yield* API.Fetch.around(
    {
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        performed.push({ url, init });
        if (hold !== undefined) {
          yield* hold();
        }
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
  hold?: () => Operation<void>,
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
    const transport = yield* useTransport(hold);
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

/** Every request this run actually performed, as the journal holds it. */
function performances(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === "fetch");
}

/** Every Workspace read this run actually performed. */
function reads(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "workspace_file",
  );
}

/** The fragment one admission recorded, as the journal holds its result. */
function admittedSource(event: DurableEvent): string | undefined {
  const result: unknown = event.result;
  if (typeof result !== "object" || result === null || !("value" in result)) {
    return undefined;
  }
  const value: unknown = (result as { value: unknown }).value;
  if (typeof value !== "object" || value === null || !("source" in value)) {
    return undefined;
  }
  const source: unknown = (value as { source: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

/** The durable name one admission was recorded under. */
function nameOf(event: DurableEvent): string {
  return event.type === "yield" ? event.description.name : "";
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

/**
 * The adversarial wrapper, installed the way a middleware package would.
 *
 * `Component.importComponent` is public: a handler may delegate the import,
 * receive the definition the workflow host registered, and return one of its
 * own that calls the original. `choose` is what it hands over in place of
 * the invocation the engine entered.
 */
/** What the registered `<Evaluate>` implementation is, to a caller holding it. */
type EvaluateImplementation = (
  props: Record<string, Json>,
  invocation: ComponentInvocation,
) => Operation<unknown>;

function* interpose(
  choose: (invocation: ComponentInvocation, name: string) => ComponentInvocation,
  targets: readonly string[] = ["Evaluate"],
): Operation<void> {
  yield* Component.around({
    *importComponent([name], next) {
      const definition = yield* next(name);
      if (!targets.includes(name) || definition.kind !== "function") {
        return definition;
      }
      const original = definition.fn;
      if (typeof original !== "function") {
        return definition;
      }
      return {
        ...definition,
        *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
          return yield* original(props, choose(invocation, name));
        },
      };
    },
  });
}

function* fixture(name = "two-observations"): Operation<string> {
  return yield* readTextFile(fileURLToPath(new URL(`./fixtures/${name}.md`, import.meta.url)));
}

/**
 * A self-closing component that is not an observation site.
 *
 * Registered on its own terms and naming nothing durable: it is somewhere for a
 * kept implementation to be called from.
 */
function* useElsewhere(): Operation<void> {
  yield* registerComponents([
    {
      name: "Elsewhere",
      origin: "test://elsewhere",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        return "";
      },
    },
  ]);
}

/**
 * A content-bearing parent, registered the way a package registers one.
 *
 * It renders what the document wrote inside it, so its own invocation is open —
 * genuine, live and unspent — for the whole time the sites in its content are
 * running.
 */
function* useFrame(): Operation<void> {
  yield* registerComponents([
    {
      name: "Frame",
      origin: "test://frame",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        return yield* content();
      },
    },
  ]);
}

/**
 * Give `<Frame>` the claim domain `<Evaluate>` was registered with.
 *
 * Middleware can read a definition's domain by delegating an import, and
 * attaching it here is deliberate: it takes the domain out of the argument, so
 * what refuses a claim from inside the content is that the parent is expanding
 * it, and nothing else.
 */
function* borrowFrameDomain(): Operation<void> {
  yield* Component.around({
    *importComponent([name], next) {
      const definition = yield* next(name);
      if (name !== "Frame" || definition.kind !== "function") {
        return definition;
      }
      const evaluate = yield* next("Evaluate");
      return evaluate.kind === "function" && evaluate.claim !== undefined
        ? { ...definition, claim: evaluate.claim }
        : definition;
    },
  });
}

/**
 * What the second site is allowed to reach.
 *
 * The fixture's two sites observe different things on purpose — one reads
 * the run's Workspace, one performs the single admitted request — so a
 * replay that restored the wrong record would be visible as the wrong kind
 * of observation, not merely as the wrong text.
 */
const CEILING: WorkflowWorkspaceOptions = {
  evaluation: { requests: [{ url: URL_ADMITTED }] },
};

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

  describe("WGAC7: the durable name survives the import boundary", () => {
    it("refuses an invocation the wrapper built", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          // A structural stand-in — which is what the identity used to be, and
          // what a wrapper would mint to give both sites one durable name.
          yield* interpose(() => ({}));
          return yield* runDocument(database, source, CEILING);
        });

        expect(reported(attempt)).toContain("not an invocation the engine issued");
        // Refused before any admission: nothing was named, so nothing collapsed.
        expect(admissions(attempt.events)).toHaveLength(0);
      });
    });

    it("refuses the first site's invocation routed at the second", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          // Ordinary delegation at the first site, then the first site's own
          // invocation handed to the second — the substitution that would make
          // both sites replay one admitted fragment.
          let kept: ComponentInvocation | undefined;
          yield* interpose((invocation) => {
            kept ??= invocation;
            return kept;
          });
          return yield* runDocument(database, source, CEILING);
        });

        expect(reported(attempt)).toMatch(/already been taken|has finished/);
        // The first site was admitted under its own name. The second was
        // refused rather than admitted under the first site's.
        expect(admissions(attempt.events)).toHaveLength(1);
      });
    });

    it("admits each site under its own name when the wrapper delegates", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          // Forwarding the genuine issuance: ordinary delegation, and it stays
          // supported.
          yield* interpose((invocation) => invocation);
          return yield* runDocument(database, source, CEILING);
        });

        expect(attempt.failure).toBe(undefined);
        const recorded = admissions(attempt.events);
        expect(recorded).toHaveLength(2);
        expect(new Set(recorded.map(nameOf)).size).toBe(2);

        // Each site rendered what it observed, and the two differ — one durable
        // name between them would print one of these twice.
        expect(reported(attempt)).toContain(ADMITTED_NOTE.trim());
        expect(reported(attempt)).toContain("answered");
      });
    });

    it("refuses a live parent's invocation routed into the sites inside it", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture("nested-observations");
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          yield* useFrame();
          yield* borrowFrameDomain();
          // `<Frame>` is still running — it has not returned, and it never
          // claimed anything — so its issuance is genuine, live and unspent
          // while the sites in its content run. Routing it there is the
          // substitution a spent or finished sibling's does not reach.
          let parent: ComponentInvocation | undefined;
          yield* interpose(
            (invocation, name) => {
              if (name === "Frame") {
                parent = invocation;
                return invocation;
              }
              return parent ?? invocation;
            },
            ["Frame", "Evaluate"],
          );
          return yield* runDocument(database, source, CEILING);
        });

        expect(reported(attempt)).toContain("expanding its own content");
        // Refused before admission: no record was written under the parent's
        // identity, so nothing can replay under its retained history.
        expect(admissions(attempt.events)).toHaveLength(0);
        expect(attempt.performed).toEqual([]);
      });
    });

    it("keeps each site's own identity under the same live parent", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture("nested-observations");
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          yield* useFrame();
          // The same document and the same parent, forwarding honestly. Being
          // nested changes nothing about what each site is named.
          yield* interpose((invocation) => invocation, ["Frame", "Evaluate"]);
          return yield* runDocument(database, source, CEILING);
        });

        expect(attempt.failure).toBe(undefined);
        const recorded = admissions(attempt.events);
        expect(recorded).toHaveLength(2);
        expect(new Set(recorded.map(nameOf)).size).toBe(2);
        expect(reported(attempt)).toContain(ADMITTED_NOTE.trim());
        expect(attempt.performed.map((call) => call.url)).toEqual([URL_ADMITTED]);
      });
    });

    it("refuses the registered implementation, kept and called from another element", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture("borrowed-observation");
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        const attempt = yield* scoped(function* () {
          yield* useElsewhere();
          // The definition `importComponent` hands out at the real `<Evaluate>`
          // site, kept and called at `<Elsewhere />` with that element's own
          // genuine, live, unspent issuance — projecting nothing, since it is
          // self-closing. Everything but the domain checks out.
          let kept: EvaluateImplementation | undefined;
          yield* Component.around({
            *importComponent([name], next) {
              const definition = yield* next(name);
              if (definition.kind !== "function") {
                return definition;
              }
              const original = definition.fn;
              if (typeof original !== "function") {
                return definition;
              }
              if (name === "Evaluate") {
                kept = original as EvaluateImplementation;
                return definition;
              }
              if (name !== "Elsewhere") {
                return definition;
              }
              return {
                ...definition,
                *fn(_props: Record<string, Json>, invocation: ComponentInvocation) {
                  const borrowed = kept;
                  if (borrowed === undefined) {
                    return "";
                  }
                  // A fragment that would perform a request, so a borrowed
                  // admission would be visible as one.
                  return yield* borrowed({ source: `<Fetch url="${URL_ADMITTED}" />` }, invocation);
                },
              };
            },
          });
          return yield* runDocument(database, source, CEILING);
        });

        expect(reported(attempt)).toContain("invocation of something else");
        // The real site was admitted, and nothing else was: no second record,
        // and no request under an identity the author wrote no observation at.
        const recorded = admissions(attempt.events);
        expect(recorded).toHaveLength(1);
        expect(admittedSource(recorded[0]!)).toBe(`<File path="alpha.md" />`);
        expect(attempt.performed).toEqual([]);
      });
    });

    it("resumes an interrupted run into each site's own record", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* plant(database, "alpha.md", ADMITTED_NOTE);

        // Interrupted inside the second site's request, which is after the
        // first site's admission committed and before the second's did. A
        // barrier rather than a delay: the transport being called is the run
        // telling us where it is.
        const reached = withResolvers<void>();
        const first = yield* spawn(() =>
          runDocument(database, source, CEILING, function* () {
            reached.resolve();
            yield* suspend();
          }),
        );
        yield* reached.operation;
        yield* first.halt();

        // Both fragments were admitted — an admission is the decision, and the
        // effects it authorized come after it. What the interruption caught is
        // the second site's request, which never happened.
        const interrupted = yield* database.journal.readAll();
        const admitted = admissions(interrupted);
        expect(admitted).toHaveLength(2);
        expect(new Set(admitted.map(nameOf)).size).toBe(2);
        expect(performances(interrupted)).toEqual([]);

        const resumed = yield* runDocument(database, source, CEILING);
        expect(resumed.failure).toBe(undefined);

        // The first site came back from its own record: its retained read is
        // the only one this run holds, so nothing re-observed the Workspace.
        expect(reported(resumed)).toContain(ADMITTED_NOTE.trim());
        expect(reads(resumed.events)).toEqual(reads(interrupted));
        // The second site performed the request the interruption caught it in.
        // Two sites sharing one durable name would have restored the first
        // site's fragment here and reached no transport at all.
        expect(resumed.performed.map((call) => call.url)).toEqual([URL_ADMITTED]);
        expect(reported(resumed)).toContain("answered");

        // The same two records the interrupted attempt wrote, unchanged: the
        // resume restored them rather than admitting anything a second time.
        expect(admissions(resumed.events)).toEqual(admitted);
      });
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
