/**
 * `<Ticket.Checkout>`, the adversarial workflow's read of HEAD and tracked
 * changes, run as the actual Markdown component from its include directory
 * under the ordinary run's repository provider.
 *
 * The staged and unstaged reads are independent: each owns its containment and
 * private index. The first case holds every read until both have entered, so a
 * component that waits for one before starting the other cannot answer it. The
 * rest prove the paired answer itself is unchanged — exact HEAD, both tracked
 * comparisons, untracked files excluded, a fresh read every invocation, the
 * source index untouched — and that the pair is one owner: a failed or
 * cancelled read is not reported until its sibling's cleanup has finished.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensure, race, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeTextFile } from "@effectionx/fs";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { API, Permissions, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useCompositionComponents } from "@executablemd/git";
import { useRunComposition } from "@executablemd/git/deno";
import { GitQuery } from "@executablemd/git/api";
import type { GitChangesInvocation, GitChangesResult } from "@executablemd/git/api";
import { git } from "../../git/tests/support/git-remotes.ts";
import { actionProbe, capturingProbe } from "../../git/tests/support/observations.ts";

const COMPONENTS = fileURLToPath(
  new URL("../../../examples/adversarial-implementation/components", import.meta.url),
);

interface Checkout {
  readonly root: string;
  run(...args: string[]): string;
  write(path: string, content: string): Operation<void>;
  index(): Operation<string>;
}

function* useCheckout(prefix: string): Operation<Checkout> {
  const home = yield* useTempDirectory(`${prefix}-home-`);
  const parent = yield* until(realpath(yield* useTempDirectory(`${prefix}-`)));
  const root = join(parent, "checkout");
  git(["init", "--initial-branch=main", root], parent, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);
  yield* writeTextFile(join(root, "tracked.txt"), "first\n");
  git(["add", "--", "tracked.txt"], root, home);
  git(["commit", "--quiet", "-m", "first"], root, home);
  return {
    root,
    run: (...args: string[]) => git(args, root, home),
    write: (path: string, content: string) => writeTextFile(join(root, path), content),
    *index(): Operation<string> {
      const bytes = yield* until(readFile(join(root, ".git", "index")));
      return createHash("sha256").update(bytes).digest("hex");
    },
  };
}

interface RunOptions {
  readonly components?: readonly ComponentRegistration[];
  readonly around?: () => Operation<void>;
}

function runChecked(source: string, checkout: Checkout, options: RunOptions = {}): Operation<Json> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return checkout.root;
        },
      },
      { at: "min" },
    );
    yield* Permissions.around(
      { files: ([operation], next) => (operation === "absolute" ? true : next(operation)) },
      { at: "min" },
    );
    yield* useHostFiles();
    yield* useComponentModuleLoader();
    yield* useCompositionComponents();
    const managed = yield* until(realpath(yield* useTempDirectory("xmd-checkout-managed-")));
    yield* useRunComposition({
      root: join(managed, "repositories"),
      cwd: checkout.root,
      // deno-lint-ignore require-yield
      *identity(): Operation<string | undefined> {
        return "Fixture <fixture@example.invalid> 0 +0000";
      },
    });
    if (options.components !== undefined) {
      yield* registerComponents([...options.components]);
    }
    if (options.around !== undefined) {
      yield* options.around();
    }
    return yield* collect(
      yield* execute({
        ...inlineSource(source),
        stream: new InMemoryStream(),
        includes: [COMPONENTS],
      }),
    );
  });
}

function checkoutOf(repository: string, as = "checkout"): string {
  return `<Ticket.Checkout repository=${JSON.stringify(repository)} as="${as}" />`;
}

/** Run `<Ticket.Checkout>` once against this checkout and answer its bound value. */
function* readCheckout(checkout: Checkout, options: RunOptions = {}): Operation<Json> {
  const seen: Json[] = [];
  yield* runChecked(
    [checkoutOf(checkout.root), "", "<Captured value={checkout} />", ""].join("\n"),
    checkout,
    {
      ...options,
      components: [capturingProbe(seen), ...(options.components ?? [])],
    },
  );
  expect(seen.length).toBe(1);
  return seen[0];
}

function change(path: string, status: string): Json {
  return { path, status, previousPath: null };
}

function expected(head: string, staged: Json[], unstaged: Json[]): Json {
  return {
    head,
    clean: staged.length === 0 && unstaged.length === 0,
    staged: { comparison: { compare: "staged", base: head }, changes: staged, next: null },
    unstaged: { comparison: { compare: "unstaged" }, changes: unstaged, next: null },
  };
}

function requested(invocation: GitChangesInvocation): string {
  return invocation.request.comparison.compare;
}

describe("Ticket.Checkout — staged and unstaged reads", () => {
  it("starts both reads before either answers", function* () {
    const checkout = yield* useCheckout("xmd-checkout-barrier");
    const entered: string[] = [];
    const both = withResolvers<void>();
    const value = yield* readCheckout(checkout, {
      *around() {
        yield* GitQuery.around({
          *changes(args, next): Operation<GitChangesResult> {
            entered.push(requested(args[0]));
            if (entered.length === 2) {
              both.resolve();
            }
            // A component that waits for one read to answer before asking the
            // other never lets the second one enter.
            yield* race([
              both.operation,
              (function* () {
                yield* sleep(10_000);
                throw new Error(
                  `only ${entered.join(", ")} entered before the first read answered`,
                );
              })(),
            ]);
            return yield* next(...args);
          },
        });
      },
    });
    expect(new Set(entered)).toEqual(new Set(["staged", "unstaged"]));
    expect(value).toEqual(expected(checkout.run("rev-parse", "HEAD"), [], []));
  });

  it("answers exact HEAD and tracked changes, fresh each time, leaving the index alone", function* () {
    const checkout = yield* useCheckout("xmd-checkout-states");
    const observe = function* (staged: Json[], unstaged: Json[]): Operation<void> {
      const index = yield* checkout.index();
      const value = yield* readCheckout(checkout);
      expect(value).toEqual(expected(checkout.run("rev-parse", "HEAD"), staged, unstaged));
      expect(yield* checkout.index()).toBe(index);
    };

    yield* observe([], []);

    // Untracked files are in neither comparison, so the checkout stays clean.
    yield* checkout.write("untracked.txt", "untracked\n");
    yield* observe([], []);

    yield* checkout.write("tracked.txt", "staged\n");
    checkout.run("add", "--", "tracked.txt");
    yield* observe([change("tracked.txt", "M")], []);

    checkout.run("commit", "--quiet", "-m", "second");
    yield* checkout.write("tracked.txt", "unstaged\n");
    yield* observe([], [change("tracked.txt", "M")]);

    // A staged edit whose working copy went back to HEAD is dirty both ways,
    // which a single HEAD-to-working-tree comparison would call clean.
    yield* checkout.write("tracked.txt", "staged again\n");
    checkout.run("add", "--", "tracked.txt");
    yield* checkout.write("tracked.txt", "staged\n");
    yield* observe([change("tracked.txt", "M")], [change("tracked.txt", "M")]);
  });

  it("reads again after HEAD and the working tree move within one execution", function* () {
    const checkout = yield* useCheckout("xmd-checkout-fresh");
    const before = checkout.run("rev-parse", "HEAD");
    const seen: Json[] = [];
    yield* runChecked(
      [
        checkoutOf(checkout.root, "first"),
        "",
        "<Captured value={first} />",
        "",
        "<Move />",
        "",
        checkoutOf(checkout.root, "second"),
        "",
        "<Captured value={second} />",
        "",
      ].join("\n"),
      checkout,
      {
        components: [
          capturingProbe(seen),
          actionProbe("Move", function* () {
            yield* checkout.write("tracked.txt", "moved\n");
            checkout.run("commit", "--quiet", "-am", "moved");
            yield* checkout.write("tracked.txt", "dirty\n");
          }),
        ],
      },
    );
    const after = checkout.run("rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(seen).toEqual([
      expected(before, [], []),
      expected(after, [], [change("tracked.txt", "M")]),
    ]);
  });

  it("refuses a checkout the ambient repository does not select", function* () {
    const checkout = yield* useCheckout("xmd-checkout-ambient");
    const foreign = yield* useCheckout("xmd-checkout-foreign");
    let refusal: unknown;
    try {
      yield* runChecked(checkoutOf(foreign.root), checkout);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).toContain(
      "GitOperationAdmissionError: <Git.Changes> is not admitted against this run's retained " +
        "state: the directory it was written in is inside none of the checkouts this execution " +
        "selected for the repository in scope.",
    );
  });
});

describe("Ticket.Checkout — one owner for both reads", () => {
  it("reports a failed read only after its sibling's cleanup has finished", function* () {
    const checkout = yield* useCheckout("xmd-checkout-failure");
    const held = withResolvers<void>();
    const gate = withResolvers<void>();
    const order: string[] = [];
    const task = yield* spawn(function* () {
      try {
        yield* readCheckout(checkout, {
          *around() {
            yield* GitQuery.around({
              *changes(args, _next): Operation<GitChangesResult> {
                if (requested(args[0]) === "staged") {
                  yield* ensure(function* () {
                    order.push("cleanup started");
                    yield* gate.operation;
                    order.push("cleanup finished");
                  });
                  held.resolve();
                  yield* suspend();
                }
                yield* held.operation;
                throw new Error("the unstaged read failed");
              },
            });
          },
        });
      } catch (error) {
        order.push("caller settled");
        return error;
      }
      throw new Error("the checkout read did not fail");
    });
    yield* held.operation;
    // Long enough for a caller that does not wait for cleanup to settle first.
    yield* sleep(200);
    expect(order).toEqual(["cleanup started"]);
    gate.resolve();
    const error = yield* task;
    expect(String(error)).toContain("the unstaged read failed");
    expect(order).toEqual(["cleanup started", "cleanup finished", "caller settled"]);
  });

  it("does not finish halting until every held read has cleaned up", function* () {
    const checkout = yield* useCheckout("xmd-checkout-cancel");
    const entered: string[] = [];
    const both = withResolvers<void>();
    const gate = withResolvers<void>();
    const order: string[] = [];
    const task = yield* spawn(function* () {
      yield* readCheckout(checkout, {
        *around() {
          yield* GitQuery.around({
            *changes(args, _next): Operation<GitChangesResult> {
              const compare = requested(args[0]);
              yield* ensure(function* () {
                yield* gate.operation;
                order.push(`${compare} cleaned up`);
              });
              entered.push(compare);
              if (entered.length === 2) {
                both.resolve();
              }
              yield* suspend();
              throw new Error("a held read resumed");
            },
          });
        },
      });
    });
    yield* both.operation;
    const halting = yield* spawn(function* () {
      yield* task.halt();
      order.push("halted");
    });
    yield* sleep(200);
    expect(order).toEqual([]);
    gate.resolve();
    yield* halting;
    expect(new Set(order.slice(0, 2))).toEqual(
      new Set(["staged cleaned up", "unstaged cleaned up"]),
    );
    expect(order[2]).toBe("halted");
  });
});
