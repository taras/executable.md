/**
 * Tier PC — `xmd run` document properties end to end
 * (specs/root-document-props-spec.md).
 *
 * Shells out with captured stdio so exit status and diagnostics are
 * asserted TTY-independently, and so environment sources are exercised
 * the way a user supplies them.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { expectCli, runCli } from "@executablemd/test-support/launch";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

const HELLO = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name:",
  "      type: string",
  "      description: Person to greet",
  "    loud:",
  "      type: boolean",
  "      default: false",
  "    count: { type: number }",
  "    tags:",
  "      type: array",
  "      items: { type: string }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "Hello, {props.name}! loud={props.loud} count={props.count} tags={props.tags}",
  "",
].join("\n");

const NESTED = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    user:",
  "      type: object",
  "      properties:",
  "        name: { type: string }",
  "      additionalProperties: false",
  "  additionalProperties: false",
  "---",
  "",
  "user={props.user.name}",
  "",
].join("\n");

const OPEN = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "  additionalProperties: true",
  "---",
  "",
  "name={props.name}",
  "",
].join("\n");

const REFERENCED = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  '    count: { $ref: "#/definitions/count" }',
  "    counts:",
  "      type: array",
  '      items: { $ref: "#/definitions/count" }',
  "  definitions:",
  "    count: { type: number }",
  "  additionalProperties: false",
  "---",
  "",
  "count={props.count} counts={props.counts}",
  "",
].join("\n");

const PLAIN = "PLAIN_MARKER\n";

const MARKER = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "SIDE_EFFECT_MARKER",
  "",
].join("\n");

interface Fixture {
  dir: string;
}

function* useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-pc-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }
    return yield* body({ dir });
  });
}

describe(
  "Tier PC — xmd run document properties",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("PC1: individual command-line options supply properties", function* () {
      const { stdout } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(
          ["run", "hello.md", "--raw", "--props-name", "Ada", "--props-loud", "--props-count", "3"],
          { cwd: fixture.dir },
        );
      });
      expect(stdout).toContain("Hello, Ada!");
      expect(stdout).toContain("loud=true");
      expect(stdout).toContain("count=3");
    });

    it("PC2: individual environment variables supply properties", function* () {
      const { stdout } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["run", "hello.md", "--raw"], {
          cwd: fixture.dir,
          env: {
            XMD_PROPS_NAME: "Ada",
          },
        });
      });
      expect(stdout).toContain("Hello, Ada!");
    });

    it("PC3: aggregate JSON supplies properties from either source", function* () {
      const fromCli = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(
          ["run", "hello.md", "--raw", "--props", '{"name":"Ada","count":7}'],
          { cwd: fixture.dir },
        );
      });
      expect(fromCli.stdout).toContain("Hello, Ada!");
      expect(fromCli.stdout).toContain("count=7");

      const fromEnv = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["run", "hello.md", "--raw"], {
          cwd: fixture.dir,
          env: {
            XMD_PROPS: '{"name":"Env","count":9}',
          },
        });
      });
      expect(fromEnv.stdout).toContain("Hello, Env!");
      expect(fromEnv.stdout).toContain("count=9");
    });

    it("PC4: the documented precedence resolves per property", function* () {
      const { stdout } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(
          [
            "run",
            "hello.md",
            "--raw",
            "--props",
            '{"name":"agg-cli","count":2}',
            "--props-name",
            "ind-cli",
          ],
          {
            cwd: fixture.dir,
            env: { XMD_PROPS_NAME: "ind-env", XMD_PROPS: '{"name":"agg-env","tags":["t"]}' },
          },
        );
      });
      expect(stdout).toContain("Hello, ind-cli!");
      // Every other property still comes from the highest source that set it.
      expect(stdout).toContain("count=2");
      expect(stdout).toContain("tags=t");
    });

    it("PC5: an invalid higher-priority source fails instead of falling through", function* () {
      const { code, stderr, stdout } = yield* useFixture(
        { "hello.md": HELLO },
        function* (fixture) {
          return yield* runCli(
            ["run", "hello.md", "--raw", "--props-name", "x", "--props-count", "nope"],
            { cwd: fixture.dir, env: { XMD_PROPS_COUNT: "5" } },
          );
        },
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--props-count");
      expect(stdout).not.toContain("Hello");
    });

    it("PC6: booleans accept bare and explicit forms, never a negated one", function* () {
      const bare = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["run", "hello.md", "--raw", "--props-name", "x", "--props-loud"], {
          cwd: fixture.dir,
        });
      });
      expect(bare.stdout).toContain("loud=true");

      const explicit = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(
          ["run", "hello.md", "--raw", "--props-name", "x", "--props-loud=false"],
          { cwd: fixture.dir },
        );
      });
      expect(explicit.stdout).toContain("loud=false");

      const negated = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* runCli(["run", "hello.md", "--raw", "--props-name", "x", "--no-props-loud"], {
          cwd: fixture.dir,
        });
      });
      expect(negated.code).toBe(1);
      expect(negated.stderr).toContain("no negated form");
    });

    it("PC7: arrays repeat on the command line and are JSON in the environment", function* () {
      const repeated = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(
          [
            "run",
            "hello.md",
            "--raw",
            "--props-name",
            "x",
            "--props-tags",
            "a",
            "--props-tags",
            "b",
          ],
          { cwd: fixture.dir },
        );
      });
      expect(repeated.stdout).toContain("tags=a, b");

      const fromEnv = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["run", "hello.md", "--raw", "--props-name", "x"], {
          cwd: fixture.dir,
          env: {
            XMD_PROPS_TAGS: '["alpha","beta"]',
          },
        });
      });
      expect(fromEnv.stdout).toContain("tags=alpha, beta");
    });

    it("PC8: text keeps its exact value while aggregate JSON keeps its exact type", function* () {
      const padded = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["run", "hello.md", "--raw", "--props-name", "007"], {
          cwd: fixture.dir,
        });
      });
      expect(padded.stdout).toContain("Hello, 007!");

      const typed = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* runCli(["run", "hello.md", "--raw", "--props", '{"name":"x","count":"12"}'], {
          cwd: fixture.dir,
        });
      });
      expect(typed.code).toBe(1);
      expect(typed.stderr).toContain("--props");
    });

    it("PC9: a missing required property fails before any document effect", function* () {
      const { code, stdout } = yield* useFixture({ "doc.md": MARKER }, function* (fixture) {
        return yield* runCli(["run", "doc.md", "--raw"], { cwd: fixture.dir });
      });
      expect(code).toBe(1);
      expect(stdout).not.toContain("SIDE_EFFECT_MARKER");
    });

    it("PC10: additionalProperties governs aggregate objects at every level", function* () {
      const nested = yield* useFixture({ "nested.md": NESTED }, function* (fixture) {
        return yield* runCli(
          ["run", "nested.md", "--raw", "--props", '{"user":{"name":"Ada","extra":true}}'],
          { cwd: fixture.dir },
        );
      });
      expect(nested.code).toBe(1);
      expect(nested.stderr).toContain("must NOT have additional properties");

      const open = yield* useFixture({ "open.md": OPEN }, function* (fixture) {
        return yield* expectCli(
          ["run", "open.md", "--raw", "--props", '{"name":"Ada","extra":true}'],
          { cwd: fixture.dir },
        );
      });
      expect(open.stdout).toContain("name=Ada");
    });

    it("PC11: an unknown individual option names the aggregate as the way in", function* () {
      const { code, stderr } = yield* useFixture({ "open.md": OPEN }, function* (fixture) {
        return yield* runCli(["run", "open.md", "--raw", "--props-extra", "1"], {
          cwd: fixture.dir,
        });
      });
      expect(code).toBe(1);
      expect(stderr).toContain("--props-extra");
      expect(stderr).toContain("--props");
    });

    it("PC12: document help describes the declared properties in every position", function* () {
      for (const args of [
        ["run", "hello.md", "--help"],
        ["run", "--help", "hello.md"],
        ["hello.md", "--help"],
      ]) {
        const { stdout } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
          return yield* expectCli(args, { cwd: fixture.dir });
        });
        expect(stdout).toContain("Properties declared by hello.md");
        expect(stdout).toContain("--props-name <string>");
        expect(stdout).toContain("Person to greet");
        expect(stdout).toContain("Environment: XMD_PROPS_NAME");
        expect(stdout).toContain("Required");
        expect(stdout).toContain("--props-loud[=<boolean>]");
        expect(stdout).toContain("Default: false");
        expect(stdout).toContain("--props <json>");
      }
    });

    it("PC13: help reports no current values and runs no document", function* () {
      const { stdout } = yield* useFixture({ "doc.md": MARKER }, function* (fixture) {
        return yield* expectCli(["run", "doc.md", "--help"], {
          cwd: fixture.dir,
          env: {
            XMD_PROPS_NAME: "SHOULD_NOT_APPEAR",
          },
        });
      });
      expect(stdout).not.toContain("SIDE_EFFECT_MARKER");
      expect(stdout).not.toContain("SHOULD_NOT_APPEAR");
    });

    it("PC14: help without a document, and a document without properties, show no section", function* () {
      const generic = yield* useFixture({ "plain.md": PLAIN }, function* (fixture) {
        return yield* expectCli(["run", "--help"], { cwd: fixture.dir });
      });
      expect(generic.stdout).not.toContain("Properties declared by");

      const plain = yield* useFixture({ "plain.md": PLAIN }, function* (fixture) {
        return yield* expectCli(["run", "plain.md", "--help"], { cwd: fixture.dir });
      });
      expect(plain.stdout).not.toContain("Properties declared by");
    });

    it("PC15: document-derived options must follow the document", function* () {
      const { code, stderr } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* runCli(["run", "--props-name", "Ada", "hello.md"], { cwd: fixture.dir });
      });
      expect(code).toBe(1);
      expect(stderr).toContain("follow the document");
    });

    it("PC16: xmd test does not accept document properties", function* () {
      const { code, stderr } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* runCli(["test", "hello.md", "--props-name", "Ada"], { cwd: fixture.dir });
      });
      expect(code).toBe(1);
      expect(stderr).toContain("exclusive to xmd run");
    });

    it("PC17: a document without props is unaffected", function* () {
      const { stdout } = yield* useFixture({ "plain.md": PLAIN }, function* (fixture) {
        return yield* expectCli(["run", "plain.md", "--raw"], { cwd: fixture.dir });
      });
      expect(stdout).toContain("PLAIN_MARKER");
    });

    it("PC19: a referenced scalar gets bindings, decoding, and a rendered value form", function* () {
      const help = yield* useFixture({ "ref.md": REFERENCED }, function* (fixture) {
        return yield* expectCli(["run", "ref.md", "--help"], { cwd: fixture.dir });
      });
      expect(help.stdout).toContain("--props-count <number>");
      expect(help.stdout).toContain("--props-counts <number>...");
      expect(help.stdout).toContain("Environment: XMD_PROPS_COUNT");

      const { stdout } = yield* useFixture({ "ref.md": REFERENCED }, function* (fixture) {
        return yield* expectCli(
          [
            "run",
            "ref.md",
            "--raw",
            "--props-count",
            "12",
            "--props-counts",
            "1",
            "--props-counts",
            "2",
          ],
          { cwd: fixture.dir },
        );
      });
      expect(stdout).toContain("count=12");
      expect(stdout).toContain("counts=1, 2");
    });

    it("PC20: a structured-only document still documents the aggregate", function* () {
      const { stdout } = yield* useFixture({ "nested.md": NESTED }, function* (fixture) {
        return yield* expectCli(["run", "nested.md", "--help"], { cwd: fixture.dir });
      });
      expect(stdout).toContain("Properties declared by nested.md");
      expect(stdout).toContain("--props <json>");
      expect(stdout).toContain("Environment: XMD_PROPS");
      // It declares only an object, so it generates no individual option.
      expect(stdout).not.toContain("--props-user");
    });

    it("PC18: the default command form accepts properties", function* () {
      const { stdout } = yield* useFixture({ "hello.md": HELLO }, function* (fixture) {
        return yield* expectCli(["hello.md", "--raw", "--props-name", "Ada"], { cwd: fixture.dir });
      });
      expect(stdout).toContain("Hello, Ada!");
    });
  },
);
