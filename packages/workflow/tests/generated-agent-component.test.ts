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
import { executeInstalled } from "@executablemd/core/host";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import type { ComponentInvocation } from "@executablemd/core";
import { collect, Component, content, inlineSource, registerComponents } from "@executablemd/core";
import { createContext } from "effection";
import type { Context } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { ComponentRegistry, RegistryEntry } from "@executablemd/core";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../mod.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import { evaluationComponents } from "../src/deno/workspace/evaluate.ts";
import type { GeneratedEvaluationOptions } from "../src/deno/workspace/evaluate.ts";
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
  evaluation: GeneratedEvaluationOptions = {},
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
            yield* executeInstalled(
              { ...inlineSource(source), stream: database.journal },
              // `<Evaluate>` names durable work after its own invocation, so
              // this run declares it to the execution and canonical execution
              // builds it from the claimant it minted for this attachment.
              [{ components: evaluationComponents(database, evaluation) }],
            ),
          );
        }),
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

/** Every Workspace deletion this run actually performed. */
function deletions(events: DurableEvent[]): DurableEvent[] {
  return reads(events).filter((event) => nameOf(event).startsWith("delete:"));
}

/** What one Workspace file effect recorded, as the journal holds its result. */
function outcomeOf(event: DurableEvent): Json | undefined {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  return event.result.value;
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

/** The pinned identities one admission recorded for the elements it named. */
function recordedNames(event: DurableEvent): Json | undefined {
  const value = outcomeOf(event);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value.named;
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
 * What the second site is allowed to reach.
 *
 * The fixture's two sites observe different things on purpose — one reads
 * the run's Workspace, one performs the single admitted request — so a
 * replay that restored the wrong record would be visible as the wrong kind
 * of observation, not merely as the wrong text.
 */
const CEILING: GeneratedEvaluationOptions = { requests: [{ url: URL_ADMITTED }] };

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
      // Deterministic order, so the record reads the same however SQLite would
      // have ordered the rows. A continuation asks for this basis by membership
      // rather than positionally, so the order is record stability rather than
      // the thing the comparison turns on.
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
          // what a wrapper would mint to give both sites one durable name. It
          // answers the authored form too: implementing the whole public shape
          // is exactly what a forger would do, and identity is the private
          // field rather than the shape.
          yield* interpose(() => ({ hasContent: () => false }));
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
          // `<Frame>` is still running — it has not returned, and it never
          // claimed anything — so its issuance is genuine, live and unspent
          // while the sites in its content run. Routing it there is the
          // substitution a spent or finished sibling's does not reach. Two
          // things refuse it, and the first reached is that `<Frame>` is not
          // `<Evaluate>`; Tier CIV nests one component inside itself to hold
          // the projection on its own.
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

        expect(reported(attempt)).toContain("invocation of <Frame />");
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

        // What the definition a handler is given carries about its domain.
        let carriedDomain: string[] = [];
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
                kept = original;
                // Nothing here to put on a component of its own.
                carriedDomain = Reflect.ownKeys(definition).map(String);
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

        expect(reported(attempt)).toContain("invocation of <Elsewhere />");
        // The real site was admitted, and nothing else was: no second record,
        // and no request under an identity the author wrote no observation at.
        const recorded = admissions(attempt.events);
        expect(recorded).toHaveLength(1);
        expect(admittedSource(recorded[0]!)).toBe(`<File path="alpha.md" />`);
        expect(carriedDomain).not.toContain("claim");
        expect(attempt.performed).toEqual([]);
      });
    });

    it("refuses one attachment's implementation at another attachment's site", function* () {
      const root = yield* useStorageRoot();
      const source = yield* fixture();
      yield* withStorage(root, function* () {
        // Two attachments, live at the same moment: separate runs, separate
        // databases, separate Workspaces, each declaring `<Evaluate>` to its own
        // execution. The first is held inside its own document — at the request
        // its second site performs — so its execution is still running, and the
        // claimant it was built from is still active, while the second attempts
        // to name work with its implementation.
        const owner = yield* createRun();
        const other = yield* createRun({ runId: "release-1.5" });
        yield* plant(owner, "alpha.md", ADMITTED_NOTE);
        yield* plant(other, "alpha.md", "a note the other attachment holds\n");

        let kept: EvaluateImplementation | undefined;
        let record: RegistryEntry | undefined;
        // Installed once per attachment, holding two variables across both —
        // which is what middleware outliving an attachment amounts to.
        function* interposeAcross(borrow: boolean): Operation<void> {
          yield* Component.around({
            // The first attachment's whole registration record, handed back
            // inside the second: not a field read out of it, the object itself,
            // so `<Evaluate>` here resolves to the first attachment's
            // registration entirely.
            registry: (_args, next): ComponentRegistry => {
              const answer = next();
              if (!borrow) {
                record = answer.get("Evaluate");
                return answer;
              }
              return record === undefined ? answer : new Map([...answer, ["Evaluate", record]]);
            },
            *importComponent([name], next) {
              const definition = yield* next(name);
              if (name !== "Evaluate" || definition.kind !== "function") {
                return definition;
              }
              const original = definition.fn;
              if (typeof original !== "function") {
                return definition;
              }
              if (!borrow) {
                kept = original;
                return definition;
              }
              return {
                ...definition,
                *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
                  // The first attachment's implementation — closed over the
                  // first attachment's database, roots and ceilings — at the
                  // second attachment's own `<Evaluate>` site, with the genuine
                  // issuance minted there.
                  return yield* (kept ?? original)(props, invocation);
                },
              };
            },
          });
        }

        // A barrier, not a delay: the first attachment tells this test where it
        // is, and stays there until it is let go.
        const held = withResolvers<void>();
        const release = withResolvers<void>();
        const first = yield* spawn(function* () {
          return yield* scoped(function* () {
            yield* interposeAcross(false);
            return yield* runDocument(owner, source, CEILING, function* () {
              held.resolve();
              yield* release.operation;
            });
          });
        });
        yield* held.operation;

        // The first attachment is inside its own second site now: one admission
        // committed, and the request it is holding not yet performed.
        const heldRecords = admissions(yield* owner.journal.readAll());
        expect(heldRecords).toHaveLength(2);
        expect(record).not.toBe(undefined);
        expect(kept).not.toBe(undefined);

        const second = yield* scoped(function* () {
          yield* interposeAcross(true);
          return yield* runDocument(other, source, CEILING);
        });

        // Refused because this invocation belongs to another installation —
        // not because the first attachment had gone. It is still running: its
        // claimant is active, and the refusal says so by naming the domain
        // rather than the execution.
        expect(reported(second)).toContain("as this execution installed it");
        expect(reported(second)).not.toContain("is not running this");
        // Neither attachment admitted anything the other's expansion named, and
        // the borrowed implementation performed no request.
        expect(admissions(second.events)).toHaveLength(0);
        expect(second.performed).toEqual([]);
        expect(admissions(yield* owner.journal.readAll())).toEqual(heldRecords);

        // Let the first attachment finish, on its own terms.
        release.resolve();
        const completed = yield* first;
        expect(completed.failure).toBe(undefined);
        expect(completed.performed.map((call) => call.url)).toEqual([URL_ADMITTED]);
        const owned = admissions(completed.events);
        expect(owned).toHaveLength(2);
        expect(new Set(owned.map(nameOf)).size).toBe(2);
        // And what the second attachment's database holds is nothing at all:
        // no admission, and no record named by the first attachment's run.
        expect(admissions(yield* other.journal.readAll())).toEqual([]);
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
        { requests: [{ url: URL_ADMITTED }] },
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
        { requests: [{ url: URL_ADMITTED }] },
      );
      expect(reported(outside)).toContain("did not admit");
      expect(outside.performed).toHaveLength(0);
    });
  });
});

/**
 * Tier WGAC — the effect classes `<Evaluate>` selects between
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The same seam, asked for a class rather than only for a fragment. What these
 * add to the core matrix is the production assembly: the real `<File>` and the
 * real `<Dir>` this package registers, the run's own transaction-bound Files
 * provider, and the run's authoritative current root — so an admitted write
 * lands where the run keeps its Workspace and nowhere else.
 */

/** What the run's Workspace holds at one logical path, read back independently. */
function* stored(database: WorkflowRunDatabase, path: string): Operation<string | undefined> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    return yield* workspace.filesystem.readFile(path);
  });
  return read.ok ? new TextDecoder().decode(read.value) : undefined;
}

/** One generated fragment, quoted into an expression prop the way a document writes one. */
function evaluates(fragment: string, allow?: readonly string[]): string {
  const selection = allow === undefined ? "" : ` allow={${JSON.stringify([...allow])}}`;
  return `<Evaluate source={${JSON.stringify(fragment)}}${selection} />\n`;
}

const WRITES = `<Dir path="nested">\n\n<File path="out.md">the fragment wrote this</File>\n\n</Dir>\n`;

describe("Tier WGAC — the classes an authored element may select", () => {
  const REFUSED: Array<[string, string]> = [
    ["an empty selection", `<Evaluate source="text" allow={[]} />\n`],
    ["one class twice", `<Evaluate source="text" allow={["read", "read"]} />\n`],
    ["a class this host does not have", `<Evaluate source="text" allow={["execute"]} />\n`],
    ["a selection that is not an array", `<Evaluate source="text" allow="write" />\n`],
  ];

  for (const [what, source] of REFUSED) {
    it(`WGAC9: ${what} is refused before any admission`, function* () {
      const root = yield* useStorageRoot();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const attempt = yield* runDocument(database, source);

        expect(reported(attempt)).toMatch(/allow/i);
        expect(admissions(attempt.events)).toHaveLength(0);
      });
    });
  }

  const ACCEPTED: Array<[string, readonly string[]]> = [
    ["read alone", ["read"]],
    ["write alone", ["write"]],
    ["both, in either order", ["write", "read"]],
  ];

  for (const [what, allow] of ACCEPTED) {
    it(`WGAC9: a selection of ${what} is admitted`, function* () {
      const root = yield* useStorageRoot();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const attempt = yield* runDocument(
          database,
          evaluates("nothing to perform here.\n", allow),
        );

        expect(attempt.failure).toBe(undefined);
        const recorded = admissions(attempt.events);
        expect(recorded).toHaveLength(1);
        // Canonical order, whatever the document wrote: a continuation compares
        // this, and two documents asking for the same classes ask for one grant.
        expect(policyOf(recorded[0]!)?.allow).toEqual([...allow].sort());
      });
    });
  }

  it("WGAC9: omitting `allow` still admits exactly the read table", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      const attempt = yield* runDocument(database, evaluates(`<File path="notes.md" />`));

      expect(attempt.failure).toBe(undefined);
      const recorded = admissions(attempt.events);
      expect(policyOf(recorded[0]!)?.allow).toEqual(["read"]);
      // And the write table is not in the retained policy at all, so a run that
      // changed it has not changed what this admission was granted under.
      expect(JSON.stringify(policyOf(recorded[0]!))).not.toContain("File:write");
    });
  });
});

describe("Tier WGAC — the standard write table", () => {
  it("WGAC10: an admitted write lands in the run's own Workspace", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      const attempt = yield* runDocument(database, evaluates(WRITES, ["write"]));

      expect(attempt.failure).toBe(undefined);
      // The run's Workspace, beneath the directory the fragment installed —
      // read back through the run's own transaction rather than from the record
      // under test.
      expect(yield* stored(database, "/nested/out.md")).toBe("the fragment wrote this");
      // Through the ordinary `<File>` effect, which is the authoritative account
      // of the mutation. The evaluator adds no receipt of its own.
      expect(reads(attempt.events).length).toBeGreaterThanOrEqual(1);

      // The standard table, whole and in the order the policy retains — which
      // is load-bearing rather than cosmetic: a continuation compares the
      // entries position by position, so what this profile installs is what a
      // resumed run is held to.
      const policy = policyOf(admissions(attempt.events)[0]!);
      expect(policy?.allowed).toEqual([
        { name: "File", identity: "@executablemd/core#File:write", forms: ["paired"] },
        {
          name: "Dir",
          identity: "@executablemd/workflow/composition#Dir",
          forms: ["paired"],
        },
        {
          name: "File.Delete",
          identity: "@executablemd/core#File.Delete",
          forms: ["self-closing"],
        },
      ]);
    });
  });

  it("WGAC10: nothing outside the write table is admitted with it", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      const attempt = yield* runDocument(
        database,
        evaluates(`<Git.Push remote="origin" />\n`, ["write"]),
      );

      expect(reported(attempt)).toContain("did not admit");
      expect(reads(attempt.events)).toEqual([]);
    });
  });

  it("WGAC14: an admitted deletion removes the file through the run's own transaction", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "obsolete.md", "what an earlier step left\n");
      const planted = reads(yield* database.journal.readAll()).length;

      const attempt = yield* runDocument(
        database,
        `<Evaluate source={${JSON.stringify(`<File.Delete path="obsolete.md" />`)}} ` +
          `allow={["write"]} as="applied" />\n\n<Json value={applied} />\n`,
      );

      expect(attempt.failure).toBe(undefined);
      // The run's own Workspace, read back through its own transaction rather
      // than from the records under test.
      expect(yield* stored(database, "/obsolete.md")).toBe(undefined);
      // One ordinary `workspace_file` effect, which is the authoritative
      // account of the removal. The evaluator adds no receipt beside it.
      const performed = deletions(attempt.events);
      expect(performed).toHaveLength(1);
      expect(outcomeOf(performed[0]!)).toEqual({ kind: "deleted" });
      expect(reads(attempt.events)).toHaveLength(planted + 1);

      // Admitted as the exact self-closing identity, and named by the fragment
      // as the element was written.
      const admission = admissions(attempt.events)[0]!;
      expect(policyOf(admission)?.allowed).toContainEqual({
        name: "File.Delete",
        identity: "@executablemd/core#File.Delete",
        forms: ["self-closing"],
      });
      expect(recordedNames(admission)).toEqual([
        {
          name: "File.Delete",
          identity: "@executablemd/core#File.Delete",
          form: "self-closing",
        },
      ]);
      // A mutation contributes nothing: the shape a document binds is the same
      // one every selection binds, and a deletion puts no result in it.
      expect(JSON.parse(reported(attempt))).toEqual({ observations: [], output: "" });
    });
  });

  it("WGAC15: a later unadmitted construct keeps the earlier deletion from running", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "obsolete.md", "what an earlier step left\n");
      const planted = reads(yield* database.journal.readAll()).length;

      const attempt = yield* runDocument(
        database,
        evaluates(`<File.Delete path="obsolete.md" />\n\n\`\`\`bash exec\nprintf ran\n\`\`\`\n`, [
          "write",
        ]),
      );

      // Whole-fragment preflight wins: the construct after the admitted element
      // is read before the element ahead of it runs.
      //
      // The second construct is a code block rather than an unadmitted
      // component, and that is what makes this discriminating. A refusal names
      // its class and nothing else, so "did not admit" would read the same
      // whether the block was refused or the deletion itself was never in the
      // table — and a fragment whose first element was refused would prove
      // nothing about preflight reaching past it.
      expect(reported(attempt)).toContain("executable code block");
      expect(yield* stored(database, "/obsolete.md")).toBe("what an earlier step left\n");
      expect(deletions(attempt.events)).toEqual([]);
      expect(reads(attempt.events)).toHaveLength(planted);
    });
  });

  it("WGAC10: a self-closing File is not admitted by the write table", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");
      const planted = reads(yield* database.journal.readAll()).length;

      const attempt = yield* runDocument(
        database,
        evaluates(`<File path="notes.md" />\n`, ["write"]),
      );

      expect(reported(attempt)).toContain("paired form");
      expect(reads(attempt.events)).toHaveLength(planted);
    });
  });
});

describe("Tier WGAC — what a selection binds", () => {
  it("WGAC11: a write-only evaluation binds no observation and no output", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      const attempt = yield* runDocument(
        database,
        `<Evaluate source={${JSON.stringify(WRITES)}} allow={["write"]} as="applied" />\n\n` +
          `<Json value={applied} />\n`,
      );

      expect(attempt.failure).toBe(undefined);
      // `as` binds the same shape for every selection, and an admitted write
      // puts nothing in it.
      expect(reported(attempt)).toContain('"observations": []');
      expect(yield* stored(database, "/nested/out.md")).toBe("the fragment wrote this");
    });
  });

  it("WGAC11: a mixed evaluation binds the read and not the write", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* plant(database, "notes.md", "the retained note\n");

      const fragment = `<File path="notes.md" />\n\n<File path="proposed.md">the fragment wrote this</File>\n`;
      const attempt = yield* runDocument(
        database,
        `<Evaluate source={${JSON.stringify(fragment)}} allow={["read", "write"]} as="applied" />\n\n` +
          `<Json value={applied} />\n`,
      );

      expect(attempt.failure).toBe(undefined);
      const bound = reported(attempt);
      expect(bound).toContain('"name": "File"');
      expect(bound).toContain("the retained note");
      // One entry, not two: the write is accounted for by its own effect.
      expect(bound.match(/"name": "File"/g)).toHaveLength(1);
      expect(yield* stored(database, "/proposed.md")).toBe("the fragment wrote this");
    });
  });
});

describe("Tier WGAC — a committed mutation is not repeated", () => {
  it("WGAC12: a completed replay restores the run and writes nothing again", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = evaluates(WRITES, ["write"]);

      const first = yield* runDocument(database, document);
      expect(first.failure).toBe(undefined);
      const committed = first.events.length;
      const written = reads(first.events).length;

      const again = yield* runDocument(database, document);

      expect(again.failure).toBe(undefined);
      // Nothing new was journaled and no second mutation happened; the retained
      // content is what the first attempt left.
      expect(again.events.length).toBe(committed);
      expect(reads(again.events).length).toBe(written);
      expect(yield* stored(database, "/nested/out.md")).toBe("the fragment wrote this");
    });
  });
});
