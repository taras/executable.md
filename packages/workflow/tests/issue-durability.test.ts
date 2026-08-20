/**
 * Tier WI — what an `<Issue>` retains, replays and refuses to guess.
 *
 * The claims here are about the journal and the provider together. A replayed
 * issue must resolve no provider, read no credential and append no second
 * record; an issue an interrupted attempt already created must be adopted
 * rather than created twice; nothing a provider could not answer may become
 * absence; and what public routing middleware sees must be the frozen request
 * and nothing that can answer for it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, scoped, type Operation, type Result } from "effection";
import { createApi } from "@effectionx/context-api";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ISSUE_API, IssueRouting } from "../src/issue/api.ts";
import type { IssueApi, IssueCall, IssueProvider, IssueRoutingRequest } from "../src/issue/api.ts";
import {
  IssueAmbiguousError,
  IssueConflictError,
  IssueProviderError,
  IssueUnavailableError,
} from "../src/issue/errors.ts";
import {
  issueInputsJson,
  issueNaturalKey,
  issueNaturalKeyJson,
  issuePreStateJson,
  issueRequestFingerprint,
  type IssueCompletion,
  type IssueObservation,
} from "../src/issue/records.ts";
import {
  atlassianProvider,
  atlassianTracker,
  causedBy,
  DESCRIPTION,
  document,
  ENDPOINT,
  forbiddenProvider,
  gitHub,
  issueOutcomes,
  issueYields,
  partial,
  raised,
  RUN,
  runIssueDocument,
  store,
  TARGET,
  TITLE,
  TOKEN,
} from "./support/issues.ts";

/** What a compatible answer looks like when middleware writes it. */
const FORGED: IssueObservation = Object.freeze({
  state: "compatible",
  preState: { by: "middleware-forgery" },
  observations: { by: "middleware-forgery" },
  result: { by: "middleware-forgery" },
});

/**
 * The one Issue surface, addressed by its stable name from outside.
 *
 * Independently constructed, exactly as a repository component or a second
 * loaded copy would construct it: sharing the name is how composition works,
 * and is deliberately not how authority works.
 */
const IssueWitness = createApi<IssueApi>(ISSUE_API, {
  // deno-lint-ignore require-yield
  *route(): Operation<unknown> {
    throw new Error("the witness handler did not delegate");
  },
});

function routingOf(call: IssueCall): IssueRoutingRequest {
  return call.intent === "route" ? call : call.routing;
}

/** A provider that answers one closed observation and never performs. */
function answering(observation: IssueObservation | Error): IssueProvider {
  return {
    // deno-lint-ignore require-yield
    *observe(): Operation<Result<IssueObservation>> {
      return observation instanceof Error ? Err(observation) : Ok(observation);
    },
    // deno-lint-ignore require-yield
    *perform(): Operation<Result<IssueCompletion>> {
      throw new Error("the engine performed where nothing may be performed");
    },
  };
}

describe("workflow Issue durability", () => {
  it("replays without resolving a provider, reading a credential or appending a record", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    expect(first.records).toHaveLength(1);
    const sent = state.requests.length;

    // The issue this run created is closed and retitled after the record
    // commits. What the run retained is what it recorded.
    const created = state.issues[0];
    if (created !== undefined) {
      created.state = "closed";
      created.title = "Something else entirely";
    }

    const replayed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(first.events)),
      // Nothing may be resolved or reached, so nothing is installed to reach.
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });

    expect(replayed.thrown).toBeUndefined();
    expect(replayed.rendered).toBe(first.rendered);
    expect(issueYields(replayed.events)).toHaveLength(1);
    expect(state.requests).toHaveLength(sent);
  });

  it("adopts the issue an interrupted attempt already created", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    expect(state.issues).toHaveLength(1);

    // The state an interruption leaves: the issue exists at the provider, and
    // this run's history holds no result for it.
    const withoutRecord = first.events.filter(
      (event) => !(event.type === "yield" && event.description.type === "issue_effect"),
    );
    state.requests.length = 0;

    const resumed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(withoutRecord)),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(resumed.thrown).toBeUndefined();
    // One issue, observed and recognized rather than created a second time.
    expect(state.issues).toHaveLength(1);
    expect(resumed.records[0]?.decision).toBe("adopted");
    expect(resumed.records[0]?.preState).toEqual(resumed.records[0]?.observations);
    expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("brings an issue whose text somebody moved back to what this run asked for", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    const withoutRecord = first.events.filter(
      (event) => !(event.type === "yield" && event.description.type === "issue_effect"),
    );
    const created = state.issues[0];
    if (created !== undefined) {
      created.title = "Something else entirely";
      created.labels = ["stale"];
    }
    state.requests.length = 0;

    const resumed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(withoutRecord)),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(resumed.thrown).toBeUndefined();
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.title).toBe(TITLE);
    expect(state.issues[0]?.labels).toEqual([]);
    expect(resumed.records[0]?.decision).toBe("performed");
    // One update, then exactly one observation that decided it.
    expect(state.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("names a different durable operation for every member of the request", function* () {
    // The claim replay rests on: a changed request cannot arrive at a retained
    // result, because the durable name moves with the request. Asserted on the
    // fingerprint directly rather than by editing a document between runs — an
    // edited definition is a fork (§11), not a changed request at one position.
    const identity = { runId: RUN.runId, expansionId: "expansion-1" };
    const base = {
      identity,
      provider: "github",
      target: TARGET,
      inputs: issueInputsJson({
        title: TITLE,
        description: DESCRIPTION,
        tags: [],
        assignee: null,
      }),
      naturalKey: issueNaturalKeyJson(issueNaturalKey(identity, TARGET)),
    };
    const variants = [
      base,
      { ...base, provider: "atlassian" },
      { ...base, target: "https://github.com/octo/other" },
      {
        ...base,
        inputs: issueInputsJson({
          title: "Other",
          description: DESCRIPTION,
          tags: [],
          assignee: null,
        }),
      },
      {
        ...base,
        inputs: issueInputsJson({ title: TITLE, description: "Other", tags: [], assignee: null }),
      },
      {
        ...base,
        inputs: issueInputsJson({
          title: TITLE,
          description: DESCRIPTION,
          tags: ["urgent"],
          assignee: null,
        }),
      },
      {
        ...base,
        inputs: issueInputsJson({
          title: TITLE,
          description: DESCRIPTION,
          tags: [],
          assignee: "octocat",
        }),
      },
    ];

    const names: string[] = [];
    for (const variant of variants) {
      names.push(yield* issueRequestFingerprint(variant));
    }
    expect(new Set(names).size).toBe(variants.length);

    // And tag order is not one of them: a reordered set is the same question.
    const reordered = yield* issueRequestFingerprint({
      ...base,
      inputs: issueInputsJson({
        title: TITLE,
        description: DESCRIPTION,
        tags: ["a", "b"],
        assignee: null,
      }),
    });
    const sorted = yield* issueRequestFingerprint({
      ...base,
      inputs: issueInputsJson({
        title: TITLE,
        description: DESCRIPTION,
        tags: ["b", "a"].slice().sort(),
        assignee: null,
      }),
    });
    expect(reordered).toBe(sorted);
  });
});

describe("workflow Issue reconciliation refusals", () => {
  it("never turns what a provider could not answer into absence", function* () {
    const cases: { observation: IssueObservation | Error; name: string }[] = [
      { observation: new IssueUnavailableError(), name: "IssueUnavailableError" },
      {
        observation: { state: "conflict", preState: issuePreStateJson({ issue: null }) },
        name: "IssueConflictError",
      },
      {
        observation: { state: "ambiguous", preState: issuePreStateJson({ issue: null }) },
        name: "IssueAmbiguousError",
      },
    ];

    for (const { observation, name } of cases) {
      const run = yield* runIssueDocument({
        providers: [{ discriminator: "github", provider: answering(observation) }],
      });
      // The provider's `perform` throws if it is ever reached, so reaching this
      // line at all is the claim: none of the three performed anything.
      expect(run.thrown).toBeDefined();
      expect(issueOutcomes(run.events)).toEqual([{ status: "err", name }]);
    }
  });

  it("replays a refusal as itself rather than observing again", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: answering(new IssueUnavailableError()) }],
    });
    expect(first.thrown).toBeInstanceOf(IssueUnavailableError);

    const replayed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(first.events)),
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });
    expect(replayed.thrown).toBeInstanceOf(IssueUnavailableError);
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a closed issue carrying this position's marker", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    const withoutRecord = first.events.filter(
      (event) => !(event.type === "yield" && event.description.type === "issue_effect"),
    );
    const created = state.issues[0];
    if (created !== undefined) {
      created.state = "closed";
    }

    const resumed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(withoutRecord)),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(resumed.thrown).toBeInstanceOf(IssueConflictError);
    // Nothing was reopened, and no second issue was filed beside it.
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.state).toBe("closed");
  });

  it("refuses two issues carrying one position's marker", function* () {
    const state = store();
    const first = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    const withoutRecord = first.events.filter(
      (event) => !(event.type === "yield" && event.description.type === "issue_effect"),
    );
    const created = state.issues[0];
    if (created !== undefined) {
      state.issues.push({ ...created, nodeId: "I_node_2", number: 2 });
    }

    const resumed = yield* runIssueDocument({
      stream: new InMemoryStream(partial(withoutRecord)),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(resumed.thrown).toBeInstanceOf(IssueAmbiguousError);
    expect(state.issues).toHaveLength(2);
  });
});

describe("workflow Issue routing boundary", () => {
  it("shows middleware the frozen request and nothing that can answer it", function* () {
    const state = store();
    const seen: IssueCall[] = [];

    const run = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
      around: (operation) =>
        scoped(function* () {
          yield* IssueRouting.around({
            *route([call], next): Operation<unknown> {
              seen.push(call);
              yield* next(call);
              // A return value is not evidence, and this one is discarded.
              return Ok(FORGED);
            },
          });
          return yield* operation;
        }),
    });

    // One observation and one performance, and both were routing requests.
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.intent).toBe("route");
      expect(Object.keys(call).sort()).toEqual(["intent", "phase", "request"]);
      const request = Reflect.get(call, "request");
      expect(Object.keys(Object(request)).sort()).toEqual([
        "identity",
        "inputs",
        "naturalKey",
        "provider",
        "target",
      ]);
      expect(Object.isFrozen(call)).toBe(true);
      const described = JSON.stringify(call);
      expect(described).not.toContain(TOKEN);
      expect(described).not.toContain(ENDPOINT);
      expect(described).not.toContain("api.github");
      // Nothing on it is a function, so there is nothing to invoke.
      for (const value of Object.values(Object(request))) {
        expect(typeof value).not.toBe("function");
      }
    }

    // What the middleware returned was ignored: the record is the provider's.
    expect(run.records[0]?.decision).toBe("performed");
    expect(String(JSON.stringify(run.records))).not.toContain("middleware-forgery");
  });

  it("publishes nothing when middleware refuses to delegate", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
      around: (operation) =>
        scoped(function* () {
          yield* IssueRouting.around({
            // deno-lint-ignore require-yield
            *route(): Operation<unknown> {
              return Ok(FORGED);
            },
          });
          return yield* operation;
        }),
    });

    expect(
      causedBy(run.thrown, (v): v is IssueProviderError => v instanceof IssueProviderError),
    ).toBeDefined();
    expect(String(run.thrown)).toContain("executed and published nothing");
    expect(state.requests).toHaveLength(0);
    expect(run.records).toHaveLength(0);
  });

  it("cannot be answered through the shared name once the invocation is over", function* () {
    const state = store();
    const captured: IssueRoutingRequest[] = [];
    const run = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
      around: (operation) =>
        scoped(function* () {
          yield* IssueRouting.around({
            *route([call], next): Operation<unknown> {
              captured.push(routingOf(call));
              return yield* next(call);
            },
          });
          return yield* operation;
        }),
    });

    expect(run.records).toHaveLength(1);
    expect(captured).not.toHaveLength(0);

    // Everything a handler can keep and everything it can rebuild from what it
    // kept. The stable name is how composition works and deliberately not how
    // authority works: the surface's own default completes nothing.
    for (const routing of captured) {
      const copied: IssueRoutingRequest = Object.freeze({
        intent: "route",
        phase: routing.phase,
        request: routing.request,
      });
      for (const forged of [
        routing,
        copied,
        { intent: "inspect" as const, routing },
        { intent: "answer" as const, routing, answer: Ok(FORGED) },
        { intent: "inspect" as const, routing: copied },
        { intent: "answer" as const, routing: copied, answer: Ok(FORGED) },
      ]) {
        // The real surface, reached with what a handler kept: its own default
        // is what answers, and its own default completes nothing.
        expect(yield* raised(IssueRouting.operations.route(forged))).toBeInstanceOf(
          IssueProviderError,
        );
        // And a descriptor somebody else constructed under the same stable
        // name reaches that descriptor's default rather than this run's
        // terminal, which is the difference between composition and authority.
        expect(yield* raised(IssueWitness.operations.route(forged))).toBeInstanceOf(Error);
      }
    }

    // Nothing above appended anything: the run's history is what it was.
    expect(issueYields(run.events)).toHaveLength(1);
    expect(String(JSON.stringify(run.records))).not.toContain("middleware-forgery");
  });

  it("keeps every provider's credential and payload out of the retained record", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: document(TARGET, ` tags={["reliability"]} assignee="octocat"`),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    const described = JSON.stringify(run.events);
    expect(described).not.toContain(TOKEN);
    expect(described).not.toContain("api.github.test");
    expect(described).not.toContain("Bearer");
    expect(described).not.toContain("node_id");
    // What it does retain: the destination, the provider and its identity.
    const [record] = run.records;
    expect(record?.request.target).toBe(TARGET);
    expect(record?.request.provider).toBe("github");
    expect(Object(record?.result).url).toBe(
      state.issues[0] === undefined ? "" : "https://github.com/owner/repository/issues/1",
    );
  });

  it("gives two providers installed together only their own requests", function* () {
    const state = store();
    const tracker = atlassianTracker();
    const run = yield* runIssueDocument({
      providers: [
        { discriminator: "atlassian", provider: atlassianProvider(tracker) },
        { discriminator: "github", provider: gitHub(state) },
      ],
    });

    expect(run.thrown).toBeUndefined();
    expect(state.issues).toHaveLength(1);
    // Installed beneath the request's own provider, and it saw nothing.
    expect(tracker.observed).toHaveLength(0);
    expect(tracker.performed).toHaveLength(0);
  });
});
