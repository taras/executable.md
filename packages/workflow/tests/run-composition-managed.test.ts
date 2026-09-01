/**
 * Tier ORC — managed checkouts under an ordinary `xmd run`.
 *
 * What makes a checkout this execution's is an advisory lock, and what makes it
 * the same checkout tomorrow is the sidecar beside it. So this is where
 * persistence, compatible reuse, non-mutating conflict refusal, adoption of an
 * interrupted creation, and exclusive ownership across real processes are
 * asked.
 *
 * Every repository is real, every Git command is real, every lock is taken from
 * the operating system, and the managed root is a temporary directory of the
 * suite's own — no test ever touches the user's `~/.xmd/repositories`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { git, useBareRemote } from "./support/git-remotes.ts";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { spawn, withResolvers } from "effection";
import { registerComponents } from "@executablemd/core";
import type { ChildOutcome } from "./support/run-composition-child.ts";
import {
  causedBy,
  commonDirectoryOf,
  countingOrdinaryHost,
  fingerprintTree,
  gitStateOf,
  haltAtGate,
  subcommands,
  raised,
  readSidecar,
  repositorySlotOf,
  runOrdinaryDocument,
  gateComponent,
  useHostCheckout,
  useManagedRoot,
  worktreeSlotOf,
  type HostCheckout,
} from "./support/run-composition.ts";
import { CHILD, REMOTE, entriesOf, isManagedRefusal } from "./support/run-composition-tier.ts";

describe("ORC8 — managed checkouts are persistent", () => {
  it("leaves the checkout, its metadata and its working files after the run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const common = commonDirectoryOf(checkout);
    const slot = worktreeSlotOf(root, common, "kept");

    yield* runOrdinaryDocument(
      [
        `<Worktree name="kept" branch="kept">`,
        `<File path="draft.md">unfinished</File>`,
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    expect(yield* exists(slot.checkout)).toBe(true);
    expect(yield* exists(`${slot.checkout}/draft.md`)).toBe(true);
    const sidecar = yield* readSidecar(slot);
    expect(sidecar).toMatchObject({
      kind: "worktree",
      version: 1,
      name: "kept",
      requestedBranch: "kept",
      requestedBase: null,
      owner: common,
    });
  });

  it("leaves a managed Repository, its metadata and its files after the run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}">`,
        `<File path="draft.md">unfinished</File>`,
        "</Repository>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    expect(yield* exists(`${slot.checkout}/draft.md`)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({
      kind: "repository",
      version: 1,
      name: "project",
      locator: remote.locator,
      requestedBase: null,
    });
  });

  it("issues no Git or delete command for a checkout while tearing down", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const counting = countingOrdinaryHost();

    yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}" as="r" />`,
        `<Worktree name="kept" branch="kept" as="w" />`,
      ].join("\n"),
      { root, cwd: checkout.root, host: counting.host },
    );

    // Nothing that could undo a checkout ever ran — not while the document was
    // expanding, and not on the way out.
    const issued = subcommands(counting.counters);
    for (const undoing of ["reset", "clean", "restore", "prune", "gc", "fetch"]) {
      expect(`${undoing} ${issued.includes(undoing)}`).toBe(`${undoing} false`);
    }
    expect(counting.counters.commands.some((args) => args.includes("--force"))).toBe(false);
    expect(
      counting.counters.commands.some((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
  });

  it("keeps both kinds of checkout after a cancellation", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const repository = repositorySlotOf(root, remote.locator, "project");
    const worktree = worktreeSlotOf(root, commonDirectoryOf(checkout), "surviving");

    yield* haltAtGate(
      [
        `<Repository name="project" url="${remote.locator}" as="r" />`,
        `<Worktree name="surviving" branch="surviving">`,
        `<File path="in-flight.md">written before the halt</File>`,
        "<Gate />",
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    for (const slot of [repository, worktree]) {
      expect(yield* exists(slot.checkout)).toBe(true);
      expect(yield* readSidecar(slot)).not.toBe(undefined);
    }
    expect(yield* exists(`${worktree.checkout}/in-flight.md`)).toBe(true);
  });

  it("keeps a managed Repository after an authored failure inside its body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "surviving");

    yield* raised(
      runOrdinaryDocument(
        [
          `<Repository name="surviving" url="${remote.locator}">`,
          `<File path="kept.md">written before the failure</File>`,
          `<Git.Switch branch="in-progress" />`,
          `<Git.Add paths="kept.md" />`,
          `<Git.Add paths="absent-on-purpose.md" />`,
          "</Repository>",
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    // The path, the sidecar, the Git state and the working file all survive.
    expect(yield* exists(slot.checkout)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({
      kind: "repository",
      version: 1,
      name: "surviving",
      locator: remote.locator,
    });
    expect(yield* readTextFile(`${slot.checkout}/kept.md`)).toBe("written before the failure");
    // The branch the document switched to and the staging it did are both still
    // there: nothing rolled back, and nothing was cleaned up on the way out.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], slot.checkout, checkout.home)).toBe(
      "in-progress",
    );
    expect(git(["diff", "--cached", "--name-only"], slot.checkout, checkout.home)).toContain(
      "kept.md",
    );
  });

  it("keeps the checkout after an authored failure inside the Worktree body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "survivor");

    yield* raised(
      runOrdinaryDocument(
        [
          `<Worktree name="survivor" branch="survivor">`,
          `<File path="kept.md">written before the failure</File>`,
          `<Git.Add paths="absent-on-purpose.md" />`,
          "</Worktree>",
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    expect(yield* exists(`${slot.checkout}/kept.md`)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({ kind: "worktree" });
  });
});

describe("ORC9 — compatible reuse", () => {
  it("reuses the same checkout and preserves the work the first run left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="repository" />`;

    const first = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const created = yield* readSidecar(slot);

    // Work a person would do between two runs: a new branch and a commit.
    git(["switch", "-c", "later"], slot.checkout, checkout.home);
    git(["commit", "--allow-empty", "-m", "moved on"], slot.checkout, checkout.home);
    const moved = git(["rev-parse", "HEAD"], slot.checkout, checkout.home);

    // And uncommitted work: one tracked file edited, one untracked file added.
    yield* writeTextFile(`${slot.checkout}/which.txt`, "edited by hand\n");
    yield* writeTextFile(`${slot.checkout}/scratch.md`, "not committed\n");
    const dirty = git(["status", "--porcelain"], slot.checkout, checkout.home);
    expect(dirty).toContain("which.txt");
    expect(dirty).toContain("scratch.md");

    const second = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });

    expect(second).toBe(first);
    // Reuse revalidated the identity — owner, origin, object format and creation
    // commit — and recorded nothing new.
    expect(yield* readSidecar(slot)).toEqual(created);
    // Neither the branch it is on nor the commit it holds was reset.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], slot.checkout, checkout.home)).toBe("later");
    expect(git(["rev-parse", "HEAD"], slot.checkout, checkout.home)).toBe(moved);
    // And the working tree is exactly as dirty as it was left.
    expect(git(["status", "--porcelain"], slot.checkout, checkout.home)).toBe(dirty);
    expect(yield* readTextFile(`${slot.checkout}/which.txt`)).toBe("edited by hand\n");
    expect(yield* readTextFile(`${slot.checkout}/scratch.md`)).toBe("not committed\n");
  });

  it("revalidates the identity it reuses rather than trusting the sidecar", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");
    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const counting = countingOrdinaryHost();
    yield* runOrdinaryDocument(document, {
      root,
      cwd: checkout.root,
      host: counting.host,
    });

    // The second selection asked the checkout itself who it is, rather than
    // reading the sidecar and believing it.
    const issued = counting.counters.commands.map((args) => args.join(" "));
    expect(issued.some((command) => command.includes("rev-parse --show-toplevel"))).toBe(true);
    expect(issued.some((command) => command.includes("rev-parse --git-common-dir"))).toBe(true);
    expect(issued.some((command) => command.includes("rev-parse --show-object-format"))).toBe(true);
    expect(issued.some((command) => command.includes("config --get remote.origin.url"))).toBe(true);
    // And it cloned nothing.
    expect(subcommands(counting.counters)).not.toContain("clone");
  });
});

describe("ORC10 — a conflict changes nothing", () => {
  /**
   * One refusal, fingerprinted on both sides.
   *
   * The claim is not "it failed" but "it failed and changed nothing", so the
   * slot's complete byte fingerprint and the checkout's own Git state are taken
   * before the refusal and compared after it. A reset, a fetch, a switch or a
   * rewritten sidecar would all show up here.
   */
  function* refusesWithoutMutating(
    slot: ReturnType<typeof repositorySlotOf>,
    checkout: HostCheckout,
    run: () => Operation<unknown>,
    reason: string,
  ): Operation<void> {
    const bytes = yield* fingerprintTree(slot.slot);
    const state = gitStateOf(checkout, slot.checkout);

    const failure = yield* raised(run());
    expect(`${reason}: ${causedBy(failure, isManagedRefusal)?.reason}`).toBe(
      `${reason}: incompatible-reuse`,
    );

    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
    expect(gitStateOf(checkout, slot.checkout)).toEqual(state);
  }

  it("refuses every changed Repository fact and leaves the slot byte-identical", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");
    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const created = yield* readSidecar(slot);

    // A changed base. Same name, same url, different creation identity.
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () =>
        runOrdinaryDocument(
          `<Repository name="project" url="${remote.locator}" base="release" as="r" />`,
          { root, cwd: checkout.root },
        ),
      "changed base",
    );

    // A sidecar somebody edited. The object format is the member the checkout
    // itself can contradict, so this is the object-format comparison too.
    yield* writeTextFile(
      slot.metadata,
      `${JSON.stringify({ ...(created as object), objectFormat: "sha256" }, null, 2)}\n`,
    );
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "object format",
    );

    // A sidecar naming another repository's creation commit.
    yield* writeTextFile(
      slot.metadata,
      `${JSON.stringify({ ...(created as object), creationCommit: "0".repeat(40) }, null, 2)}\n`,
    );
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "metadata",
    );

    // An origin that no longer names what the checkout was cloned from.
    yield* writeTextFile(slot.metadata, `${JSON.stringify(created, null, 2)}\n`);
    git(["remote", "set-url", "origin", other.locator], slot.checkout, checkout.home);
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "origin",
    );
    git(["remote", "set-url", "origin", remote.locator], slot.checkout, checkout.home);

    // A common directory belonging to a different repository: the slot now
    // holds an unrelated clone at exactly the recorded path.
    const shadow = `${slot.slot}/shadow`;
    git(["clone", "--", other.locator, shadow], slot.slot, checkout.home);
    yield* rm(slot.checkout, { recursive: true });
    git(["clone", "--", other.locator, slot.checkout], slot.slot, checkout.home);
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "common directory",
    );
  });

  it("refuses a Worktree asked for on a different branch or base, and changes nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "review");

    yield* runOrdinaryDocument(`<Worktree name="review" branch="one" as="w" />`, {
      root,
      cwd: checkout.root,
    });
    const created = yield* readSidecar(slot);

    for (const [reason, source] of [
      ["branch", `<Worktree name="review" branch="two" as="w" />`],
      ["base", `<Worktree name="review" branch="one" base="release" as="w" />`],
    ] as const) {
      const bytes = yield* fingerprintTree(slot.slot);
      const state = gitStateOf(checkout, slot.checkout);
      const failure = yield* raised(runOrdinaryDocument(source, { root, cwd: checkout.root }));
      expect(`${reason}: ${causedBy(failure, isManagedRefusal)?.reason}`).toBe(
        `${reason}: incompatible-reuse`,
      );
      expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
      expect(gitStateOf(checkout, slot.checkout)).toEqual(state);
      expect(yield* readSidecar(slot)).toEqual(created);
    }
  });

  it("refuses a Worktree whose checkout stopped belonging to its owner", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const common = commonDirectoryOf(checkout);
    const slot = worktreeSlotOf(root, common, "owned");

    yield* runOrdinaryDocument(`<Worktree name="owned" branch="owned" as="w" />`, {
      root,
      cwd: checkout.root,
    });

    // An unrelated clone at exactly the recorded path. It is a perfectly good
    // Git checkout; what it is not is a linked worktree of the owner.
    yield* rm(slot.checkout, { recursive: true });
    git(["clone", "--", other.locator, slot.checkout], slot.slot, checkout.home);

    const bytes = yield* fingerprintTree(slot.slot);
    const failure = yield* raised(
      runOrdinaryDocument(`<Worktree name="owned" branch="owned" as="w" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("incompatible-reuse");
    expect(String(failure)).toContain("linked checkout");
    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
  });
});

describe("ORC11 — an interrupted creation", () => {
  it("adopts a metadata-free checkout that is exactly what creation would have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const written = yield* readSidecar(slot);
    // Exactly the state an interruption between the clone and the sidecar
    // leaves: the checkout, and nothing describing it.
    yield* rm(slot.metadata);
    expect(yield* readSidecar(slot)).toBe(undefined);

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(yield* readSidecar(slot)).toEqual(written);
  });

  it("refuses a slot holding something creation would never have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    yield* rm(slot.metadata);
    // An unexplained entry beside the checkout.
    yield* writeTextFile(`${slot.slot}/stray.txt`, "who put this here\n");
    const beforeEntries = yield* entriesOf(slot.slot);

    const failure = yield* raised(runOrdinaryDocument(document, { root, cwd: checkout.root }));
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("partial-creation");
    expect(yield* entriesOf(slot.slot)).toEqual(beforeEntries);
    expect(yield* readSidecar(slot)).toBe(undefined);
  });

  it("adopts a metadata-free Worktree that is exactly what creation would have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "resumed");
    const document = `<Worktree name="resumed" branch="resumed" as="w" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const written = yield* readSidecar(slot);
    yield* rm(slot.metadata);

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(yield* readSidecar(slot)).toEqual(written);
  });

  it("refuses a metadata-free Worktree that creation would never have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "moved");
    const document = `<Worktree name="moved" branch="moved" as="w" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    yield* rm(slot.metadata);
    // The branch it is on is no longer the branch this request names, so this
    // is not the state creation would have left behind.
    git(["switch", "-c", "somewhere-else"], slot.checkout, checkout.home);

    const bytes = yield* fingerprintTree(slot.slot);
    const failure = yield* raised(runOrdinaryDocument(document, { root, cwd: checkout.root }));
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("partial-creation");
    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
    expect(yield* readSidecar(slot)).toBe(undefined);
  });
});

describe("ORC12 — exclusive ownership across processes", () => {
  /** One second process, run to completion, and what it reported. */
  function* elsewhere(root: string, cwd: string, source: string): Operation<ChildOutcome> {
    const outcome = spawnSync(
      process.execPath,
      ["run", "--allow-all", "--frozen", CHILD, root, cwd, source],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const printed = outcome.stdout.trim().split("\n").at(-1) ?? "";
    if (printed === "") {
      throw new Error(`the child printed nothing: ${outcome.stderr}`);
    }
    return JSON.parse(printed) as ChildOutcome;
  }

  it("refuses a second process the slot a first is holding, and changes nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const held = worktreeSlotOf(root, commonDirectoryOf(checkout), "contended");
    const free = worktreeSlotOf(root, commonDirectoryOf(checkout), "uncontended");
    // The child renders what it bound, so the parent can read the path back.
    const document = `<Worktree name="contended" branch="contended" as="w" />\n\n{w}`;

    const opened = withResolvers<void>();
    let reached = false;
    const holder = yield* spawn(() =>
      scoped(function* () {
        yield* registerComponents([
          gateComponent(() => {
            if (!reached) {
              reached = true;
              opened.resolve();
            }
          }),
        ]);
        yield* runOrdinaryDocument(
          [
            `<Worktree name="contended" branch="contended">`,
            `<File path="held.md">held by the first process</File>`,
            "<Gate />",
            "</Worktree>",
          ].join("\n"),
          { root, cwd: checkout.root },
        );
      }),
    );
    yield* opened.operation;

    // While the first process holds it, a real second process is refused —
    // without waiting, and with a word the person running it can act on.
    const bytes = yield* fingerprintTree(held.slot);
    const refused = yield* elsewhere(root, checkout.root, document);
    expect(refused.kind).toBe("refused");
    expect(refused.reason).toBe("in-use");
    expect(refused.message).toContain("another process is working in");
    // And nothing under the slot moved.
    expect(yield* fingerprintTree(held.slot)).toEqual(bytes);

    // A different slot is not contended, and succeeds while the first is still
    // held: the lock is per-slot, not per-root.
    const other = yield* elsewhere(
      root,
      checkout.root,
      `<Worktree name="uncontended" branch="uncontended" as="w" />\n\n{w}`,
    );
    expect(other.kind).toBe("selected");
    expect(other.bound).toBe(free.checkout);

    // The first process is cancelled. The kernel releases what it held, and the
    // checkout it made is still there.
    yield* holder.halt();
    expect(yield* exists(`${held.checkout}/held.md`)).toBe(true);

    const afterCancellation = yield* elsewhere(root, checkout.root, document);
    expect(afterCancellation.kind).toBe("selected");
    expect(afterCancellation.bound).toBe(held.checkout);
    // It reused the very checkout the cancelled process left, contents and all.
    expect(yield* exists(`${held.checkout}/held.md`)).toBe(true);
  });

  it("hands a slot on after a normal release, with the checkout intact", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "serial");
    const document = `<Worktree name="serial" branch="serial" as="w" />\n\n{w}`;

    // A first execution completes normally and releases.
    const bound = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(String(bound).trim()).toBe(slot.checkout);

    // A real second process then takes it, and finds the same checkout.
    const later = yield* elsewhere(root, checkout.root, document);
    expect(later.kind).toBe("selected");
    expect(later.bound).toBe(slot.checkout);
    expect(yield* readSidecar(slot)).toMatchObject({ kind: "worktree", name: "serial" });
  });
});

/** Two executions in one process must not share a checkout registry. */ /** Two executions in one process must not share a checkout registry. */

describe("ORC12 — one process reuses the lease it already holds", () => {
  it("selects the same slot twice in one execution without asking twice", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout: HostCheckout = yield* useHostCheckout(remote.locator);

    const rendered = yield* runOrdinaryDocument(
      [
        `<Worktree name="twice" branch="twice" as="first" />`,
        `<Worktree name="twice" branch="twice" as="second" />`,
        "",
        "{first === second ? 'same' : 'different'}",
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    expect(String(rendered)).toContain("same");
  });
});
