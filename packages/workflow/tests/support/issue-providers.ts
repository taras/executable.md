/**
 * The provider boundaries a scenario declares for itself.
 *
 * Each of these is one dependency, named for what it provides, and each states
 * its own configuration where the scenario uses it. There is deliberately no
 * component that installs "the usual setup": a ceiling, a credential and an
 * endpoint are the consequential facts of an issue scenario, and a reader who
 * cannot see them in the document cannot check the scenario proves what it says.
 */

import type { Operation } from "effection";
import { content, hasContent, registerComponents } from "@executablemd/core";
import type { Json, PropsSchema } from "@executablemd/core";
import { IssueApi } from "../../src/issue/api.ts";
import type { IssueDetails, IssueInput, IssueReference } from "../../src/issue/api.ts";
import { IssueUnavailableError } from "../../src/issue/errors.ts";
import { withinIssueCeiling } from "../../src/issue/tracker.ts";
import { useGitHubIssues } from "../../src/deno/issue/github.ts";
import { denoGitHubAccess } from "../../src/deno/composition/github.ts";
import type { GitHubAccess, GitHubHttpResponse } from "../../src/deno/composition/github.ts";
import { credentialFor } from "./issue-tracker-server.ts";
import type { CredentialCondition } from "./issue-tracker-server.ts";

/** What a scenario can watch a provider do. */
export interface ProviderLog {
  /** Every idempotency key an upsert was handed, in order. */
  readonly keys: string[];
  /** How many reads and upserts the Atlassian-shaped provider was given. */
  readonly atlassian: { reads: number; upserts: number };
  /** How many requests a lexical override answered. */
  overrides: number;
  /** The issues the Atlassian-shaped tracker holds, by key. */
  readonly atlassianIssues: Map<string, string>;
}

export function providerLog(): ProviderLog {
  return {
    keys: [],
    atlassian: { reads: 0, upserts: 0 },
    overrides: 0,
    atlassianIssues: new Map(),
  };
}

/**
 * The shipped GitHub transport, over the endpoint a scenario declared.
 *
 * The credential is the only thing substituted, because a test cannot own the
 * process environment the production reader looks at. The two faults are the
 * states a document cannot arrange for itself: a transport that never
 * connects, and a create the tracker accepted and this end never learned of.
 *
 * Shared by the `<GitHubIssues>` component and by a staged attempt, so a prior
 * run meets the same adapter the document under test does.
 */
export function gitHubAccessFor(
  endpoint: string,
  conditions: {
    credential: CredentialCondition;
    failsTransport?: boolean;
    interruptsAfterCreate?: boolean;
  },
): GitHubAccess {
  const shipped = denoGitHubAccess(endpoint);
  const carried = credentialFor(conditions.credential);
  return {
    endpoint,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      // The token the document's named condition stands for. The name travels
      // through the document; the value never does. A document holding one
      // would be refused by this repository's secret gate before it ran, and a
      // rendered one does not settle at all (taras/executable.md#524), so a
      // scenario states the condition and asserts the outcome.
      return carried;
    },
    *send(request): Operation<GitHubHttpResponse> {
      if (conditions.failsTransport === true) {
        throw new Error("the declared transport fault refused the connection");
      }
      const answer = yield* shipped.send(request);
      if (
        conditions.interruptsAfterCreate === true &&
        request.method === "POST" &&
        answer.status === 201
      ) {
        // The tracker filed it and this end never learns that it did.
        throw new Error("the declared interruption ended this attempt after the create");
      }
      return answer;
    },
  };
}

/** The condition a document named, narrowed rather than asserted. */
function namedCondition(value: unknown): CredentialCondition {
  if (value === "valid" || value === "invalid" || value === "absent") {
    return value;
  }
  throw new Error(`"credential" must name a condition, got ${JSON.stringify(value)}`);
}

const URL_PROP: PropsSchema = {
  type: "object",
  properties: { url: { type: "string", minLength: 1 } },
  required: ["url"],
  additionalProperties: false,
};

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The components that install a provider for their own content.
 *
 * Each wraps the region it applies to, so the document shows where a provider
 * is in scope rather than leaving it to a setup step somewhere above.
 */
export function useProviderComponents(log: ProviderLog): Operation<void> {
  return registerComponents([
    {
      name: "GitHubIssues",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          /** The containers this host authorizes. Stated, never defaulted. */
          ceiling: { type: "array", items: { type: "string", minLength: 1 } },
          /** Where the shipped adapter sends its requests. */
          endpoint: { type: "string", minLength: 1 },
          /**
           * Which credential the transport carries, by name.
           *
           * Stated, never defaulted: whether a request was authorized is a
           * consequential fact of every scenario here, and a reader who cannot
           * see it in the document cannot check what the scenario proves. The
           * value behind the name stays host-side.
           */
          credential: { enum: ["valid", "invalid", "absent"] },
          /** Fail every request, so nothing about the tracker is provable. */
          failsTransport: { type: "boolean" },
          /**
           * Answer a create with a failure after the tracker accepted it.
           *
           * The gap this whole design exists for, and the only state a document
           * cannot arrange for itself.
           */
          interruptsAfterCreate: { type: "boolean" },
        },
        required: ["ceiling", "endpoint", "credential"],
        additionalProperties: false,
      },
      *fn(props: Record<string, Json>): Operation<string> {
        if (!(yield* hasContent())) {
          return "";
        }
        const ceiling = Array.isArray(props.ceiling) ? props.ceiling.map(String) : [];
        const access = gitHubAccessFor(String(props.endpoint), {
          credential: namedCondition(props.credential),
          failsTransport: props.failsTransport === true,
          interruptsAfterCreate: props.interruptsAfterCreate === true,
        });
        yield* useGitHubIssues({ ceiling, access });
        return yield* content();
      },
    },
    {
      name: "AtlassianIssues",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          ceiling: { type: "array", items: { type: "string", minLength: 1 } },
          refuses: { type: "boolean" },
        },
        required: ["ceiling"],
        additionalProperties: false,
      },
      *fn(props: Record<string, Json>): Operation<string> {
        if (!(yield* hasContent())) {
          return "";
        }
        const ceiling = Array.isArray(props.ceiling) ? props.ceiling.map(String) : [];
        const refuses = props.refuses === true;
        yield* useAtlassianIssues(log, ceiling, refuses);
        return yield* content();
      },
    },
    {
      name: "NoIssueProvider",
      origin: "@executablemd/workflow/test",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        if (!(yield* hasContent())) {
          return "";
        }
        // A boundary that refuses everything, for content that must reach no
        // provider at all. A replay standing on a retained result proves it by
        // succeeding here: had it asked, this would have answered by failing.
        yield* IssueApi.around({
          // deno-lint-ignore require-yield
          *read(): Operation<IssueDetails> {
            throw new Error("this content reached an issue provider");
          },
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            throw new Error("this content reached an issue provider");
          },
        });
        return yield* content();
      },
    },
    {
      name: "IssueApiOverride",
      origin: "@executablemd/workflow/test",
      props: URL_PROP,
      *fn(props: Record<string, Json>): Operation<string> {
        if (!(yield* hasContent())) {
          return "";
        }
        const answered = String(props.url);
        // A nearer surface, for this content and nothing else. It answers both
        // methods, so a scenario can show precedence applies to each.
        yield* IssueApi.around({
          // deno-lint-ignore require-yield
          *read(): Operation<IssueDetails> {
            log.overrides += 1;
            return {
              url: answered,
              title: "Overridden",
              description: "Answered by a nearer surface.",
              tags: [],
              assignee: null,
            };
          },
          // deno-lint-ignore require-yield
          *upsert(): Operation<IssueReference> {
            log.overrides += 1;
            return { url: answered };
          },
        });
        return yield* content();
      },
    },
  ]);
}

/**
 * An Atlassian-shaped provider: the same normalized fields, another service.
 *
 * It proves the contract is portable rather than GitHub's shape renamed, and it
 * is the provider a routed-away request must not reach.
 */
function* useAtlassianIssues(
  log: ProviderLog,
  ceiling: readonly string[],
  refuses: boolean,
): Operation<void> {
  function mine(url: string, provider: string | undefined): boolean {
    return provider === undefined
      ? hostOf(url)?.endsWith(".atlassian.net") === true
      : provider === "atlassian";
  }

  yield* IssueApi.around(
    {
      *read([url, read], next): Operation<IssueDetails> {
        if (!mine(url, read.provider)) {
          return yield* next(url, read);
        }
        log.atlassian.reads += 1;
        if (refuses || !withinIssueCeiling(ceiling, url)) {
          throw new IssueUnavailableError();
        }
        return {
          url,
          title: "An Atlassian issue",
          description: "Read from an Atlassian-shaped tracker.",
          tags: ["tracked"],
          assignee: null,
        };
      },
      *upsert([issue, upsert], next): Operation<IssueReference> {
        if (!mine(upsert.url, upsert.provider)) {
          return yield* next(issue, upsert);
        }
        log.atlassian.upserts += 1;
        log.keys.push(upsert.idempotencyKey);
        if (refuses || !withinIssueCeiling(ceiling, upsert.url)) {
          throw new IssueUnavailableError();
        }
        const held = log.atlassianIssues.get(upsert.idempotencyKey);
        if (held !== undefined) {
          return { url: held };
        }
        const key = `PROJ-${log.atlassianIssues.size + 1}`;
        const url = `https://acme.atlassian.net/browse/${key}`;
        log.atlassianIssues.set(upsert.idempotencyKey, url);
        return { url };
      },
    },
    { at: "min" },
  );
}

/** Watch every request that enters the boundary, whichever provider takes it. */
export function* useKeyRecorder(log: ProviderLog): Operation<void> {
  // Installed into the caller's scope, not a scope of its own: a `scoped()`
  // here would close the moment this returned and take the handler with it.
  yield* IssueApi.around({
    *upsert([issue, upsert], next): Operation<IssueReference> {
      log.keys.push(upsert.idempotencyKey);
      return yield* next(issue, upsert);
    },
  });
}
