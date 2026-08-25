/**
 * Tier CT — CLI document targets (spec §5.4, §9.6).
 *
 * `xmd run <document> --help` describes what a document addresses, and both
 * `xmd run` forms select one section of it. Discovery is part of help, so the
 * catalog is read out of the same response that describes the command and the
 * document's properties. Suites shell out with captured stdio so exit status,
 * stdout bytes, and diagnostics are asserted the way a caller observes them;
 * the exceptions are the inspection/execution replacement seam and the
 * installer, which need state the command line cannot express.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { API, Service, useHostFiles } from "@executablemd/runtime";
import { runCli } from "@executablemd/test-support/launch";
import { runXmd } from "../src/cli.ts";

function* useFixture<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-ct-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }
    return yield* body(dir);
  });
}

/**
 * The catalog every run-selection test addresses.
 *
 * The sole outermost heading is the document title, so it takes no level in a
 * path: `Beta/Nested` is addressed by its own two labels. Alpha precedes Beta
 * and Gamma follows it, which is what makes "excludes its siblings" mean both
 * directions.
 */
const REPORT = [
  "# Report",
  "",
  "PREAMBLE_MARKER",
  "",
  "## Alpha",
  "",
  "ALPHA_MARKER",
  "",
  "## Beta",
  "",
  "BETA_MARKER",
  "",
  "### Nested",
  "",
  "NESTED_MARKER",
  "",
  "## Gamma",
  "",
  "GAMMA_MARKER",
  "",
].join("\n");

const DUPLICATE = [
  "# Duplicate",
  "",
  "## Same",
  "",
  "FIRST_MARKER",
  "",
  "## Same",
  "",
  "SECOND_MARKER",
  "",
].join("\n");

/**
 * One document holding every shape the catalog has to render: a described
 * section, a second section whose canonical path is identical but whose prose
 * is its own, and one that describes nothing at all.
 */
const CATALOG = [
  "# Catalog",
  "",
  "## Same",
  "",
  "The first section under this canonical path.",
  "",
  "## Same",
  "",
  "The second section under the very same path.",
  "",
  "## Quiet",
  "",
  "```bash",
  "echo nothing",
  "```",
  "",
].join("\n");

/** One heading per character class the canonical encoder has to escape. */
const EXOTIC = [
  "# Exotic",
  "",
  "## a/b",
  "",
  "SLASH_MARKER",
  "",
  "## star*",
  "",
  "STAR_MARKER",
  "",
  "## hash#tag",
  "",
  "HASH_MARKER",
  "",
  "## pct%value",
  "",
  "PCT_MARKER",
  "",
  "## two words",
  "",
  "SPACE_MARKER",
  "",
  "## Ünïcødé",
  "",
  "UNICODE_MARKER",
  "",
].join("\n");

/**
 * Everything discovery must not do: an unresolvable component, an executable
 * block, and an authored write. Expanding any one of them is observable — the
 * first fails the run, and the other two leave a file behind. Its one section
 * opens with prose, so the catalog it describes is not empty either.
 */
const EFFECTFUL = [
  "# Effects",
  "",
  "## Work",
  "",
  "Describes the work without performing any of it.",
  "",
  "<NoSuchComponentAtAll />",
  "",
  '<File path="written.txt">side effect</File>',
  "",
  "```ts eval",
  'output("EVAL_RAN");',
  "```",
  "",
].join("\n");

const BROKEN_SCHEMA = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    who:",
  "      type: not-a-json-schema-type",
  "---",
  "",
  "# Broken",
  "",
  "## Kept",
  "",
  '<File path="schema-effect.txt">effect</File>',
  "",
].join("\n");

/** Each exotic heading's canonical reference, and the body it retains. */
const EXOTIC_REFERENCES: readonly [string, string][] = [
  ["doc.md#a%2Fb", "SLASH_MARKER"],
  ["doc.md#star%2A", "STAR_MARKER"],
  ["doc.md#hash%23tag", "HASH_MARKER"],
  ["doc.md#pct%25value", "PCT_MARKER"],
  ["doc.md#two%20words", "SPACE_MARKER"],
  ["doc.md#%C3%9Cn%C3%AFc%C3%B8d%C3%A9", "UNICODE_MARKER"],
];

function* eachRuns(dir: string, expected: readonly [string, string][]): Operation<void> {
  for (const [reference, marker] of expected) {
    const ran = yield* runCli(["run", reference, "--raw"], { cwd: dir }).join();
    expect({ reference, code: ran.code }).toEqual({ reference, code: 0 });
    expect(ran.stdout).toContain(marker);
  }
}

/** The target section of one help response, or "" when it has none. */
function targetSection(stdout: string): string {
  const at = stdout.indexOf("Targets in ");
  return at === -1 ? "" : stdout.slice(at).trimEnd();
}

describe("Tier CT — CLI document targets", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CT1: help lists full canonical references in source order", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const { code, stdout } = yield* runCli(["run", "doc.md", "--help"], { cwd: dir }).join();
      expect(code).toBe(0);
      // Every reference the document offers, once each, in the order it
      // declares them — and no unqualified whole-document row beside them.
      expect(targetSection(stdout)).toBe(
        [
          "Targets in doc.md",
          "",
          "  doc.md#Alpha",
          "      ALPHA_MARKER",
          "",
          "  doc.md#Beta",
          "      BETA_MARKER",
          "",
          "  doc.md#Beta/Nested",
          "      NESTED_MARKER",
          "",
          "  doc.md#Gamma",
          "      GAMMA_MARKER",
        ].join("\n"),
      );
    });
  });

  it("CT2: two sections with one canonical path are two rows, described apart", function* () {
    yield* useFixture({ "doc.md": CATALOG }, function* (dir) {
      const { code, stdout } = yield* runCli(["run", "doc.md", "--help"], { cwd: dir }).join();
      expect(code).toBe(0);
      // The ambiguity stays visible, and each row states its own prose: a
      // catalog deduplicated by canonical path would print one of these.
      expect(targetSection(stdout)).toBe(
        [
          "Targets in doc.md",
          "",
          "  doc.md#Same",
          "      The first section under this canonical path.",
          "",
          "  doc.md#Same",
          "      The second section under the very same path.",
          "",
          "  doc.md#Quiet",
        ].join("\n"),
      );
    });
  });

  it("CT3: a document with no targets has no target section at all", function* () {
    yield* useFixture({ "doc.md": "just a paragraph\n" }, function* (dir) {
      const { code, stdout } = yield* runCli(["run", "doc.md", "--help"], { cwd: dir }).join();
      expect(code).toBe(0);
      expect(stdout).not.toContain("Targets in");
      // The rest of run help is unaffected by having nothing to add to it.
      expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
    });
  });

  it("CT4: help runs no component, block, authored write, or service", function* () {
    yield* useFixture({ "doc.md": EFFECTFUL }, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md", "--help"], {
        cwd: dir,
      }).join();
      expect(code).toBe(0);
      expect(targetSection(stdout)).toBe(
        [
          "Targets in doc.md",
          "",
          "  doc.md#Work",
          "      Describes the work without performing any of it.",
        ].join("\n"),
      );
      // An expanded `<NoSuchComponentAtAll />` renders a positioned diagnostic,
      // and the eval block would compile into a file of its own.
      expect(stdout).not.toContain("NoSuchComponentAtAll");
      expect(stdout).not.toContain("EVAL_RAN");
      expect(stderr).toBe("");
      expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);
      expect(yield* exists(path.join(dir, ".xmd-eval"))).toBe(false);
    });
  });

  it("CT5b: an unreadable reference and a missing file fail help too", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const malformed = yield* runCli(["run", "%zz.md", "--help"], { cwd: dir }).join();
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain("Invalid document reference");
      expect(malformed.stdout).toBe("");

      const absent = yield* runCli(["run", "absent.md", "--help"], { cwd: dir }).join();
      expect(absent.code).toBe(1);
      expect(absent.stdout).toBe("");
    });
  });

  it("CT5e: a schema-invalid document fails help and describes nothing", function* () {
    yield* useFixture({ "doc.md": BROKEN_SCHEMA }, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md", "--help"], {
        cwd: dir,
      }).join();
      expect(code).toBe(1);
      expect(stderr).toContain("invalid props schema");
      expect(stdout).toBe("");
      // The refusal is an inspection failure, so the body it holds never ran.
      expect(yield* exists(path.join(dir, "schema-effect.txt"))).toBe(false);
    });
  });

  it("CT6a: a literal % is escape syntax, so its raw spelling is not a path", function* () {
    // `%zz` is not a valid escape, and a reference is not repaired: the whole
    // reference is refused rather than read as the literal filename.
    const doc = ["# Percent", "", "## Alpha", "", "RAW_PCT_MARKER", ""].join("\n");
    yield* useFixture({ "pct%zz.md": doc }, function* (dir) {
      const encoded = yield* runCli(["run", "pct%25zz.md", "--help"], { cwd: dir }).join();
      expect(encoded.code).toBe(0);
      // The heading names the file, exactly as the property section above it
      // does; every row is a reference, so every row is encoded.
      expect(targetSection(encoded.stdout)).toBe(
        ["Targets in pct%zz.md", "", "  pct%25zz.md#Alpha", "      RAW_PCT_MARKER"].join("\n"),
      );

      const ran = yield* runCli(["run", "pct%25zz.md#Alpha", "--raw"], { cwd: dir }).join();
      expect(ran.code).toBe(0);
      expect(ran.stdout).toContain("RAW_PCT_MARKER");

      const raw = yield* runCli(["run", "pct%zz.md", "--help"], { cwd: dir }).join();
      expect(raw.code).toBe(1);
      expect(raw.stderr).toContain("Invalid document reference");
      expect(raw.stdout).toBe("");

      const rawRun = yield* runCli(["run", "pct%zz.md", "--raw"], { cwd: dir }).join();
      expect(rawRun.code).toBe(1);
      expect(rawRun.stderr).toContain("Invalid document reference");
    });
  });

  it("CT6: a filename holding # or % is read and reprinted canonically", function* () {
    const hashed = ["# Hashed", "", "## Sec", "", "HASH_FILE_MARKER", ""].join("\n");
    const percent = ["# Percent", "", "## Sec", "", "PCT_FILE_MARKER", ""].join("\n");
    yield* useFixture({ "we#ird.md": hashed, "pct%25.md": percent }, function* (dir) {
      const hash = yield* runCli(["run", "we%23ird.md", "--help"], { cwd: dir }).join();
      expect(hash.code).toBe(0);
      expect(targetSection(hash.stdout)).toContain("  we%23ird.md#Sec");

      const pct = yield* runCli(["run", "pct%2525.md", "--help"], { cwd: dir }).join();
      expect(pct.code).toBe(0);
      expect(targetSection(pct.stdout)).toContain("  pct%2525.md#Sec");

      const ran = yield* runCli(["run", "we%23ird.md#Sec", "--raw"], { cwd: dir }).join();
      expect(ran.code).toBe(0);
      expect(ran.stdout).toContain("HASH_FILE_MARKER");
    });
  });

  // CT7 lives in packages/cli/tests/targets/targets.test.md: the claim is
  // document behavior, so its evidence is the checked-in Markdown suite the
  // tier launcher runs.

  it("CT8: the default command selects the same target as the explicit one", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const explicit = yield* runCli(["run", "doc.md#Beta/Nested", "--raw"], { cwd: dir }).join();
      const implicit = yield* runCli(["doc.md#Beta/Nested", "--raw"], { cwd: dir }).join();
      expect(implicit.code).toBe(explicit.code);
      expect(implicit.stdout).toBe(explicit.stdout);
      expect(implicit.stdout).toContain("NESTED_MARKER");
      expect(implicit.stdout).not.toContain("ALPHA_MARKER");
    });
  });

  it("CT9: a wildcard resolving to one target executes that target", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const trailing = yield* runCli(["run", "doc.md#Al*", "--raw"], { cwd: dir }).join();
      expect(trailing.code).toBe(0);
      expect(trailing.stdout).toContain("ALPHA_MARKER");
      expect(trailing.stdout).not.toContain("BETA_MARKER");

      const embedded = yield* runCli(["run", "doc.md#G*a", "--raw"], { cwd: dir }).join();
      expect(embedded.code).toBe(0);
      expect(embedded.stdout).toContain("GAMMA_MARKER");

      const recursive = yield* runCli(["run", "doc.md#**/Nested", "--raw"], { cwd: dir }).join();
      expect(recursive.code).toBe(0);
      expect(recursive.stdout).toContain("NESTED_MARKER");
      expect(recursive.stdout).not.toContain("ALPHA_MARKER");
    });
  });

  it("CT10: no match fails before expansion and lists every available reference", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md#Delta", "--raw"], {
        cwd: dir,
      }).join();
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain('"Delta" matches no document target.');
      expect(stderr).toContain("Available targets:");
      expect(stderr).toContain("  doc.md#Alpha");
      expect(stderr).toContain("  doc.md#Beta");
      expect(stderr).toContain("  doc.md#Beta/Nested");
      expect(stderr).toContain("  doc.md#Gamma");
      // A bare canonical fragment would mean the CLI printed the core's list.
      expect(stderr).not.toContain("  Alpha\n");
    });
  });

  it("CT10a: an invalid selector reports the whole catalog too", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const { code, stderr } = yield* runCli(["run", "doc.md#%zz", "--raw"], { cwd: dir }).join();
      expect(code).toBe(1);
      expect(stderr).toContain('"%zz" is not a valid document target selector.');
      expect(stderr).toContain("  doc.md#Alpha");
    });
  });

  it("CT10b: a document with no targets says so instead of listing none", function* () {
    yield* useFixture({ "doc.md": "just a paragraph\n" }, function* (dir) {
      const { code, stderr } = yield* runCli(["run", "doc.md#Any", "--raw"], { cwd: dir }).join();
      expect(code).toBe(1);
      expect(stderr).toContain('"Any" matches no document target.');
      expect(stderr).toContain("The document has no targets.");
      expect(stderr).not.toContain("Available targets:");
    });
  });

  it("CT11: several matches fail and list every matching reference", function* () {
    yield* useFixture({ "doc.md": DUPLICATE }, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md#Same", "--raw"], {
        cwd: dir,
      }).join();
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain('"Same" matches more than one document target.');
      expect(stderr).toContain("Matched targets:");
      // The ambiguity is two entries, so it is reported as two lines.
      expect(stderr).toContain(["Matched targets:", "  doc.md#Same", "  doc.md#Same"].join("\n"));
      expect(stderr).not.toContain("Available targets:");
    });
  });

  it("CT13: exotic headings are listed as canonical references", function* () {
    yield* useFixture({ "doc.md": EXOTIC }, function* (dir) {
      const listed = yield* runCli(["run", "doc.md", "--help"], { cwd: dir }).join();
      expect(listed.code).toBe(0);
      expect(targetSection(listed.stdout)).toBe(
        [
          "Targets in doc.md",
          "",
          ...EXOTIC_REFERENCES.flatMap(([reference, marker]) => [
            `  ${reference}`,
            `      ${marker}`,
            "",
          ]),
        ]
          .join("\n")
          .trimEnd(),
      );
    });
  });

  /**
   * A targeted reference is still a reference to the whole document, so its
   * help validates the selector and then describes the source document —
   * every section of it, not the one the selector named.
   */
  it("CT17: a valid exact or glob selector reports the whole catalog", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      for (const reference of ["doc.md#Beta", "doc.md#**/Nested"]) {
        const { code, stdout } = yield* runCli(["run", reference, "--help"], { cwd: dir }).join();
        expect({ reference, code }).toEqual({ reference, code: 0 });
        expect(targetSection(stdout)).toContain("  doc.md#Alpha");
        expect(targetSection(stdout)).toContain("  doc.md#Gamma");
        expect(stdout).not.toContain("ALPHA_MARKER\nBETA");
      }
    });
  });

  it("CT18: an unmatched or ambiguous selector fails help and describes nothing", function* () {
    yield* useFixture({ "doc.md": REPORT, "dup.md": DUPLICATE }, function* (dir) {
      const absent = yield* runCli(["run", "doc.md#Delta", "--help"], { cwd: dir }).join();
      expect(absent.code).toBe(1);
      expect(absent.stdout).toBe("");
      expect(absent.stderr).toContain('"Delta" matches no document target.');

      const ambiguous = yield* runCli(["run", "dup.md#Same", "--help"], { cwd: dir }).join();
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stdout).toBe("");
      expect(ambiguous.stderr).toContain('"Same" matches more than one document target.');
      expect(ambiguous.stderr).not.toContain("Targets in");
    });
  });

  it("CT13a: a heading holding syntax runs through its reference", function* () {
    yield* useFixture({ "doc.md": EXOTIC }, function* (dir) {
      yield* eachRuns(dir, EXOTIC_REFERENCES.slice(0, 3));
    });
  });

  it("CT13b: a heading holding whitespace or Unicode runs through its reference", function* () {
    yield* useFixture({ "doc.md": EXOTIC }, function* (dir) {
      yield* eachRuns(dir, EXOTIC_REFERENCES.slice(3));
    });
  });

  it("CT16: a target failure outranks an invalid props schema and runs nothing", function* () {
    yield* useFixture({ "doc.md": BROKEN_SCHEMA }, function* (dir) {
      const missing = yield* runCli(["run", "doc.md#Absent", "--raw"], { cwd: dir }).join();
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('"Absent" matches no document target.');
      expect(missing.stderr).toContain("  doc.md#Kept");
      expect(yield* exists(path.join(dir, "schema-effect.txt"))).toBe(false);

      // A target the document does offer lets the schema failure be reported.
      const resolvable = yield* runCli(["run", "doc.md#Kept", "--raw"], { cwd: dir }).join();
      expect(resolvable.code).toBe(1);
      expect(resolvable.stderr).not.toContain("matches no document target");
      expect(resolvable.stderr).toContain("invalid props schema");
      expect(yield* exists(path.join(dir, "schema-effect.txt"))).toBe(false);
    });
  });

  it("CT-text: a targeted text root keeps its stdout and printed-error contract", function* () {
    yield* useFixture({ "doc.md": REPORT }, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md#Alpha", "--raw"], {
        cwd: dir,
      }).join();
      expect(code).toBe(0);
      expect(stdout).toContain("ALPHA_MARKER");
      expect(stderr).toBe("");
    });
  });
});

/**
 * The exit continuation `exit()` reaches for. `main()` installs one under this
 * name; a suite that drives `runXmd` directly installs its own so a command's
 * status is a value rather than a process exit.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

interface InProcessRun {
  status: number;
  stderr: string;
  /** Whether the host's provider installer ran. */
  serviceInstalled: boolean;
  /** Whether anything asked that installed provider to start a service. */
  serviceStarted: boolean;
  /** How many times the run read the document itself. */
  documentReads: number;
  reads: string[];
}

/**
 * Drive `runXmd` in this process, with one filesystem that answers differently
 * from a chosen read of the document onward.
 *
 * The command line cannot express a document that changes between the run's own
 * reads, and reproducing it with a real file would be a race. The seam is
 * therefore installed around the operation: reads before `replaceFrom` return
 * whatever is on disk, that read and every later one return the replacement,
 * and every path the run touches is recorded.
 *
 * `replaceFrom` picks which of the run's three reads first sees the
 * replacement, which is what separates a refusal before provider installation
 * from one after it. The host installer is recorded separately from the
 * provider it installs: installing a provider is not starting a service, and
 * this suite must be able to tell the two apart.
 */
function* replacingRun(
  args: string[],
  documentPath: string,
  replacement: string,
  replaceFrom: number,
  cwd: string,
): Operation<InProcessRun> {
  const reads: string[] = [];
  let status = 0;
  let stderr = "";
  let serviceInstalled = false;
  let serviceStarted = false;
  let documentReads = 0;

  const written = console.error;
  return yield* scoped(function* () {
    yield* ensure(() => {
      console.error = written;
    });
    console.error = (...parts: unknown[]) => {
      stderr += `${parts.map((part) => String(part)).join(" ")}\n`;
    };

    yield* ExitContext.set(function* (result) {
      status = result.status;
    });

    yield* API.Fs.around({
      *readTextFile([target], next) {
        reads.push(target);
        if (target === documentPath) {
          documentReads += 1;
          if (documentReads >= replaceFrom) {
            return replacement;
          }
        }
        return yield* next(target);
      },
    });

    // The fixture is the working directory, so an authored relative path in
    // the replacement resolves to a file that really exists — which is what
    // makes "the replacement performed no authored read" a live assertion
    // rather than one a missing file would satisfy anyway.
    yield* API.Env.around({
      *cwd() {
        return cwd;
      },
    });

    // What a runtime entrypoint installs beside `runXmd`, so an authored
    // `<File>` read in the replacement really does reach the recorder above.
    yield* useHostFiles();

    yield* runXmd(args, function* () {
      serviceInstalled = true;
      yield* Service.around({
        *start() {
          serviceStarted = true;
          throw new Error("the run started a service");
        },
      });
    });

    return { status, stderr, serviceInstalled, serviceStarted, documentReads, reads };
  });
}

const FIRST_BODY = ["# Doc", "", "## Alpha", "", "ALPHA_MARKER", ""].join("\n");

/**
 * The same `A*` selector, a different single answer: `Alpha` is gone and `Aeta`
 * is what the wildcard would now name. Its body reads a file, so executing it
 * would be visible even though nothing it renders is.
 */
const REPLACEMENT_BODY = [
  "# Doc",
  "",
  "## Aeta",
  "",
  '<File path="beta-input.txt" as="beta" />',
  "",
].join("\n");

describe(
  "Tier CT — exact target before execution",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("CT12: a replacement seen by preparation is refused before the installer", function* () {
      yield* useFixture({ "doc.md": FIRST_BODY, "beta-input.txt": "BETA_INPUT" }, function* (dir) {
        const documentPath = path.join(dir, "doc.md");
        // The value-mode inspection already sees the replacement, so the run
        // never reaches the point where a provider would be installed.
        const run = yield* replacingRun(
          ["run", `${documentPath}#A*`, "--raw"],
          documentPath,
          REPLACEMENT_BODY,
          2,
          dir,
        );

        // The wildcard resolved to Alpha, so execution asked for exactly
        // Alpha — which the replaced document does not offer.
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('"Alpha" matches no document target.');
        expect(run.stderr).toContain("Available targets:");
        expect(run.stderr).toContain(`  ${documentPath}#Aeta`);
        // Never the caller's own glob: the run stopped on the target it chose.
        expect(run.stderr).not.toContain('"A*"');

        expect(run.serviceInstalled).toBe(false);
        expect(run.serviceStarted).toBe(false);
        expect(run.reads.some((read) => read.includes("beta-input.txt"))).toBe(false);
        expect(yield* exists(path.join(dir, "beta-input.txt"))).toBe(true);
      });
    });

    it("CT12a: a replacement seen only by execution is refused without starting a service", function* () {
      yield* useFixture({ "doc.md": FIRST_BODY, "beta-input.txt": "BETA_INPUT" }, function* (dir) {
        const documentPath = path.join(dir, "doc.md");
        // Preparation and the value-mode inspection both see the original, so
        // the replacement first appears on the read execution performs — after
        // the host provider is installed. This is the interval the contract
        // permits, and the case exists to hold what it still guarantees.
        const run = yield* replacingRun(
          ["run", `${documentPath}#A*`, "--raw"],
          documentPath,
          REPLACEMENT_BODY,
          3,
          dir,
        );

        expect(run.documentReads).toBe(3);
        expect(run.status).toBe(1);
        // Execution asked for the exact target preparation chose, not the glob.
        expect(run.stderr).toContain('"Alpha" matches no document target.');
        expect(run.stderr).toContain(`  ${documentPath}#Aeta`);
        expect(run.stderr).not.toContain('"A*"');

        // Provider installation happened; using it did not. `Aeta` never
        // expanded, so nothing its body would have read was read.
        expect(run.serviceInstalled).toBe(true);
        expect(run.serviceStarted).toBe(false);
        expect(run.reads.some((read) => read.includes("beta-input.txt"))).toBe(false);
      });
    });
  },
);

/**
 * Help is inspection, and inspection installs nothing.
 *
 * A subprocess can show that no artifact was left behind; it cannot show that
 * the host's provider installer was never invoked, because that is a call
 * inside the process. This drives `runXmd` directly for exactly that, with a
 * document whose every block is observable if it runs.
 */
describe(
  "Tier CT — contextual help installs nothing",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("CT19: file help exits zero, describes the catalog, and never installs", function* () {
      yield* useFixture({ "doc.md": EFFECTFUL }, function* (dir) {
        // The journal is *requested*, so its absence is evidence. Asking for
        // one and getting none is what separates "help created no journal"
        // from "nothing asked for a journal", which any run would satisfy.
        // IE19 is the positive control: an ordinary run with this option
        // writes the trace.
        const trace = path.join(dir, "trace.jsonl");
        const run = yield* helpRun(
          ["run", path.join(dir, "doc.md"), "--help", "--journal", trace],
          dir,
        );

        expect(run.status).toBe(0);
        expect(run.stdout).toContain("Targets in ");
        expect(run.stdout).toContain("Describes the work without performing any of it.");
        expect(run.stderr).toBe("");

        // The whole point: a provider was never wired in, so nothing could
        // have asked it for a service.
        expect(run.serviceInstalled).toBe(false);
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);
        expect(yield* exists(path.join(dir, ".xmd-eval"))).toBe(false);
        expect(yield* exists(trace)).toBe(false);
      });
    });
  },
);

interface HelpRun {
  status: number;
  stdout: string;
  stderr: string;
  /** Whether the host's provider installer ran. */
  serviceInstalled: boolean;
}

/** Drive `runXmd` in this process, capturing what it wrote and what it wired. */
function* helpRun(args: string[], cwd: string): Operation<HelpRun> {
  let status = 0;
  let stdout = "";
  let stderr = "";
  let serviceInstalled = false;

  const logged = console.log;
  const written = console.error;
  return yield* scoped(function* () {
    yield* ensure(() => {
      console.log = logged;
      console.error = written;
    });
    console.log = (...parts: unknown[]) => {
      stdout += `${parts.map((part) => String(part)).join(" ")}\n`;
    };
    console.error = (...parts: unknown[]) => {
      stderr += `${parts.map((part) => String(part)).join(" ")}\n`;
    };

    yield* ExitContext.set(function* (result) {
      status = result.status;
    });

    yield* API.Env.around({
      *cwd() {
        return cwd;
      },
    });
    yield* useHostFiles();

    yield* runXmd(args, function* () {
      serviceInstalled = true;
    });

    return { status, stdout, stderr, serviceInstalled };
  });
}
