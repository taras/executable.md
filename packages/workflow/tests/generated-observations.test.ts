/**
 * Tier WGX — the ceilings a workflow run admits generated observations under
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * Core decides what a generated fragment *is* — what parses, what preflights,
 * which pinned identity a name runs, and what the run retains. This suite is
 * about the half core does not own: which retained Workspace root the run
 * selects, and which HTTP reads it is willing to state.
 *
 * Each case counts what the substituted transport was asked to perform and what
 * the journal holds, because a policy that refuses correctly and still performs
 * a request has refused nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { retainedSource, SOURCE_POSITION_FIELD } from "@executablemd/core";
import type { SourcePosition } from "@executablemd/core";
import { executeInstalled, pinnedFileRead } from "@executablemd/core/host";
import type {
  GeneratedObservationResult,
  GeneratedObservationValue,
} from "@executablemd/core/host";
import type { DurablePreparation, ExecutionInstallation } from "@executablemd/core/host";
import { evaluateGeneratedFragment } from "../src/generated-observations.ts";
import type { GeneratedEvaluationPolicy } from "../src/generated-observations.ts";

const ROOT_PATH = "workflows/agent.md";
const ROOT_SOURCE = "The run admitted a generated fragment.\n";
const URL_ONE = "https://api.example.test/one";
const URL_TWO = "https://api.example.test/two";
const PRIMARY = "workspace://primary";
const SECONDARY = "workspace://secondary";

/** What the substituted transport was asked to do. */
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
          *text(): Operation<string> {
            yield* sleep(0);
            return "body";
          },
        };
      },
    },
    { at: "min" },
  );
  return { performed };
}

/** What one run under one policy produced. */
interface Attempt {
  output?: string;
  values?: readonly GeneratedObservationValue[];
  failure?: string;
  events: DurableEvent[];
}

/**
 * Drive the wrapper from a `DurablePreparation`.
 *
 * The preparation is a harness choice, not the production path: production
 * reaches the wrapper through the workflow host's declared `<Evaluate>`
 * component inside the owning document expansion. The wrapper is an
 * `Operation` whose durable effects identify themselves against the durable
 * root they run in, so a preparation drives it unchanged — the `Workflow`
 * annotation narrows only the static yield type, which is what the cast
 * widens past.
 */
function driven(work: () => Operation<void>): ExecutionInstallation {
  return { prepare: work as DurablePreparation };
}

/**
 * Run one fragment under one policy, from the position a trusted host records
 * durable work from.
 *
 * `events` continues a retained journal instead of starting an empty one, and
 * `position` stands in for the authored `<Evaluate>` element's own source.
 */
function evaluate(
  source: string,
  policy: GeneratedEvaluationPolicy,
  options: { events?: DurableEvent[]; position?: Readonly<SourcePosition> } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = new InMemoryStream(options.events ?? []);
    const captured: { result?: GeneratedObservationResult } = {};
    const installation = driven(function* () {
      captured.result = yield* evaluateGeneratedFragment(
        "turn-1",
        source,
        policy,
        options.position,
      );
    });
    const execution = yield* executeInstalled(
      { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream, includes: [] },
      [installation],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    if (result.ok) {
      return {
        output: captured.result?.output ?? "",
        values: captured.result?.observations ?? [],
        events,
      };
    }
    return { failure: result.error.message, events };
  });
}

function admissions(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** Every generated-XMD record that admitted its fragment. */
function admittedFragments(events: DurableEvent[]): DurableEvent[] {
  return admissions(events).filter((event) => {
    if (event.type !== "yield" || event.result.status !== "ok") {
      return false;
    }
    const value = event.result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return value.decision === "admitted";
  });
}

function observations(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" && event.description.type === "fetch" && event.result.status === "ok",
  );
}

const ADMITTED: readonly Record<string, Json>[] = [{ url: URL_ONE }];

function policy(overrides: Partial<GeneratedEvaluationPolicy> = {}): GeneratedEvaluationPolicy {
  return {
    workspaceRoots: [PRIMARY, SECONDARY],
    selectedRoot: PRIMARY,
    requests: ADMITTED,
    // What the real host always states, so an empty `requests` here is a run
    // admitting no `<Fetch>` rather than a run admitting nothing at all.
    reads: [pinnedFileRead()],
    ...overrides,
  };
}

describe("Tier WGX — the roots a run selects", () => {
  it("WGX1: the admission records the root the run selected and the ones it retained", function* () {
    yield* useTransport();

    const attempt = yield* evaluate(`<Fetch url="${URL_ONE}" />\n`, policy());

    expect(attempt.failure).toBe(undefined);
    const [admission] = admissions(attempt.events);
    if (admission?.type !== "yield") {
      throw new Error("the run recorded no generated-XMD admission");
    }
    expect(admission.description.input).toMatchObject({
      roots: [PRIMARY, SECONDARY],
      selectedRoot: PRIMARY,
    });
  });

  it("WGX2: a root the run did not retain is refused before the fragment is read", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate(
      `<Fetch url="${URL_ONE}" />\n`,
      policy({ selectedRoot: "workspace://never-retained" }),
    );

    expect(attempt.failure).toContain("did not retain");
    expect(transport.performed).toHaveLength(0);
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("WGX3: one root named twice is refused", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate(
      `<Fetch url="${URL_ONE}" />\n`,
      policy({ workspaceRoots: [PRIMARY, PRIMARY] }),
    );

    expect(attempt.failure).toContain("twice");
    expect(transport.performed).toHaveLength(0);
    expect(admissions(attempt.events)).toHaveLength(0);
  });
});

describe("Tier WGX — the reads a run is willing to state", () => {
  it("WGX4: an admitted destination performs once and retains one observation", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate(`<Fetch url="${URL_ONE}" />\n`, policy());

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed).toEqual([{ url: URL_ONE, init: { method: "GET", headers: {} } }]);
    expect(observations(attempt.events)).toHaveLength(1);
  });

  it("WGX5: a destination outside the ceiling performs no request", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate(`<Fetch url="${URL_TWO}" />\n`, policy());

    expect(attempt.failure).toContain("did not admit");
    expect(transport.performed).toHaveLength(0);
    expect(admittedFragments(attempt.events)).toHaveLength(0);
  });

  it("WGX6: an empty ceiling admits the pinned Fetch identity not at all", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate(`<Fetch url="${URL_ONE}" />\n`, policy({ requests: [] }));

    expect(attempt.failure).toContain("did not admit");
    expect(transport.performed).toHaveLength(0);
    expect(admittedFragments(attempt.events)).toHaveLength(0);
  });

  it("WGX7: a fragment that asks for nothing is admitted and retains its source", function* () {
    const transport = yield* useTransport();

    const attempt = yield* evaluate("nothing to observe here.\n", policy());

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("nothing to observe here.");
    expect(transport.performed).toHaveLength(0);
    expect(admissions(attempt.events)).toHaveLength(1);
    expect(observations(attempt.events)).toHaveLength(0);
  });
});

describe("Tier WGX — the authored site an admission retains", () => {
  const POSITION: Readonly<SourcePosition> = Object.freeze({
    path: ROOT_PATH,
    offset: 42,
    line: 7,
    column: 3,
  });

  it("WGX8: the admission carries the outer authored source, and its replay stays aligned", function* () {
    const transport = yield* useTransport();
    const source = `<Fetch url="${URL_ONE}" />\n`;

    const first = yield* evaluate(source, policy(), { position: POSITION });

    expect(first.failure).toBe(undefined);
    const [admission] = admissions(first.events);
    if (admission?.type !== "yield") {
      throw new Error("the run recorded no generated-XMD admission");
    }
    expect(admission.description.name).toBe("generated:turn-1");
    expect(admission.description[SOURCE_POSITION_FIELD]).toEqual({
      path: ROOT_PATH,
      offset: 42,
      line: 7,
      column: 3,
    });
    expect(transport.performed).toHaveLength(1);

    // A continuation of the retained history: the admission and the nested
    // fetch replay aligned, so nothing is admitted twice and no request is
    // performed again.
    const retained = first.events.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );
    const continuation = yield* evaluate(source, policy(), {
      events: retained,
      position: POSITION,
    });

    expect(continuation.failure).toBe(undefined);
    expect(continuation.values).toEqual(first.values);
    expect(admissions(continuation.events)).toHaveLength(1);
    expect(transport.performed).toHaveLength(1);

    // The position is diagnostic data, not identity: a continuation whose
    // element moved still replays the same retained admission.
    const moved = yield* evaluate(source, policy(), {
      events: retained,
      position: { path: ROOT_PATH, offset: 99, line: 9, column: 1 },
    });

    expect(moved.failure).toBe(undefined);
    expect(admissions(moved.events)).toHaveLength(1);
    expect(transport.performed).toHaveLength(1);
  });

  it("WGX9: an admission asked for without a position retains none", function* () {
    yield* useTransport();

    const attempt = yield* evaluate("nothing to observe here.\n", policy());

    expect(attempt.failure).toBe(undefined);
    const [admission] = admissions(attempt.events);
    if (admission?.type !== "yield") {
      throw new Error("the run recorded no generated-XMD admission");
    }
    expect(admission.description[SOURCE_POSITION_FIELD]).toBeUndefined();
  });
});
