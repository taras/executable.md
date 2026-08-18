/**
 * Tier WF — `<Repository>`, `<Worktree>` and `<Dir>` as a document writes them.
 *
 * These drive the real component definitions through `execute()` against a real
 * run database and a real local remote, because what is under test is the
 * composition a document expresses: which form binds a path, which form renders
 * descendants, and what working directory those descendants observe.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { collect, execute, inlineSource } from "@executablemd/core";
import type { WorkflowRunDatabase } from "../mod.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { RepositoryCompositionProviderError } from "../src/composition/errors.ts";
import { DirInvocationError } from "../src/composition/components/Dir.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  countingHost,
  countingOptions,
  raised,
  retainedRepositories,
  runDocument,
} from "./support/composition.ts";
import { RepositoryCompositionError, WorktreeCompositionError } from "../src/composition/errors.ts";
import { admitLocator, locatorFingerprint } from "../src/deno/composition/locator.ts";

function isProviderError(value: unknown): value is RepositoryCompositionProviderError {
  return value instanceof RepositoryCompositionProviderError;
}

function isRepositoryRefusal(value: unknown): value is RepositoryCompositionError {
  return value instanceof RepositoryCompositionError;
}

function isWorktreeRefusal(value: unknown): value is WorktreeCompositionError {
  return value instanceof WorktreeCompositionError;
}

describe("workflow Repository composition", () => {
  it("binds a self-closing Repository's Workspace-relative checkout path", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "README.md", content: "hello\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}" as="repository" />`,
          "",
          "checkout: {repository}",
        ].join("\n"),
      );

      expect(String(output)).toContain("checkout: /repositories/project-");

      const retained = yield* retainedRepositories(database);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.record.name).toBe("project");
      expect(retained[0]?.record.primaryBranch).toBe("main");
      expect(retained[0]?.record.creationCommit).toBe(remote.heads.get("main"));
      expect(retained[0]?.locator).toBe(remote.locator);
    });
  });

  it("expands a lexical Repository's content at the checkout", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "README.md", content: "hello\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<File path="README.md" as="readme" />`,
          "",
          "read: {readme}",
          "</Repository>",
        ].join("\n"),
      );

      expect(String(output)).toContain("read: hello");
    });
  });

  it("runs the self-closing Worktree plus lexical Dir spelling", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "README.md", content: "base\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<File path="README.md" as="readme" />`,
          "",
          "inside: {readme}",
          "</Dir>",
          "</Repository>",
        ].join("\n"),
        countingOptions(counting),
      );

      const rendered = String(output);
      expect(rendered).toContain("inside: base");
      // The self-closing Worktree binds a path and renders nothing of its own.
      expect(rendered).not.toContain("/worktrees/");
      expect(counting.counters.effects).toEqual(["repository:project", "worktree:implementation"]);
    });
  });

  it("restores the enclosing working directory after Dir", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [
        {
          message: "first",
          entries: [
            { path: "README.md", content: "outer\n" },
            { path: "nested/README.md", content: "inner\n" },
          ],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          '<Dir path="nested">',
          `<File path="README.md" as="inner" />`,
          "",
          "inner: {inner}",
          "</Dir>",
          `<File path="README.md" as="outer" />`,
          "",
          "outer: {outer}",
          "</Repository>",
        ].join("\n"),
      );

      const rendered = String(output);
      expect(rendered).toContain("inner: inner");
      expect(rendered).toContain("outer: outer");
    });
  });

  it("keeps a lexical Worktree written with `as` an ordinary capture", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "README.md", content: "base\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="captured">`,
          "rendered inside",
          "</Worktree>",
          "",
          "captured: {captured}",
          "</Repository>",
        ].join("\n"),
      );

      const rendered = String(output);
      // Ordinary generic capture: the content is captured and suppressed, and
      // the binding is that content rather than the checkout path.
      expect(rendered).toContain("rendered inside");
      expect(rendered).not.toContain("/worktrees/");
      expect(rendered.indexOf("rendered inside")).toBe(rendered.lastIndexOf("rendered inside"));
    });
  });

  it("passes expression values as names and inputs", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "README.md", content: "base\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // The locator and the Worktree name arrive as root-prop expressions
      // rather than as literals, which is what makes them inputs rather than
      // keys into something the provider looks up.
      const output = yield* runDocument(
        database,
        [
          "---",
          "props:",
          "  repository:",
          "    type: string",
          `    default: ${remote.locator}`,
          "  candidate:",
          "    type: string",
          "    default: implementation",
          "---",
          "",
          `<Repository name="project" url={props.repository}>`,
          `<Worktree name={props.candidate} branch="feature/new" as="worktree" />`,
          "",
          "worktree: {worktree}",
          "</Repository>",
        ].join("\n"),
      );

      expect(String(output)).toContain("worktree: /worktrees/");
      const retained = yield* retainedRepositories(database);
      expect(retained[0]?.locator).toBe(remote.locator);
    });
  });
});

describe("workflow composition refusal vocabulary", () => {
  it("names a fixed reason on each failure class", function* () {
    const repository = new RepositoryCompositionError("project", "invalid-locator", "why");
    const worktree = new WorktreeCompositionError("implementation", "unresolved-base", "why");
    expect(repository.reason).toBe("invalid-locator");
    expect(worktree.reason).toBe("unresolved-base");
  });
});

describe("workflow Git locator admission", () => {
  it("refuses every place a credential is written into a url", function* () {
    // Userinfo, query and fragment: the three ways an HTTPS locator carries a
    // secret. Each is refused rather than stripped, because a locator that
    // carried one is a secret the caller put into a durable input, and quietly
    // editing it would retain a run nobody asked for.
    expect(admitLocator("https://user:pw@example.test/repo.git")).toBeUndefined();
    expect(admitLocator("https://token@example.test/repo.git")).toBeUndefined();
    expect(admitLocator("https://example.test/repo.git?access_token=abc")).toBeUndefined();
    expect(admitLocator("https://example.test/repo.git#token=abc")).toBeUndefined();

    // An ordinary locator is still admitted, and admitted as its own bytes.
    expect(admitLocator("https://example.test/repo.git")).toBe("https://example.test/repo.git");
    expect(admitLocator("git@example.test:owner/repo.git")).toBe("git@example.test:owner/repo.git");
    expect(admitLocator("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("names the exact admitted bytes, so a changed locator is a changed identity", function* () {
    const one = admitLocator("https://example.test/repo.git") ?? "";
    const other = admitLocator("https://example.test/other.git") ?? "";

    expect(locatorFingerprint(one)).toBe(locatorFingerprint(one));
    expect(locatorFingerprint(one)).not.toBe(locatorFingerprint(other));
  });
});

/**
 * Who decides what a composition failure means.
 *
 * The components describe known refusals; the document decides whether one is
 * printed and whether anything runs after it. That is one rule, and these hold
 * it at both ends: the same document written plainly and written inside an
 * authored `<PrintErrors>` region must differ, and differ in the sibling that
 * follows rather than only in the sentence that is rendered.
 *
 * A marker after the failing element is what makes each pair discriminating.
 * Asserting only that a diagnostic appears would pass equally for a component
 * that recovered on its own behalf, which is exactly the policy these prove is
 * not in force.
 */
describe("workflow composition failure policy", () => {
  const LATER = "later sibling marker";

  /** The one printed error a region produced, so "exactly once" is checkable. */
  function printed(rendered: string): string[] {
    return rendered.match(/<!-- ERROR:[^]*?-->/g) ?? [];
  }

  function* failureOf(
    database: WorkflowRunDatabase,
    source: string,
  ): Operation<{ error: unknown; rendered: string }> {
    let rendered = "";
    let error: unknown;
    try {
      rendered = String(yield* runDocument(database, source));
    } catch (raised) {
      error = raised;
    }
    return { error, rendered };
  }

  it("fails the run on an invalid self-closing <Dir> and runs no later sibling", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [`<Dir path="/somewhere" />`, "", LATER].join("\n"),
      );

      expect(error).toBeInstanceOf(DirInvocationError);
      expect(rendered).not.toContain(LATER);
    });
  });

  it("prints an invalid <Dir> once inside <PrintErrors> and runs the later sibling", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        ["<PrintErrors>", `<Dir path="/somewhere" />`, "", LATER, "</PrintErrors>"].join("\n"),
      );

      expect(error).toBe(undefined);
      expect(printed(rendered)).toHaveLength(1);
      expect(rendered).toContain("is invalid");
      expect(rendered).toContain(LATER);
    });
  });

  it("fails the run on a Repository refusal and runs no later sibling", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [`<Repository name="project" url="relative/path" as="r" />`, "", LATER].join("\n"),
      );

      expect(error).toBeInstanceOf(RepositoryCompositionError);
      expect(String(error)).toContain("could not be prepared");
      expect(rendered).not.toContain(LATER);
    });
  });

  it("prints a Repository refusal once inside <PrintErrors> and continues", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [
          "<PrintErrors>",
          `<Repository name="project" url="relative/path" as="r" />`,
          "",
          LATER,
          "</PrintErrors>",
        ].join("\n"),
      );

      expect(error).toBe(undefined);
      expect(printed(rendered)).toHaveLength(1);
      expect(rendered).toContain("could not be prepared");
      expect(rendered).toContain(LATER);
    });
  });

  it("fails the run on a Worktree with no Repository and runs no later sibling", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [`<Worktree name="implementation" branch="feature" as="w" />`, "", LATER].join("\n"),
      );

      expect(error).toBeInstanceOf(WorktreeCompositionError);
      expect(String(error)).toContain("invalid outside a lexical <Repository>");
      expect(rendered).not.toContain(LATER);
    });
  });

  it("prints a Worktree with no Repository once inside <PrintErrors>", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [
          "<PrintErrors>",
          `<Worktree name="implementation" branch="feature" as="w" />`,
          "",
          LATER,
          "</PrintErrors>",
        ].join("\n"),
      );

      expect(error).toBe(undefined);
      expect(printed(rendered)).toHaveLength(1);
      expect(rendered).toContain("invalid outside a lexical <Repository>");
      expect(rendered).toContain(LATER);
    });
  });

  it("fails the run on a recognized Worktree refusal inside a Repository", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const { error, rendered } = yield* failureOf(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="main" as="w" />`,
          "",
          LATER,
          "</Repository>",
        ].join("\n"),
      );

      expect(error).toBeInstanceOf(WorktreeCompositionError);
      expect(String(error)).toContain("already checked out by another worktree");
      expect(rendered).not.toContain(LATER);
    });
  });

  /**
   * A failure that is not a refusal must not arrive as one.
   *
   * The components own a fixed vocabulary for what a document asked for and did
   * not get. Everything else — a provider that is not installed, a Git binary
   * that could not be run — is not something the document did, and turning one
   * into a printed refusal would let later work proceed as though a checkout
   * existed. The plain form is what discriminates: no region is present, so
   * nothing may print, and what escapes must still be the original failure.
   */
  it("does not turn a missing provider into a refusal", function* () {
    const failure = yield* raised(
      scoped(function* () {
        yield* useCompositionComponents();
        return yield* collect(
          yield* execute({
            ...inlineSource(`<Repository name="project" url="/tmp/x.git" as="r" />`),
            stream: new InMemoryStream(),
          }),
        );
      }),
    );

    expect(causedBy(failure, isProviderError)).toBeInstanceOf(RepositoryCompositionProviderError);
    expect(causedBy(failure, isRepositoryRefusal)).toBe(undefined);
  });

  it("does not turn an unexpected host failure into a refusal", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const broken = {
        // deno-lint-ignore require-yield
        *git(): Operation<never> {
          throw new Error("the host could not run git");
        },
        useDirectory: denoRepositoryHost().useDirectory,
      };

      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            `<Repository name="project" url="${remote.locator}" as="r" />`,
            "",
            LATER,
            "</PrintErrors>",
          ].join("\n"),
          { composition: { host: broken } },
        ),
      );

      // Even under an authored region: this is not a document failure, so the
      // components never offered it as one.
      expect(failure).not.toBe(undefined);
      expect(causedBy(failure, isRepositoryRefusal)).toBe(undefined);
      expect(yield* retainedRepositories(database)).toHaveLength(0);
    });
  });

  /**
   * A failure of projected content belongs to the region it is written in.
   *
   * Through all three boundaries, because each one expands content and none of
   * them may decide what a failure of somebody else's text means.
   */
  it("leaves a projected-content failure to the region that wrote it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    const inside = [
      `<Repository name="project" url="${remote.locator}">`,
      `<Worktree name="implementation" branch="feature/new" as="w" />`,
      "<Dir path={w}>",
      "<Bogus />",
      "</Dir>",
      "</Repository>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const plain = yield* createRun({ runId: "plain" });
      const { error } = yield* failureOf(plain, inside);
      expect(error).not.toBe(undefined);
      expect(causedBy(error, isRepositoryRefusal)).toBe(undefined);
      expect(causedBy(error, isWorktreeRefusal)).toBe(undefined);

      const printing = yield* createRun({ runId: "printing" });
      const { error: none, rendered } = yield* failureOf(
        printing,
        ["<PrintErrors>", inside, "", LATER, "</PrintErrors>"].join("\n"),
      );
      expect(none).toBe(undefined);
      expect(rendered).toContain("Bogus");
      expect(rendered).toContain(LATER);
    });
  });
});
