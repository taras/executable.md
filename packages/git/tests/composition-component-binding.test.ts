/**
 * One registry, one authored body, and the invocation an owning execution
 * authenticates for it.
 *
 * Every row drives the actual shared components through canonical execution,
 * over the whole vocabulary registered as the Plugin registers it. What differs
 * between rows is the policy an owning execution declares underneath: these are
 * neutral constructors and fake policies, so what is proven is the authored
 * behavior and the identity each invocation runs under rather than any host's
 * retention. The real native assembly, its retention and its cancellation are
 * covered by the CLI and native suites.
 *
 * These rows carry A1, A2 and the binding half of A5 of the component-boundary
 * repair matrix.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, Component, registerComponents } from "@executablemd/core";
import type { ComponentRegistration, Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation, IdentityComponent } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { COMPOSITION_REGISTRATIONS } from "../src/composition/installation.ts";
import { pushDeclaration } from "../src/composition/components/GitPush.ts";
import { issueDeclaration } from "../src/composition/components/Issue.ts";
import type { BindOperations } from "../src/composition/invocation-binding.ts";
// From the subpath that publishes them rather than from the source modules:
// these are public types, and reaching them by relative path would bypass the
// export map the partition test holds every consumer to.
import type { IssueDetails, IssueReference } from "@executablemd/git/api";
import type { IssueOperationsApi } from "../src/issue/operations.ts";
import type { PullRequestOperationsApi } from "../src/composition/pull-request-operations.ts";
import { COMPOSITION_ORIGIN } from "../src/composition/definitions.ts";

/** The two operations A's retained entry owns, by the names a document writes. */
const OWNED: readonly string[] = ["Git.Push", "Issue"];

/** The six operations no local transaction encloses, by the names a document writes. */
const OPERATIONS: readonly string[] = [
  "Git.Push",
  "Issue",
  "PullRequest",
  "PullRequest.Checks",
  "PullRequest.Comments",
  "PullRequest.Reviews",
];

/** The tracker every upsert row files in. */
const TRACKER = "https://github.com/octo/project";

/** What one row watched its policy be asked for. */
interface Watched {
  /** Each authenticated site a facade was built for, in the order built. */
  readonly sites: string[];
  /** Each operation performed, in the order the bodies asked for them. */
  readonly performed: string[];
}

function watched(): Watched {
  return { sites: [], performed: [] };
}

/** One issue reference, built out of nothing: these rows retain no history. */
function reference(url: string): IssueReference {
  return { url };
}

function details(url: string): IssueDetails {
  return { url, title: "fake", description: "fake", tags: [], assignee: null };
}

/**
 * A policy that answers both issue operations itself and records what it was
 * asked.
 *
 * Fake on purpose: what these rows are about is the handoff, so the policy
 * below reaches no service, no journal and no provider. A real one is the
 * entry's, and the native suites drive that.
 */
function fakeIssuePolicy(seen: Watched) {
  return (site: string): IssueOperationsApi => {
    seen.sites.push(site);
    return {
      read: function* (invocation): Operation<IssueDetails> {
        seen.performed.push(`read ${invocation.url}`);
        return details(invocation.url);
      },
      upsert: function* (invocation): Operation<IssueReference> {
        seen.performed.push(`upsert ${invocation.target}`);
        return reference(`${invocation.target}/issues/1`);
      },
    };
  };
}

/**
 * The declarations one row installs, as an owning execution installs them.
 *
 * One constructor per operation, the same ones the retained entry calls: an
 * execution declares what it owns and nothing else, and every other name in
 * this vocabulary stays the ordinary registration {@link run} makes below.
 */
function declaring(owned: {
  readonly issue: BindOperations<IssueOperationsApi>;
}): ExecutionInstallation {
  return { components: [issueDeclaration(owned.issue)] };
}

interface Ran {
  readonly output: string;
  readonly refusal: string | undefined;
}

/** One document, through canonical execution, under this row's declarations. */
function run(
  root: string,
  source: string,
  installations: readonly ExecutionInstallation[],
  before?: () => Operation<void>,
): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    const path = join(root, `entry-${crypto.randomUUID()}.md`);
    yield* writeTextFile(path, source);
    // The whole vocabulary, as the Plugin registers it for every command. What
    // a row declares below is attached inside the execution, over the ordinary
    // registration of that same name — so a declaration that failed to reach
    // its policy would reach the registered default's missing provider here
    // rather than silently resolving to nothing.
    yield* registerComponents(COMPOSITION_REGISTRATIONS);
    if (before !== undefined) {
      yield* before();
    }
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream: new InMemoryStream(), includes: [root] }, [
            ...installations,
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, refusal };
  });
}

/** This suite's own directory, for the documents it writes. */
function useRoot(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "composition-binding-")));
    yield* ensure(() => until(rm(root, { recursive: true, force: true })));
    yield* provide(root);
  });
}

/**
 * One declaration of each operation A's retained entry owns.
 *
 * Built with policy nothing reaches: these rows are about what a declaration
 * says, and a constructor that had to perform in order to describe would be
 * telling an inspector something only a run can know.
 */
function ownedDeclarations(): readonly IdentityComponent[] {
  return [
    pushDeclaration(() => () => {
      throw new Error("a described declaration performed");
    }),
    issueDeclaration(fakeIssuePolicy(watched())),
  ];
}

/** The registration and the owned declaration of one name, for comparison. */
function paired(name: string): {
  registration: ComponentRegistration | undefined;
  declaration: IdentityComponent | undefined;
} {
  return {
    registration: COMPOSITION_REGISTRATIONS.find((entry) => entry.name === name),
    declaration: ownedDeclarations().find((entry) => entry.name === name),
  };
}

describe("one registry for every repository operation, and the policy an execution owns", () => {
  it("A1: describes one component whichever path carries it", function* (): Operation<void> {
    // The whole vocabulary is registered ordinarily, and an execution that owns
    // one of these operations declares that same name again with its own policy
    // under it. What a reader is told is the same either way: same origin, same
    // props, same return contract, same forms, same prose. A metadata
    // difference here would be two components under one name.
    for (const name of OWNED) {
      const { registration, declaration } = paired(name);
      expect(registration).toBeDefined();
      expect(declaration).toBeDefined();
      expect(declaration?.origin).toBe(registration?.origin);
      expect(declaration?.origin).toBe(COMPOSITION_ORIGIN);
      expect(declaration?.props).toEqual(registration?.props);
      expect(declaration?.returns).toEqual(registration?.returns);
      expect(declaration?.forms).toEqual(registration?.forms);
      expect(declaration?.description).toBe(registration?.description);
    }
  });

  it("A1: one registry carries all twelve names, the six operations included", function* (): Operation<void> {
    // There is no second catalog and no reduced one. Every command that carries
    // this vocabulary registers the same twelve, which is what says the names
    // exist — to a run, to validation and to `xmd syntax` alike.
    const registered = COMPOSITION_REGISTRATIONS.map((entry) => entry.name);
    expect(registered).toHaveLength(12);
    expect(new Set(registered).size).toBe(12);
    for (const name of OPERATIONS) {
      expect(registered).toContain(name);
    }
    // What an owning execution adds is policy for the operations it retains,
    // under names this registry already has. It establishes no name of its own.
    const owned = ownedDeclarations().map((entry) => entry.name);
    expect(owned).toEqual([...OWNED]);
    for (const name of owned) {
      expect(registered).toContain(name);
    }
  });

  it("A1: building declarations calls no factory and initializes no policy", function* (): Operation<void> {
    let built = 0;
    const declarations = [
      issueDeclaration((site: string): IssueOperationsApi => {
        built += 1;
        return fakeIssuePolicy(watched())(site);
      }),
    ];
    expect(declarations).toHaveLength(1);
    // Inspection and validation read these. Nothing has been authenticated,
    // nothing has been bound, and no policy exists yet.
    expect(built).toBe(0);
    expect(declarations.map((entry) => entry.name)).toEqual(["Issue"]);
  });

  it("A1: canonical dispatch decides the form, whatever a contextual answer says", function* (): Operation<void> {
    const root = yield* useRoot();
    const seen = watched();

    // A handler that reports the opposite shape to anything that asks. The form
    // this element was written as is the scan's, so the read body runs and the
    // upsert body does not.
    const lying = function* (): Operation<void> {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *hasContent(): Operation<boolean> {
          return true;
        },
      });
    };

    const ran = yield* run(
      root,
      [
        `<IssueTracker url=${JSON.stringify(TRACKER)}>`,
        `<Issue url=${JSON.stringify(`${TRACKER}/issues/7`)} as="found" />`,
        `</IssueTracker>`,
        "",
      ].join("\n"),
      [declaring({ issue: fakeIssuePolicy(seen) })],
      lying,
    );

    expect(ran.refusal).toBe(undefined);
    expect(seen.performed).toEqual([`read ${TRACKER}/issues/7`]);
  });

  it("A2: a nested read finishes before the upsert around it is performed", function* (): Operation<void> {
    const root = yield* useRoot();
    const seen = watched();

    const ran = yield* run(
      root,
      [
        `<IssueTracker url=${JSON.stringify(TRACKER)}>`,
        `<Issue title="Outer" as="filed">`,
        `what the inner read found: <Issue url=${JSON.stringify(`${TRACKER}/issues/3`)} as="inner" />{inner.url}`,
        `</Issue>`,
        `</IssueTracker>`,
        "",
      ].join("\n"),
      [declaring({ issue: fakeIssuePolicy(seen) })],
    );

    expect(ran.refusal).toBe(undefined);
    // The child's own operation first: an upsert renders its description before
    // it is offered, so a child that retains work of its own finishes first.
    expect(seen.performed).toEqual([`read ${TRACKER}/issues/3`, `upsert ${TRACKER}`]);
    // Two invocations, two facades, two sites — the outer one built first.
    expect(seen.sites).toHaveLength(2);
    expect(new Set(seen.sites).size).toBe(2);
  });

  it("A2: two concurrent invocations keep their own sites", function* (): Operation<void> {
    const root = yield* useRoot();
    const seen = watched();

    const ran = yield* run(
      root,
      [
        `<IssueTracker url=${JSON.stringify(TRACKER)}>`,
        `<All>`,
        `<Spawn><Issue title="One" as="one">first</Issue></Spawn>`,
        `<Spawn><Issue title="Two" as="two">second</Issue></Spawn>`,
        `</All>`,
        `</IssueTracker>`,
        "",
      ].join("\n"),
      [declaring({ issue: fakeIssuePolicy(seen) })],
    );

    expect(ran.refusal).toBe(undefined);
    expect(seen.sites).toHaveLength(2);
    expect(new Set(seen.sites).size).toBe(2);
  });

  it("A5: cancelling an invocation stops the operation it was performing", function* (): Operation<void> {
    const root = yield* useRoot();
    const seen = watched();
    const reached = withResolvers<void>();

    // The upsert suspends where a slow service would, and this row halts the
    // whole execution while it is standing there.
    const suspending = (site: string): IssueOperationsApi => {
      seen.sites.push(site);
      return {
        read: function* (invocation): Operation<IssueDetails> {
          return details(invocation.url);
        },
        upsert: function* (invocation): Operation<IssueReference> {
          seen.performed.push(`upsert ${invocation.target}`);
          reached.resolve();
          yield* suspend();
          throw new Error("a suspended upsert resumed");
        },
      };
    };

    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(
          root,
          [
            `<IssueTracker url=${JSON.stringify(TRACKER)}>`,
            `<Issue title="Filed" as="filed">described</Issue>`,
            `</IssueTracker>`,
            "",
          ].join("\n"),
          [declaring({ issue: suspending })],
        ),
      );
      yield* race([
        reached.operation,
        (function* (): Operation<never> {
          yield* sleep(30_000);
          throw new Error("the upsert never reached its policy");
        })(),
      ]);
      // Joined here: the halt returns once the suspended upsert has been torn
      // down, so what follows cannot be read before cancellation finished.
      yield* task.halt();
    });

    // The upsert was entered once, never resumed and never performed again.
    expect(seen.performed).toEqual([`upsert ${TRACKER}`]);
    expect(seen.sites).toHaveLength(1);
  });
});
