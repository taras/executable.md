/**
 * Tier EP — `<Evaluate>` in the ordinary run profile (issue #713).
 *
 * Core owns the admission and the expansion; what only a shelled-out `xmd run`
 * can show is that the profile a person actually gets has this component at
 * all, that a program evaluated there behaves like the root it is, and that the
 * authority it runs under is the site's rather than the producer's.
 *
 * Every case runs the real binary with captured stdio, so what is asserted is
 * what a caller sees on stdout, on stderr, and in the exit status.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A text root that reads a prop of its own, and says so when it has none. */
const TEXT_PROGRAM = [
  "---",
  "props:",
  "  release:",
  "    type: string",
  "    default: none",
  "---",
  "",
  "Program released {props.release}.",
  "",
].join("\n");

/** A value root, which has somewhere to put a result only when `as` is written. */
const VALUE_PROGRAM = [
  "---",
  "returns:",
  "  type: object",
  "  properties:",
  "    ok: { type: boolean }",
  "  required: [ok]",
  "---",
  "",
  "<Return value={{ ok: true }} />",
  "",
].join("\n");

/** A document that binds a program and evaluates it at a later site. */
function deferred(program: string, element: string): string {
  return [`<Let value={${JSON.stringify(program)}} as="plan" />`, "", element, ""].join("\n");
}

describe(
  "Tier EP — evaluating complete programs in a run",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("EP1: the run profile evaluates a program written as content", function* () {
      const result = yield* runCli([
        "run",
        "-e",
        ["<Evaluate>", "  # Composed", "", "  The program ran.", "</Evaluate>", ""].join("\n"),
        "--raw",
      ]).expect();

      expect(result.stdout).toContain("The program ran.");
      // Once: the source the wrapper held was a private buffer, not output.
      expect(result.stdout.split("The program ran.")).toHaveLength(2);
    });

    it("EP2: the run profile evaluates a program supplied as `program`", function* () {
      const result = yield* runCli([
        "run",
        "-e",
        deferred(TEXT_PROGRAM, '<Evaluate program={plan} props={{ release: "1.4.0" }} />'),
        "--raw",
      ]).expect();

      expect(result.stdout).toContain("Program released 1.4.0.");
    });

    it("EP3: a program receives explicit props and never the caller's", function* () {
      const document = [
        "---",
        "props:",
        "  release:",
        "    type: string",
        "---",
        "",
        `<Let value={${JSON.stringify(TEXT_PROGRAM)}} as="plan" />`,
        "",
        "Caller released {props.release}.",
        "",
        "<Evaluate program={plan} />",
        "",
      ].join("\n");

      const result = yield* runCli([
        "run",
        "-e",
        document,
        "--props",
        '{"release":"9.9.9"}',
        "--raw",
      ]).expect();

      expect(result.stdout).toContain("Caller released 9.9.9.");
      // The program declared the same prop name and was handed none, so its own
      // default answers. An ambient root props object is not inherited.
      expect(result.stdout).toContain("Program released none.");
    });

    it("EP4: a value root binds its result under `as`", function* () {
      const result = yield* runCli([
        "run",
        "-e",
        deferred(
          VALUE_PROGRAM,
          '<Evaluate program={plan} as="decided" />\n\nDecided {decided.ok}.',
        ),
        "--raw",
      ]).expect();

      expect(result.stdout).toContain("Decided true.");
    });

    it("EP5: a value root without `as` refuses and evaluates nothing", function* () {
      const result = yield* runCli([
        "run",
        "-e",
        deferred(VALUE_PROGRAM, "<Evaluate program={plan} />"),
      ]).join();

      expect(`${result.stdout}${result.stderr}`).toContain("requires `as`");
    });

    it("EP6: an element that names both a program and content refuses", function* () {
      const result = yield* runCli([
        "run",
        "-e",
        deferred(TEXT_PROGRAM, "<Evaluate program={plan}>\nnot a program\n</Evaluate>"),
      ]).join();

      expect(`${result.stdout}${result.stderr}`).toContain("not both");
      expect(result.stdout).not.toContain("Program released");
    });

    it("EP7: a program cannot reach a producer's private components", function* () {
      // `<AdmitPlan />` is one of the five capabilities only `<Plan>`'s own
      // bytes may write. A program is not those bytes however it was produced,
      // so the name resolves to nothing at this site.
      const result = yield* runCli([
        "run",
        "-e",
        deferred('<AdmitPlan source="anything" />\n', "<Evaluate program={plan} />"),
      ]).join();

      const reported = `${result.stdout}${result.stderr}`;
      expect(reported).toMatch(/AdmitPlan/);
      expect(reported).not.toContain("approved");
    });

    it("EP8: `xmd syntax` describes the run profile's own `<Evaluate>`", function* () {
      const result = yield* runCli(["syntax", "--json"]).expect();
      const catalog: { categories: { entries: { name: string; description?: string }[] }[] } =
        JSON.parse(result.stdout);
      const entry = catalog.categories
        .flatMap((category) => category.entries)
        .find((component) => component.name === "Evaluate");

      expect(entry).toBeDefined();
      expect(entry?.description).toContain("evaluates a complete program");
      // The run profile has no restricted-fragment form, so its catalog must
      // not advertise the prop that carries one.
      expect(entry?.description).not.toContain("source={fragment}");
    });
  },
);

/**
 * A workflow run declares an `<Evaluate>` of its own — the complete-program
 * forms plus the restricted generated-fragment form only that profile has. The
 * run profile must not declare a second component of that name beside it: one
 * name names durable work in one domain, and canonical execution refuses two.
 *
 * This is the seam where that goes wrong, because it is the CLI's own
 * installation array rather than anything either package assembles alone.
 */
const WORKFLOW_PROGRAM = [
  "# Compose",
  "",
  '<Let value={"# Composed\\n\\nThe workflow program ran.\\n"} as="plan" />',
  "",
  "<Evaluate program={plan} />",
  "",
].join("\n");

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useWorkflowFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-ep-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);
    for (const [name, content] of Object.entries(files)) {
      const path = join(fixture.repository, name);
      yield* ensureDir(join(path, ".."));
      yield* writeTextFile(path, content);
    }
    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-ep@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier EP"]);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);
    return yield* body(fixture);
  });
}

describe(
  "Tier EP — one `<Evaluate>` per execution",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("EP9: a workflow run keeps its own `<Evaluate>` and gains no second one", function* () {
      yield* useWorkflowFixture({ "flows/compose.md": WORKFLOW_PROGRAM }, function* (fixture) {
        const started = yield* runCli(["workflow", "start", "--id=compose-1", "flows/compose.md"], {
          cwd: fixture.repository,
          env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        }).join();

        const reported = `${started.stdout}${started.stderr}`;
        // The exact sentence canonical execution refuses a duplicate with. A
        // run profile that declared its own beside the workflow's would fail
        // every workflow run, not only one that writes `<Evaluate>`.
        expect(reported).not.toContain('two identity components called "Evaluate"');
        expect(reported).toContain("The workflow program ran.");
      });
    });
  },
);
