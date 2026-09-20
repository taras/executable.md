/**
 * When the bundled GitHub adapter is allowed to touch anything outside this
 * process.
 *
 * Installing the Plugin makes the vocabulary available. It does not read a
 * variable, obtain a credential or open a socket, and neither does describing
 * the vocabulary, validating a Plan, or running a document that writes none of
 * it. The first invoked GitHub-backed operation is what changes that, and even
 * then it happens in one order:
 *
 *     installation → target recognition → configuration → credential → transport
 *
 * Everything driven through the *real* host assembly — the ordinary-run
 * profile and a retained workflow run — lives in
 * `github-workflow-activation.test.ts`, because assembling either reaches
 * Workflow's storage adapter and so `node:sqlite`. What is here installs the
 * adapters directly and is portable across all three runtimes.
 *
 * Every step is observed here through a boundary the case installs itself, and
 * the negative cases install boundaries that *throw*. A spy that merely counts
 * would let an unwanted read pass and be discovered by an assertion afterwards;
 * one that throws refuses it where it happens, and the case that expected the
 * read still gets its answer.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { gitPlugin } from "../src/plugin.ts";
import { IssueApi } from "../src/issue/api.ts";
import { GITHUB, useGitHubIssues } from "../src/deno/issue/github.ts";
import { useGitHubPullRequestReads } from "../src/deno/composition/pull-request-reads.ts";
import { GITHUB_PULL_REQUESTS_ENV } from "../src/deno/composition/pull-request-configuration.ts";
import { PullRequestAPI } from "../src/composition/pull-request-api.ts";
import type {
  GitHubAccess,
  GitHubHttpResponse,
  GitHubSource,
} from "../src/deno/composition/github.ts";
import { GITHUB_ISSUES_ENV } from "../src/deno/issue/configuration.ts";
import { fakeGitHubAccess, gitHubStore } from "./support/github.ts";

/** Where every step this suite watches records itself, in the order it happened. */
type Step = "configuration" | "source" | "open" | "credential" | "transport";

/** A transport factory that refuses to be built at all. */
function forbidden(): GitHubSource {
  throw new Error("a GitHub transport was built");
}

/**
 * A host whose every outward boundary refuses.
 *
 * Installed around the negative cases. Each one names what it caught, so a
 * failure says which boundary was crossed rather than only that one was.
 */
function* refusing(): Operation<void> {
  yield* API.Env.around(
    {
      *env([name], next): Operation<string | undefined> {
        if (name.startsWith("XMD_WORKFLOW_GITHUB")) {
          throw new Error(`configuration was read: ${name}`);
        }
        return yield* next(name);
      },
    },
    { at: "min" },
  );
}

/**
 * The established GitHub fake, with each boundary crossing recorded as it
 * happens.
 *
 * Wrapped rather than re-implemented: what this case is about is the *order*
 * the boundaries are crossed in, and a hand-written payload would be asserting
 * the shape of my own fixture instead.
 */
function recording(steps: Step[]): { host: (endpoint?: string) => GitHubSource } {
  const store = gitHubStore({
    issues: [{ nodeId: "I_1", number: 7, state: "open", title: "a title", body: null }],
  });
  const answering = fakeGitHubAccess(store);
  const access: GitHubAccess = {
    endpoint: answering.endpoint,
    *token(): Operation<string | undefined> {
      steps.push("credential");
      return yield* answering.token();
    },
    *send(request): Operation<GitHubHttpResponse> {
      steps.push("transport");
      return yield* answering.send(request);
    },
  };
  return {
    host: () => {
      steps.push("source");
      return {
        endpoint: access.endpoint,
        // deno-lint-ignore require-yield
        *open(): Operation<GitHubAccess> {
          steps.push("open");
          return access;
        },
      };
    },
  };
}

/**
 * A transport that answers one reviews collection, recording each crossing.
 *
 * Purpose-built rather than borrowed: the shared GitHub fake answers issue and
 * pull-request mutation endpoints and no evidence ones, and what this case
 * needs is a complete — if empty — collection so the read succeeds and the
 * ordering is the only thing under test.
 */
function reviewing(steps: Step[]): (endpoint?: string) => GitHubSource {
  const endpoint = "https://api.github.test";
  const access: GitHubAccess = {
    endpoint,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      steps.push("credential");
      return "a-token";
    },
    // deno-lint-ignore require-yield
    *send(request): Operation<GitHubHttpResponse> {
      steps.push("transport");
      const { pathname } = new URL(request.url);
      if (pathname !== "/repos/octo/project/pulls/7/reviews") {
        throw new Error(`the adapter asked for ${pathname}`);
      }
      return { status: 200, body: "[]" };
    },
  };
  return () => {
    steps.push("source");
    return {
      endpoint,
      // deno-lint-ignore require-yield
      *open(): Operation<GitHubAccess> {
        steps.push("open");
        return access;
      },
    };
  };
}

/** One document, executed with the bundled Plugin installed and nothing else. */
function* document(source: string): Operation<unknown> {
  const stream = new InMemoryStream();
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installed nothing");
  }
  const contribution = yield* install.call(gitPlugin, { command: "run", args: ["run"] });
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(source), stream }, [
      { admissions: [...(contribution?.admissions ?? [])] },
    ]),
  );
}

describe("what installing the bundled GitHub adapter costs", () => {
  it("reads no configuration when the Plugin is installed and nothing is invoked", function* () {
    // The whole contribution — declarations and admissions — with every
    // outward boundary refusing. Installation is the thing under test.
    yield* refusing();
    const install = gitPlugin.install;
    if (install === undefined) {
      throw new Error("the Git Plugin installed nothing");
    }
    const contribution = yield* install.call(gitPlugin, { command: "run", args: ["run"] });
    expect(contribution?.admissions).toHaveLength(2);
    // And the adapters themselves, installed as the host installs them.
    yield* useGitHubIssues({
      host: () => ({
        endpoint: "https://api.github.test",
        *open(): Operation<GitHubAccess> {
          throw new Error("a credential was obtained");
        },
      }),
    });
  });

  it("reads no configuration for a document that writes no GitHub vocabulary", function* () {
    const rendered = yield* scoped(function* () {
      yield* refusing();
      yield* useGitHubIssues({
        host: () => ({
          endpoint: "https://api.github.test",
          *open(): Operation<GitHubAccess> {
            throw new Error("a credential was obtained");
          },
        }),
      });
      return yield* document("nothing here reaches a service\n");
    });
    expect(String(rendered)).toContain("nothing here reaches a service");
  });

  it("reads no configuration for a destination another provider owns", function* () {
    // Target recognition comes first, and it reads nothing outside the
    // process. A tracker somewhere else therefore passes this adapter without
    // its configuration ever being consulted — which is what lets a second
    // adapter be installed beside it.
    const failure = yield* scoped(function* () {
      yield* refusing();
      yield* useGitHubIssues({
        host: () => ({
          endpoint: "https://api.github.test",
          *open(): Operation<GitHubAccess> {
            throw new Error("a credential was obtained");
          },
        }),
      });
      try {
        yield* IssueApi.operations.read("https://tracker.example/browse/AB-1", {});
        return undefined;
      } catch (error) {
        return error;
      }
    });
    // It reached `IssueApi`'s own base, which is what "nothing handles this"
    // means — not a refusal this adapter made after reading something.
    expect(String(failure)).toContain("no issue provider");
  });

  it("crosses configuration, credential and transport in that order, once", function* () {
    const steps: Step[] = [];
    const { host } = recording(steps);
    const details = yield* scoped(function* () {
      yield* API.Env.around(
        {
          *env([name], next): Operation<string | undefined> {
            if (name !== GITHUB_ISSUES_ENV) {
              return yield* next(name);
            }
            steps.push("configuration");
            return JSON.stringify({ ceiling: ["https://github.com/octo/project"] });
          },
        },
        { at: "min" },
      );
      yield* useGitHubIssues({ host });
      return yield* IssueApi.operations.read("https://github.com/octo/project/issues/7", {
        provider: GITHUB,
      });
    });

    expect(steps).toEqual(["configuration", "source", "open", "credential", "transport"]);
    expect(details.url).toBe("https://github.com/octo/project/issues/7");
  });

  it("crosses the same boundaries in order for a pull-request read", function* () {
    // The pull-request half has its own lazy configuration and its own
    // transport resolution — the `resolver()`/`transports()` pair behind
    // `gitHubPullRequestAccess()` — so proving the issue adapter's ordering
    // proves nothing about this one. A reviews read is enough: what is under
    // test is when each boundary is crossed, not that a pull request changed.
    const steps: Step[] = [];
    const host = reviewing(steps);
    const reviews = yield* scoped(function* () {
      yield* API.Env.around(
        {
          *env([name], next): Operation<string | undefined> {
            if (name !== GITHUB_PULL_REQUESTS_ENV) {
              return yield* next(name);
            }
            steps.push("configuration");
            return JSON.stringify({ allowed: ["https://github.com/octo/project"] });
          },
        },
        { at: "min" },
      );
      yield* useGitHubPullRequestReads({ host });
      return yield* PullRequestAPI.operations.read("https://github.com/octo/project/pull/7", {
        kind: "reviews",
      });
    });

    // Target recognition comes first and records nothing, because it reads
    // nothing: the case above that names another provider's destination
    // records an empty sequence, which is what proves the order begins there.
    expect(steps).toEqual(["configuration", "source", "open", "credential", "transport"]);
    // The collection really was read — a refusal would have thrown, and an
    // adapter that answered without asking would record no transport.
    expect(`${reviews.kind}:${reviews.items.length}`).toBe("reviews:0");
  });

  it("refuses outside the ceiling without opening a credential", function* () {
    const steps: Step[] = [];
    const { host } = recording(steps);
    const failure = yield* scoped(function* () {
      yield* API.Env.around(
        {
          *env([name], next): Operation<string | undefined> {
            if (name !== GITHUB_ISSUES_ENV) {
              return yield* next(name);
            }
            steps.push("configuration");
            return JSON.stringify({ ceiling: ["https://github.com/octo/elsewhere"] });
          },
        },
        { at: "min" },
      );
      yield* useGitHubIssues({ host });
      try {
        yield* IssueApi.operations.read("https://github.com/octo/project/issues/7", {
          provider: GITHUB,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(failure).toBeDefined();
    // Configuration was read, because the target was this adapter's. Nothing
    // after it was: a refusal at the ceiling is a refusal before an identity
    // exists for the target that was refused.
    expect(steps).toEqual(["configuration"]);
  });

  it("refuses with no configuration at all before any credential", function* () {
    const steps: Step[] = [];
    const { host } = recording(steps);
    const failure = yield* scoped(function* () {
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *env(): Operation<string | undefined> {
            steps.push("configuration");
            return undefined;
          },
        },
        { at: "min" },
      );
      yield* useGitHubIssues({ host });
      try {
        yield* IssueApi.operations.read("https://github.com/octo/project/issues/7", {
          provider: GITHUB,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });

    // Nothing authorized is the same answer as no adapter at all.
    expect(String(failure)).toContain("no issue provider");
    expect(steps).toEqual(["configuration"]);
  });
});
