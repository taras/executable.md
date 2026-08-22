/**
 * Tier WA — the provider-owned credential helper, and what acquisition refuses.
 *
 * The helper is the only way a credential the adapter holds ever leaves it, so
 * this is where the questions it will and will not answer are settled: an exact
 * locator answered, every other locator declined, `store` and `approve` doing
 * nothing, and `erase` writing one fixed nonsecret byte rather than reaching a
 * credential store.
 *
 * It is also where the line between two failures is drawn. A host that holds no
 * credential is a live condition this run reports; a helper that could not be
 * installed, run or read is the machine failing to provide a mechanism, and the
 * two must not arrive as the same answer.
 *
 * Nothing here reads a developer's real credential, and no assertion prints one:
 * what a test compares is a label this module computed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, until, type Operation } from "effection";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import {
  answerCredentialRequest,
  HELPER_VARIABLES,
  launcherName,
  launcherProgram,
  type HelperAssembly,
} from "../src/deno/composition/credential-helper.ts";
import {
  denoCredentialBroker,
  denoCredentialOperations,
} from "../src/deno/composition/authentication.ts";
import type {
  CredentialOperations,
  CredentialRequest,
} from "../src/deno/composition/authentication.ts";
import { TEST_HELPER } from "./support/composition.ts";
import { useInvokingHome } from "./support/credential-home.ts";

/** The credential this suite arranges. Never compared, only detected. */
const HELD = { username: "helper-user", password: "helper-secret" } as const;

const HOST = "helper.invalid";
const PATH = "octo/one.git";
const EXACT: CredentialRequest = Object.freeze({ protocol: "https", host: HOST, path: PATH });

/** What this answer speaks for, as a label rather than as a value. */
function speaksFor(answer: string): string {
  if (answer.includes(HELD.password)) {
    return "held";
  }
  return answer.trim() === "" ? "none" : "other";
}

/** The private environment one invocation gives its helper. */
function privately(overrides: Readonly<Record<string, string>> = {}) {
  return {
    [HELPER_VARIABLES.username]: HELD.username,
    [HELPER_VARIABLES.password]: HELD.password,
    [HELPER_VARIABLES.protocol]: EXACT.protocol,
    [HELPER_VARIABLES.host]: EXACT.host,
    [HELPER_VARIABLES.path]: PATH,
    ...overrides,
  };
}

/** One credential request, as Git writes one. */
function asked(fields: Readonly<Record<string, string>>): string {
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n\n`;
}

const REQUEST = { protocol: "https", host: HOST, path: PATH } as const;

describe("workflow credential helper answers", () => {
  it("answers the exact locator it was given, and nothing else", function* () {
    const marks: string[] = [];
    const answer = answerCredentialRequest("get", asked(REQUEST), privately(), (path) =>
      marks.push(path),
    );
    expect(speaksFor(answer)).toBe("held");
    expect(marks).toEqual([]);
  });

  /**
   * A redirect is Git asking about wherever it arrived rather than where the
   * invocation was authorized for. Each of these is a different place.
   */
  it("declines every locator that is not the one it was given", function* () {
    const elsewhere = [
      { ...REQUEST, protocol: "http" },
      { ...REQUEST, host: "elsewhere.invalid" },
      { ...REQUEST, host: `${HOST}:8443` },
      { ...REQUEST, path: "octo/two.git" },
      { protocol: REQUEST.protocol, host: REQUEST.host },
    ];
    for (const request of elsewhere) {
      const answer = answerCredentialRequest("get", asked(request), privately(), () => {});
      expect(speaksFor(answer)).toBe("none");
    }
  });

  it("answers nothing at all when the invocation gave it no repository", function* () {
    // A pathless invocation is one that authorized a server rather than a
    // repository, which this helper never answers for.
    const answer = answerCredentialRequest(
      "get",
      asked(REQUEST),
      privately({ [HELPER_VARIABLES.path]: "" }),
      () => {},
    );
    expect(speaksFor(answer)).toBe("none");
  });

  it("does nothing for store and approve, and forwards neither", function* () {
    for (const operation of ["store", "approve"]) {
      const marks: string[] = [];
      const answer = answerCredentialRequest(operation, asked(REQUEST), privately(), (path) =>
        marks.push(path),
      );
      expect(speaksFor(answer)).toBe("none");
      expect(marks).toEqual([]);
    }
  });

  it("marks an exact erase, and ignores one about anywhere else", function* () {
    const marked: string[] = [];
    expect(
      speaksFor(
        answerCredentialRequest(
          "erase",
          asked(REQUEST),
          privately({ [HELPER_VARIABLES.marker]: "/tmp/xmd-marker" }),
          (path) => marked.push(path),
        ),
      ),
    ).toBe("none");
    expect(marked).toEqual(["/tmp/xmd-marker"]);

    // A redirect must not be able to manufacture a rejection.
    const other: string[] = [];
    answerCredentialRequest(
      "erase",
      asked({ ...REQUEST, host: "elsewhere.invalid" }),
      privately({ [HELPER_VARIABLES.marker]: "/tmp/xmd-marker" }),
      (path) => other.push(path),
    );
    expect(other).toEqual([]);
  });
});

describe("workflow credential helper as Git runs it", () => {
  /** Drive the launcher exactly as Git drives a helper. */
  function* driven(
    operation: string,
    request: Readonly<Record<string, string>>,
    overrides: Readonly<Record<string, string>> = {},
  ): Operation<{ answer: string; marker: string }> {
    const directory = yield* useTempDirectory("xmd-helper-run-");
    const launcher = join(directory, launcherName(TEST_HELPER));
    const marker = join(directory, "rejected");
    yield* until(writeFile(launcher, launcherProgram(TEST_HELPER), { mode: 0o700 }));
    yield* until(chmod(launcher, 0o700));

    const outcome = spawnSync(launcher, [operation], {
      input: asked(request),
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        ...privately({ [HELPER_VARIABLES.marker]: marker, ...overrides }),
      },
      encoding: "utf8",
    });
    return { answer: typeof outcome.stdout === "string" ? outcome.stdout : "", marker };
  }

  function* present(path: string): Operation<boolean> {
    return yield* until(
      stat(path).then(
        () => true,
        () => false,
      ),
    );
  }

  it("answers get for the exact locator through Git's own protocol", function* () {
    const { answer, marker } = yield* driven("get", REQUEST);
    expect(speaksFor(answer)).toBe("held");
    expect(yield* present(marker)).toBe(false);
  });

  it("writes one fixed nonsecret byte for an exact erase", function* () {
    const { answer, marker } = yield* driven("erase", REQUEST);
    // No output at all, and what is on disk says a rejection happened without
    // saying anything about what was rejected.
    expect(speaksFor(answer)).toBe("none");
    expect(yield* present(marker)).toBe(true);
    const written = yield* until(readFile(marker, "utf8"));
    expect(written.includes(HELD.password) || written.includes(HELD.username)).toBe(false);
    expect(written.trim()).toBe("rejected");
  });

  it("leaves no marker for a store, an approve, or a mismatched erase", function* () {
    for (const [operation, request] of [
      ["store", REQUEST],
      ["approve", REQUEST],
      ["erase", { ...REQUEST, path: "octo/two.git" }],
    ] as const) {
      const { answer, marker } = yield* driven(operation, request);
      expect(speaksFor(answer)).toBe("none");
      expect(yield* present(marker)).toBe(false);
    }
  });
});

describe("workflow credential acquisition refusals", () => {
  /** The answers a fixture helper can give, and what each must produce. */
  const INCOMPLETE = [
    { named: "no username", lines: ["password=helper-secret"] },
    { named: "no password", lines: ["username=helper-user"] },
    { named: "no path", lines: ["username=helper-user", "password=helper-secret", "path="] },
    {
      named: "another path",
      lines: ["username=helper-user", "password=helper-secret", "path=octo/two.git"],
    },
  ] as const;

  /** A home whose helper answers exactly these lines, whatever it is asked. */
  function* homeAnswering(lines: readonly string[]): Operation<Record<string, string>> {
    const home = yield* useTempDirectory("xmd-answering-home-");
    const helper = join(home, "helper.sh");
    yield* until(
      writeFile(
        helper,
        [
          "#!/bin/sh",
          'if [ "$1" != "get" ]; then exit 0; fi',
          ...lines.map((line) => `echo '${line}'`),
          "",
        ].join("\n"),
        { mode: 0o700 },
      ),
    );
    yield* until(chmod(helper, 0o700));
    yield* until(writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`));
    return {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  it("refuses every incomplete or mismatched answer, before any transport", function* () {
    for (const answer of INCOMPLETE) {
      const ambient = yield* homeAnswering(answer.lines);
      yield* scoped(function* () {
        const lease = yield* denoCredentialBroker(ambient, {}, TEST_HELPER).lease(EXACT);
        // Not a credential, and not an infrastructure failure either: this host
        // holds nothing usable for this repository, which is a live condition.
        expect(lease.acquired).toBe(false);
        expect(lease.attachment().configuration).toEqual([]);
        expect(lease.attachment().environment).toEqual({});
      });
    }
  });

  it("asks the helper about the complete locator, with prompts off", function* () {
    const home = yield* useTempDirectory("xmd-recording-home-");
    const record = join(home, "asked");
    const helper = join(home, "helper.sh");
    yield* until(
      writeFile(
        helper,
        [
          "#!/bin/sh",
          'if [ "$1" != "get" ]; then exit 0; fi',
          // Reduced to labels here, so what a failure prints is a setting's
          // name and a verdict rather than anything the helper was given.
          `{ cat; echo "prompt=\${GIT_TERMINAL_PROMPT:-unset}"; ` +
            `echo "askpass=\${GIT_ASKPASS-unset}"; ` +
            `echo "sshaskpass=\${SSH_ASKPASS-unset}"; } > ${JSON.stringify(record)}`,
          `echo username=${HELD.username}`,
          `echo password=${HELD.password}`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      ),
    );
    yield* until(chmod(helper, 0o700));
    // Deliberately no `useHttpPath`: acquisition forces it, and a fixture that
    // set it would be proving the fixture.
    yield* until(writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`));

    yield* scoped(function* () {
      const lease = yield* denoCredentialBroker(
        {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          HOME: home,
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        {},
        TEST_HELPER,
      ).lease(EXACT);
      expect(lease.acquired).toBe(true);
    });

    // The complete locator reached the helper: scheme, host and repository.
    const asked = yield* until(readFile(record, "utf8"));
    expect(asked).toContain("protocol=https");
    expect(asked).toContain(`host=${HOST}`);
    expect(asked).toContain(`path=${PATH}`);

    // And the helper ran with no way to stop the run on a question: terminal
    // prompting off, and both askpass hooks present-but-empty rather than
    // naming a program somebody's environment chose.
    expect(asked).toContain("prompt=0");
    expect(asked).toContain("askpass=");
    expect(asked).not.toContain("askpass=unset");
    expect(asked).toContain("sshaskpass=");
    expect(asked).not.toContain("sshaskpass=unset");
  });
});

describe("workflow credential infrastructure failures", () => {
  /** Each boundary, and the injected fault that breaks it. */
  it("fails stop rather than reporting a credential this host does not lack", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: PATH, ...HELD }]);

    // Acquisition cannot be started at all. This is the machine failing to give
    // this run a mechanism, not a machine that holds no credential, and the two
    // must not arrive as the same answer.
    const unstartable = { ...home.ambient, PATH: "/xmd-nothing-here" };
    const raised = yield* scoped(function* () {
      try {
        yield* denoCredentialBroker(unstartable, {}, TEST_HELPER).lease(EXACT);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(raised).toBeDefined();
    // And nothing about a credential travels with it.
    expect(String(raised).includes(HELD.password)).toBe(false);
    expect(String(raised).includes(HELD.username)).toBe(false);
  });

  it("treats a marker it cannot read as a failure, never as `not rejected`", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: PATH, ...HELD }]);

    yield* scoped(function* () {
      const lease = yield* denoCredentialBroker(home.ambient, {}, TEST_HELPER).lease(EXACT);
      expect(lease.acquired).toBe(true);
      // Absent is the one thing that means "not rejected".
      expect(yield* lease.rejected()).toBe(false);

      const named = String(
        lease
          .attachment()
          .configuration.find((entry: string) => entry.startsWith("credential.helper=")),
      ).replace("credential.helper=", "");
      const marker = String(lease.attachment().environment[HELPER_VARIABLES.marker]);
      expect(marker.startsWith(named.replace(/\/[^/]+$/, ""))).toBe(true);

      // A marker that exists is a rejection, whatever else is true.
      yield* until(writeFile(marker, "rejected\n", { mode: 0o600 }));
      expect(yield* lease.rejected()).toBe(true);
    });
  });
});

describe("workflow credential injected infrastructure faults", () => {
  /** The operations this host performs, each replaceable and each able to fail. */
  function operations(broken: string): CredentialOperations {
    const real = denoCredentialOperations();
    const fault = (named: string) =>
      function* (): Operation<never> {
        throw new Error(`injected ${named} failure`);
      };
    return {
      writeLauncher: broken === "install" ? fault("install") : real.writeLauncher,
      markerPresent: broken === "marker-read" ? fault("marker-read") : real.markerPresent,
      removeWorkingDirectory:
        broken === "marker-remove"
          ? // Removes, then raises. A fault that skipped the removal would be
            // leaving this suite's own directories behind on every iteration —
            // the failure under test is the reporting of it, not the leak.
            function* (path: string): Operation<never> {
              yield* real.removeWorkingDirectory(path);
              throw new Error("injected marker-remove failure");
            }
          : real.removeWorkingDirectory,
    };
  }

  /**
   * Each frozen boundary, and what breaking it must produce.
   *
   * Injected rather than arranged with permissions: a privileged runner can
   * write where it should not be able to, and Windows does not express the same
   * modes, so a filesystem-arranged fault would be the environment's rather than
   * this test's.
   */
  const BOUNDARIES = ["install", "marker-read", "marker-remove"] as const;

  it("raises rather than reporting a credential this host does not lack", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: PATH, ...HELD }]);

    for (const boundary of BOUNDARIES) {
      // The try encloses the scope rather than sitting inside it: removal
      // happens as the invocation ends, so a failure of it arrives out of
      // teardown rather than out of the body.
      let raised: unknown;
      try {
        yield* scoped(function* () {
          const lease = yield* denoCredentialBroker(
            home.ambient,
            {},
            TEST_HELPER,
            operations(boundary),
          ).lease(EXACT);
          // The marker read fails when it is reached rather than when the
          // lease is opened.
          if (boundary === "marker-read") {
            yield* lease.rejected();
          }
        });
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeDefined();
      // Infrastructure, not unavailability: this host failed to provide a
      // mechanism, and saying "no credential" would make a broken machine look
      // like a clean refusal.
      expect(String(raised)).toContain("injected");
      // And nothing about a credential travels with it.
      expect(String(raised).includes(HELD.password)).toBe(false);
      expect(String(raised).includes(HELD.username)).toBe(false);
    }
  });

  it("reads an absent marker as absent, and nothing else as absent", function* () {
    const home = yield* useInvokingHome([{ host: HOST, path: PATH, ...HELD }]);

    // The shipped operations, which is the code under test here.
    yield* scoped(function* () {
      const lease = yield* denoCredentialBroker(home.ambient, {}, TEST_HELPER).lease(EXACT);
      expect(yield* lease.rejected()).toBe(false);
    });

    // A read that fails for any other reason is raised. Only absence is an
    // answer, because only absence means nothing was refused.
    const raised = yield* scoped(function* () {
      try {
        const lease = yield* denoCredentialBroker(
          home.ambient,
          {},
          TEST_HELPER,
          operations("marker-read"),
        ).lease(EXACT);
        yield* lease.rejected();
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(String(raised)).toContain("injected marker-read failure");
  });
});
