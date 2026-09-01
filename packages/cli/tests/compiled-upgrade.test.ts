/**
 * Tier UH — the compiled host that actually replaces `xmd`.
 *
 * Every case runs the real packaged policy against the real host, with a real
 * file standing in for the installed binary in a directory of its own. What is
 * scripted is the four seams a deterministic failure cannot be produced through
 * otherwise — the HTTPS reads, the byte bounds, the candidate process and the
 * commit — and nothing else: every validation runs against whatever those
 * return, so a refused redirect, a short body or a failing rename is evidence
 * about production rather than about a test mode.
 *
 * The installed file's exact bytes are the assertion that matters most. Before
 * the rename they must be what they were, in every failure, and after it they
 * must be the candidate's and stay the candidate's. So each case reads them
 * back rather than reading a message about them.
 *
 * This file runs under Deno alone (`scripts/runtime-test-exclusions.ts`). The
 * installation lock is a real non-blocking advisory lock taken through the Deno
 * runtime and raced against a real Deno child, and no other runtime has one.
 * The portable half — every branch of the policy — is Tier UG.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, createContext, ensure, scoped, sleep, spawn, until } from "effection";
import type { Operation, Result } from "effection";
import { exec } from "@effectionx/process";
import { useTempFileCompiler } from "@executablemd/core";
import { useHostFiles } from "@executablemd/runtime";
import type { ComponentInvocation, Json } from "@executablemd/core";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runXmd } from "../src/cli.ts";
import { compiledUpgradeAssembly, writeAll } from "../src/compiled-upgrade.ts";
import type {
  CompiledUpgradeDependencies,
  UpgradeRequest,
  UpgradeResponse,
} from "../src/compiled-upgrade.ts";
import { releaseTargetFor, RELEASE_TARGETS } from "../src/release-targets.ts";
import { runUpgrade } from "../src/upgrade.ts";
import type { UpgradeAssembly, UpgradeCommand } from "../src/upgrade.ts";
import { InMemoryStream } from "@executablemd/durable-streams";

/**
 * The exit continuation `exit()` reaches for. `main()` installs one under this
 * name; a suite driving `runXmd` directly installs its own so a command's
 * status is a value rather than this process ending.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

const OWNER_REPO = "taras/executable.md";
const API = `https://api.github.com/repos/${OWNER_REPO}/releases`;
const DOWNLOAD = `https://github.com/${OWNER_REPO}/releases/download`;
const DELIVERY = "https://release-assets.githubusercontent.com/xmd";

/**
 * The platform every case declares.
 *
 * Fixed rather than read from the runner, so the asset name in every URL below
 * is the same on every machine. It names the artifact, never how anything is
 * executed: the candidate this suite stages is a real script the host runs.
 */
const PLATFORM = { platform: "linux", architecture: "x64" };
const TARGET = "x86_64-unknown-linux-gnu";
const ASSET = `xmd-${TARGET}`;
const INSTALLED = "0.10.2";
const RELEASE = "v0.11.0";
const NEXT = "0.11.0";

/** The bytes a run installs, as the candidate a real `--version` can answer. */
const CANDIDATE = `#!/bin/sh\necho ${NEXT}\n`;
const ORIGINAL = `#!/bin/sh\necho ${INSTALLED}\n`;

interface Route {
  status?: number;
  location?: string;
  body?: string | Uint8Array;
  /** An advertised length that disagrees with the body, when a case needs one. */
  advertised?: number;
  /** Fail the body part-way through, after this many bytes. */
  interruptAfter?: number;
  /** Suspend before answering, so a case can halt the run mid-flight. */
  hold?: boolean;
  /** Raise instead of answering, the way a refused socket does. */
  throws?: boolean;
}

interface Attempt {
  command?: Partial<UpgradeCommand>;
  routes?: Record<string, Route>;
  /** Releases the listing endpoint answers with. */
  releases?: unknown;
  /** The checksum file's exact content, when a case needs a malformed one. */
  checksums?: string;
  /** The asset bytes served for the release binary. */
  asset?: string | Uint8Array;
  dependencies?: CompiledUpgradeDependencies;
}

interface Outcome {
  /** The transcript, exactly as a piped caller would receive it. */
  output: string;
  failure?: string;
  /** Every URL the transport was asked for, in order. */
  requested: string[];
  /** The installed file's bytes after the attempt. */
  installed: string;
  /** Whatever is left in the installation directory besides the binary. */
  leftovers: string[];
  executablePath: string;
}

/** The first release identity a listing admitted, read without casting. */
function firstReleaseIdentity(listed: unknown): string {
  const value = Reflect.get(Object(listed), "value");
  const releases = Reflect.get(Object(value), "releases");
  const first = Array.isArray(releases) ? releases[0] : undefined;
  const identity = Reflect.get(Object(first), "identity");
  if (typeof identity !== "string") {
    throw new Error("the listing admitted no release");
  }
  return identity;
}

/** The candidate identity a download handed back, read without casting. */
function candidateIdentity(staged: unknown): string {
  const value = Reflect.get(Object(staged), "value");
  const candidate = Reflect.get(Object(value), "candidate");
  if (typeof candidate !== "string") {
    const code = Reflect.get(Object(Reflect.get(Object(staged), "error")), "code");
    throw new Error(`the download staged no candidate (${String(code)})`);
  }
  return candidate;
}

/** A self-closing invocation, which is how every phase is written. */
const INVOCATION: ComponentInvocation = { hasContent: () => false };

/** A claimant nothing here spends: none of these phases names durable work. */
// deno-lint-ignore require-yield
function* claimNothing(): Operation<string> {
  return "unused";
}

function release(
  tag: string,
  options: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {},
) {
  return {
    tag_name: tag,
    draft: options.draft === true,
    prerelease: options.prerelease === true,
    html_url: `https://github.com/${OWNER_REPO}/releases/tag/${tag}`,
    // Fields a real payload carries and this host ignores.
    id: 42,
    body: "notes",
    assets: (options.assets ?? [ASSET, "checksums.txt"]).map((name) => ({
      name,
      browser_download_url: `${DOWNLOAD}/${tag}/${name}`,
      size: 10,
    })),
  };
}

function digestOf(content: string | Uint8Array): string {
  return createHash("sha256").update(bytesOf(content)).digest("hex");
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function streamOf(content: Uint8Array, interruptAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (interruptAfter !== undefined && sent >= interruptAfter) {
        controller.error(new Error("the connection dropped"));
        return;
      }
      if (sent >= content.byteLength) {
        controller.close();
        return;
      }
      const end =
        interruptAfter === undefined
          ? content.byteLength
          : Math.min(content.byteLength, interruptAfter);
      controller.enqueue(content.slice(sent, end));
      sent = end;
    },
  });
}

/**
 * The transport a case scripts, and the record of what it was asked.
 *
 * A URL nothing routes answers 404 rather than throwing: the point of most
 * cases is that a particular request was never made, and an unrouted request
 * has to be visible in the record rather than as an exception from elsewhere.
 */
function scripted(routes: Record<string, Route>, requested: string[]) {
  return function* transport(request: UpgradeRequest): Operation<UpgradeResponse> {
    requested.push(request.url);
    const route = routes[request.url] ?? { status: 404 };
    if (route.hold === true) {
      yield* sleep(60_000);
    }
    if (route.throws === true) {
      throw new Error("ECONNRESET");
    }
    const content = route.body === undefined ? undefined : bytesOf(route.body);
    return {
      status: route.status ?? 200,
      location: route.location,
      contentLength: route.advertised ?? content?.byteLength,
      body: content === undefined ? undefined : streamOf(content, route.interruptAfter),
      // deno-lint-ignore require-yield
      *cancel() {},
    };
  };
}

/**
 * One upgrade run against a given assembly, with the transcript discarded.
 *
 * The cases below are about what happens to the installation, not about what
 * the reader sees; Tier UG owns the transcript.
 */
function upgradeWith(assembly: UpgradeAssembly): Operation<Result<void>> {
  return runUpgrade({
    command: {
      requestedTag: null,
      status: false,
      allowDowngrade: false,
      allowPrerelease: false,
    },
    assembly,
    stream: new InMemoryStream(),
    // deno-lint-ignore require-yield
    *consume() {},
  });
}

/** A directory holding one installed `xmd`, and nothing else. */
function* useInstallation<T>(body: (dir: string, exe: string) => Operation<T>): Operation<T> {
  const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-uh-")));
  return yield* scoped(function* () {
    yield* ensure(() => until(rm(dir, { recursive: true, force: true })));
    const exe = join(dir, "xmd");
    yield* until(writeFile(exe, ORIGINAL, { mode: 0o755 }));
    return yield* body(dir, exe);
  });
}

/** The routes a complete, healthy release answers with. */
function healthyRoutes(attempt: Attempt): Record<string, Route> {
  const asset = attempt.asset ?? CANDIDATE;
  const checksums = attempt.checksums ?? `${digestOf(asset)}  ${ASSET}\n`;
  const releases = attempt.releases ?? [release(RELEASE), release("v0.10.2")];
  return {
    [`${API}?per_page=100&page=1`]: { body: JSON.stringify(releases) },
    [`${API}/tags/${RELEASE}`]: { body: JSON.stringify(release(RELEASE)) },
    [`${DOWNLOAD}/${RELEASE}/checksums.txt`]: { body: checksums },
    [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { body: asset },
    ...attempt.routes,
  };
}

function* attempt(options: Attempt = {}): Operation<Outcome> {
  return yield* useInstallation(function* (dir, exe) {
    return yield* run(options, dir, exe);
  });
}

function* run(options: Attempt, dir: string, exe: string): Operation<Outcome> {
  const requested: string[] = [];
  const assembly = compiledUpgradeAssembly(
    { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
    { transport: scripted(healthyRoutes(options), requested), ...options.dependencies },
  );

  const chunks: string[] = [];
  const outcome = yield* runUpgrade({
    command: {
      requestedTag: null,
      status: false,
      allowDowngrade: false,
      allowPrerelease: false,
      ...options.command,
    },
    assembly,
    stream: new InMemoryStream(),
    // deno-lint-ignore require-yield
    *consume(chunk) {
      chunks.push(chunk);
    },
  });

  return {
    ...(outcome.ok ? {} : { failure: outcome.error.message }),
    output: chunks.join(""),
    requested,
    installed: yield* readInstalled(exe),
    leftovers: yield* leftoversIn(dir, exe),
    executablePath: exe,
  };
}

function* readInstalled(exe: string): Operation<string> {
  return yield* until(readFile(exe, "utf8"));
}

/**
 * Whatever the installation directory holds besides the binary.
 *
 * The lock sidecar is expected and stays; staging is not, and a case that only
 * checked the binary would miss a candidate left lying beside it.
 */
function* leftoversIn(dir: string, exe: string): Operation<string[]> {
  const entries = yield* until(readdir(dir));
  return entries.filter((entry) => join(dir, entry) !== exe).sort();
}

describe(
  "Tier UH — the compiled upgrade host",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("UH1: every platform maps to the exact artifact the release publishes", function* () {
      // One table, two consumers. `release.yml` compiles these five targets and
      // names these five artifacts; this is the lookup a running binary uses to
      // ask for its own.
      const mapped = RELEASE_TARGETS.map(
        (row) => `${row.platform}/${row.architecture} ${row.target} ${row.artifact}`,
      );

      expect(mapped).toEqual([
        "darwin/arm64 aarch64-apple-darwin xmd-aarch64-apple-darwin",
        "darwin/x64 x86_64-apple-darwin xmd-x86_64-apple-darwin",
        "linux/x64 x86_64-unknown-linux-gnu xmd-x86_64-unknown-linux-gnu",
        "linux/arm64 aarch64-unknown-linux-gnu xmd-aarch64-unknown-linux-gnu",
        "win32/x64 x86_64-pc-windows-msvc xmd-x86_64-pc-windows-msvc.exe",
      ]);
      expect(releaseTargetFor("linux", "riscv64")).toBe(undefined);
      expect(releaseTargetFor("darwin", "arm64")?.artifact).toBe("xmd-aarch64-apple-darwin");
    });

    it("UH2: only an eligible compiled host carries the components at all", function* () {
      const host = { executablePath: "/opt/xmd/bin/xmd", currentVersion: INSTALLED };

      const eligible = compiledUpgradeAssembly({ ...host, ...PLATFORM });
      expect(eligible.provenance).toBe("compiled");
      expect(typeof eligible.authority).toBe("function");

      const windows = compiledUpgradeAssembly({
        ...host,
        platform: "win32",
        architecture: "x64",
      });
      expect(windows.provenance).toBe("compiled-windows");
      expect(windows.authority).toBe(undefined);

      // A compiled binary on a platform no release targets has nothing to ask
      // for, so it is handed no way to ask.
      const untargeted = compiledUpgradeAssembly({
        ...host,
        platform: "linux",
        architecture: "riscv64",
      });
      expect(untargeted.provenance).toBe("compiled");
      expect(untargeted.target).toBe(undefined);
      expect(untargeted.authority).toBe(undefined);
    });

    it("UH3: a successful upgrade replaces the bytes once and reports the facts", function* () {
      // The candidate really is downloaded, hashed, made executable, run for its
      // version, and renamed over the installed file: the only scripted part is
      // where the bytes came from.
      const outcome = yield* attempt();

      expect(outcome.failure).toBe(undefined);
      expect(outcome.installed).toBe(CANDIDATE);
      expect(outcome.output).toContain(
        [
          `Installed xmd ${NEXT} (replaced ${INSTALLED}).`,
          `Binary: ${outcome.executablePath}`,
          `Release notes: https://github.com/${OWNER_REPO}/releases/tag/${RELEASE}`,
        ].join("\n"),
      );
      // The lock sidecar stays; nothing else does.
      expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
    });

    it("UH4: --status reads metadata and touches the installation not at all", function* () {
      const outcome = yield* attempt({ command: { status: true } });

      expect(outcome.output).toContain(`Selected release: ${RELEASE} (newer)`);
      expect(outcome.output).toContain("No files were changed.");
      expect(outcome.installed).toBe(ORIGINAL);
      // No lock sidecar, no staging, no probe file: status opened nothing.
      expect(outcome.leftovers).toEqual([]);
      // And it downloaded nothing — the listing, and only the listing.
      expect(outcome.requested).toEqual([`${API}?per_page=100&page=1`]);
    });

    it("UH5: an exact tag reads the tag endpoint and installs that release", function* () {
      const outcome = yield* attempt({ command: { requestedTag: RELEASE } });

      expect(outcome.requested[0]).toBe(`${API}/tags/${RELEASE}`);
      expect(outcome.installed).toBe(CANDIDATE);
    });

    it("UH6: a tag GitHub does not publish is a missing release, not a broken read", function* () {
      // 404 on the exact-tag endpoint means "no such release", and the policy has
      // a sentence for that. Reporting it as a metadata defect would send a
      // person to check their network over a tag they mistyped.
      const outcome = yield* attempt({
        command: { requestedTag: "v9.9.9" },
        routes: { [`${API}/tags/v9.9.9`]: { status: 404, body: "{}" } },
      });

      expect(outcome.failure).toContain("GitHub has no published xmd release tagged v9.9.9");
      expect(outcome.installed).toBe(ORIGINAL);
    });

    it("UH7: a draft never reaches installation, however it is selected", function* () {
      const drafted = [release("v0.12.0", { draft: true }), release(RELEASE)];

      const implicit = yield* attempt({ releases: drafted });
      expect(implicit.installed).toBe(CANDIDATE);
      expect(implicit.output).toContain(`Installed xmd ${NEXT}`);

      const exact = yield* attempt({
        command: { requestedTag: "v0.12.0" },
        routes: {
          [`${API}/tags/v0.12.0`]: { body: JSON.stringify(release("v0.12.0", { draft: true })) },
        },
      });
      expect(exact.failure).toContain("GitHub has no published xmd release tagged v0.12.0");
      expect(exact.installed).toBe(ORIGINAL);
    });

    it("UH8: metadata that is malformed, oversized or incomplete is refused as such", function* () {
      const malformed = yield* attempt({
        routes: { [`${API}?per_page=100&page=1`]: { body: "{" } },
      });
      expect(malformed.failure).toContain("could not read or validate GitHub release information");

      const wrongShape = yield* attempt({ releases: [{ tag_name: RELEASE, draft: false }] });
      expect(wrongShape.failure).toContain("could not read or validate GitHub release information");

      // A release page from another repository, offered under our endpoint.
      const foreign = yield* attempt({
        releases: [
          { ...release(RELEASE), html_url: "https://github.com/attacker/xmd/releases/tag/v9" },
        ],
      });
      expect(foreign.failure).toContain("could not read or validate GitHub release information");

      // Two assets of one name: the release's own record disagrees with itself.
      const duplicated = yield* attempt({
        releases: [release(RELEASE, { assets: [ASSET, ASSET, "checksums.txt"] })],
      });
      expect(duplicated.failure).toContain("could not read or validate GitHub release information");

      const oversized = yield* attempt({
        dependencies: { bounds: { metadataBytes: 8 } },
      });
      expect(oversized.failure).toContain("could not read or validate GitHub release information");

      // A listing that never reaches a short page is incomplete, and an
      // incomplete list must never be reported as "there is no stable release".
      const full = Array.from({ length: 100 }, (_entry, index) =>
        release(`v0.0.${index}-rc.1`, {
          prerelease: true,
        }),
      );
      const endless = yield* attempt({
        dependencies: { bounds: { metadataPages: 2 } },
        routes: {
          [`${API}?per_page=100&page=1`]: { body: JSON.stringify(full) },
          [`${API}?per_page=100&page=2`]: { body: JSON.stringify(full) },
        },
      });
      expect(endless.failure).toContain("could not read or validate GitHub release information");
      expect(endless.failure).not.toContain("has no published stable xmd release");

      for (const outcome of [malformed, wrongShape, foreign, duplicated, oversized, endless]) {
        expect(outcome.installed).toBe(ORIGINAL);
      }
    });

    it("UH9: a release missing this target's binary or its checksums is refused", function* () {
      const noBinary = yield* attempt({
        releases: [release(RELEASE, { assets: ["checksums.txt"] })],
      });
      expect(noBinary.failure).toContain(
        `Release ${RELEASE} does not include a binary for x86_64-unknown-linux-gnu.`,
      );

      const noChecksums = yield* attempt({ releases: [release(RELEASE, { assets: [ASSET] })] });
      expect(noChecksums.failure).toContain(
        `Release ${RELEASE} does not include checksums.txt, so its binary cannot be verified.`,
      );

      for (const outcome of [noBinary, noChecksums]) {
        expect(outcome.installed).toBe(ORIGINAL);
        // Refused from the release's own record, before a byte was asked for.
        expect(outcome.requested).toEqual([`${API}?per_page=100&page=1`]);
      }
    });

    it("UH10: a checksum set must name this binary exactly once", function* () {
      const missing = yield* attempt({ checksums: `${digestOf(CANDIDATE)}  some-other-file\n` });
      expect(missing.failure).toContain(
        `checksums.txt for release ${RELEASE} does not include the ${TARGET} binary,`,
      );

      const duplicate = yield* attempt({
        checksums: [`${digestOf(CANDIDATE)}  ${ASSET}`, `${digestOf("other")}  ${ASSET}`, ""].join(
          "\n",
        ),
      });
      expect(duplicate.failure).toContain(
        `checksums.txt for release ${RELEASE} includes the ${TARGET} binary more than once,`,
      );

      for (const outcome of [missing, duplicate]) {
        expect(outcome.installed).toBe(ORIGINAL);
        // The entry is matched in the verification phase, so the binary has
        // been downloaded and staged by the time this is discovered. It is
        // never made executable and never run: the candidate is thrown away.
        expect(outcome.requested).toContain(`${DOWNLOAD}/${RELEASE}/${ASSET}`);
        expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
      }
    });

    it("UH11: a checksum mismatch stops before the candidate is made executable", function* () {
      let probed = 0;
      const outcome = yield* attempt({
        checksums: `${digestOf("something else entirely")}  ${ASSET}\n`,
        dependencies: {
          // deno-lint-ignore require-yield
          *probe() {
            probed += 1;
            return { code: 0, stdout: `${NEXT}\n`, timedOut: false };
          },
        },
      });

      expect(outcome.failure).toContain(
        `The downloaded ${RELEASE} binary does not match its published SHA-256 checksum.`,
      );
      // Never run. A candidate whose bytes are not the published ones is not a
      // candidate, and asking it what version it is would be asking bytes nobody
      // vouched for to identify themselves.
      expect(probed).toBe(0);
      expect(outcome.installed).toBe(ORIGINAL);
      expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
    });

    it("UH12: a candidate that does not report the selected version never replaces anything", function* () {
      const candidateRefusal = `The checksum-verified ${RELEASE} binary did not report version ${NEXT}.`;
      const reports = [
        { code: 1, stdout: `${NEXT}\n`, timedOut: false },
        { code: 0, stdout: "0.9.9\n", timedOut: false },
        { code: 0, stdout: `xmd ${NEXT}\n`, timedOut: false },
        { code: 0, stdout: "", timedOut: false },
        { code: -1, stdout: "", timedOut: true },
      ];

      for (const report of reports) {
        let committed = 0;
        const outcome = yield* attempt({
          dependencies: {
            // deno-lint-ignore require-yield
            *probe() {
              return report;
            },
            // deno-lint-ignore require-yield
            *commit() {
              committed += 1;
            },
          },
        });
        expect({ report, matched: outcome.failure?.includes(candidateRefusal) }).toEqual({
          report,
          matched: true,
        });
        expect({ report, committed, installed: outcome.installed }).toEqual({
          report,
          committed: 0,
          installed: ORIGINAL,
        });
        expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
      }
    });

    it("UH13: stdout is the version only after its own terminal line ending", function* () {
      // Both endings, and nothing else trimmed: a candidate that printed the
      // version with anything around it did not report the version.
      for (const stdout of [`${NEXT}\n`, `${NEXT}\r\n`, NEXT]) {
        const outcome = yield* attempt({
          dependencies: {
            // deno-lint-ignore require-yield
            *probe() {
              return { code: 0, stdout, timedOut: false };
            },
          },
        });
        expect({ stdout, installed: outcome.installed }).toEqual({ stdout, installed: CANDIDATE });
      }

      const padded = yield* attempt({
        dependencies: {
          // deno-lint-ignore require-yield
          *probe() {
            return { code: 0, stdout: ` ${NEXT} \n`, timedOut: false };
          },
        },
      });
      expect(padded.installed).toBe(ORIGINAL);
    });

    it("UH14: a download that leaves the GitHub boundary is refused, however it leaves", function* () {
      const cases: [string, Route, string][] = [
        [
          "another host entirely",
          { status: 302, location: "https://evil.example/xmd" },
          "redirected outside GitHub\u2019s release download service",
        ],
        [
          "a host that merely ends in ours",
          { status: 302, location: "https://github.com.evil.example/xmd" },
          "redirected outside GitHub\u2019s release download service",
        ],
        [
          "userinfo naming ours",
          { status: 302, location: "https://github.com@evil.example/xmd" },
          "redirected outside GitHub\u2019s release download service",
        ],
        [
          "an alternate port",
          { status: 302, location: "https://release-assets.githubusercontent.com:8443/xmd" },
          "redirected outside GitHub\u2019s release download service",
        ],
        [
          "plain HTTP",
          { status: 302, location: "http://release-assets.githubusercontent.com/xmd" },
          "redirected outside GitHub\u2019s release download service",
        ],
        [
          "a path outside this repository",
          {
            status: 302,
            location: `https://github.com/attacker/xmd/releases/download/v1/${ASSET}`,
          },
          "redirected outside GitHub\u2019s release download service",
        ],
      ];

      for (const [label, route, message] of cases) {
        const outcome = yield* attempt({
          routes: { [`${DOWNLOAD}/${RELEASE}/checksums.txt`]: route },
        });
        expect({ label, failure: outcome.failure?.includes(message) }).toEqual({
          label,
          failure: true,
        });
        expect({ label, installed: outcome.installed }).toEqual({ label, installed: ORIGINAL });
      }
    });

    it("UH15: GitHub's own signed delivery host is followed, and only so far", function* () {
      const checksums = `${digestOf(CANDIDATE)}  ${ASSET}\n`;
      const followed = yield* attempt({
        routes: {
          [`${DOWNLOAD}/${RELEASE}/checksums.txt`]: {
            status: 302,
            location: `${DELIVERY}/checksums.txt`,
          },
          [`${DELIVERY}/checksums.txt`]: { body: checksums },
          [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { status: 302, location: `${DELIVERY}/${ASSET}` },
          [`${DELIVERY}/${ASSET}`]: { body: CANDIDATE },
        },
      });
      expect(followed.installed).toBe(CANDIDATE);
      expect(followed.requested).toContain(`${DELIVERY}/${ASSET}`);

      // A redirect that never lands. The hop ceiling ends it rather than a
      // request count nobody bounded.
      const looping = yield* attempt({
        dependencies: { bounds: { redirects: 3 } },
        routes: {
          [`${DOWNLOAD}/${RELEASE}/checksums.txt`]: {
            status: 302,
            location: `${DELIVERY}/checksums.txt`,
          },
          [`${DELIVERY}/checksums.txt`]: { status: 302, location: `${DELIVERY}/checksums.txt` },
        },
      });
      expect(looping.failure).toContain("could not completely download");
      expect(looping.installed).toBe(ORIGINAL);
      expect(looping.requested.filter((url) => url === `${DELIVERY}/checksums.txt`)).toHaveLength(
        3,
      );
    });

    it("UH16: a download that is short, oversized or interrupted never installs", function* () {
      // Short: the bytes arrive, and they are not the bytes the release vouched
      // for, so the digest is what catches it.
      const short = yield* attempt({
        routes: { [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { body: CANDIDATE.slice(0, 4) } },
      });
      expect(short.failure).toContain("does not match its published SHA-256 checksum");

      const oversized = yield* attempt({
        dependencies: { bounds: { binaryBytes: 4 } },
      });
      expect(oversized.failure).toContain("could not completely download");

      // An advertised length over the bound is refused before a byte is read.
      const advertised = yield* attempt({
        dependencies: { bounds: { binaryBytes: 64 } },
        routes: { [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { body: CANDIDATE, advertised: 1_000_000 } },
      });
      expect(advertised.failure).toContain("could not completely download");

      const interrupted = yield* attempt({
        routes: { [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { body: CANDIDATE, interruptAfter: 3 } },
      });
      expect(interrupted.failure).toContain("could not completely download");

      const empty = yield* attempt({
        routes: { [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { status: 500 } },
      });
      expect(empty.failure).toContain("could not completely download");

      for (const outcome of [short, oversized, advertised, interrupted, empty]) {
        expect(outcome.installed).toBe(ORIGINAL);
        expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
      }
    });

    it("UH17: a failed replacement leaves the original byte-identical", function* () {
      const outcome = yield* attempt({
        dependencies: {
          // deno-lint-ignore require-yield
          *commit() {
            throw new Error("the destination is on another device");
          },
        },
      });

      expect(outcome.failure).toContain("could not prepare or atomically replace");
      expect(outcome.installed).toBe(ORIGINAL);
      expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
    });

    it("UH18: an invoked symbolic link is refused rather than followed", function* () {
      yield* useInstallation(function* (dir, exe) {
        const link = join(dir, "xmd-link");
        yield* until(symlink(exe, link));

        const requested: string[] = [];
        const assembly = compiledUpgradeAssembly(
          { executablePath: link, currentVersion: INSTALLED, ...PLATFORM },
          { transport: scripted(healthyRoutes({}), requested) },
        );
        const outcome = yield* upgradeWith(assembly);

        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? "" : outcome.error.message).toContain(
          "This xmd binary is a symbolic link.",
        );
        // Refused before the network, and without resolving: the link is still a
        // link and the file it points at is untouched.
        expect(requested).toEqual([]);
        expect((yield* until(lstat(link))).isSymbolicLink()).toBe(true);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
      });
    });

    it("UH19: a destination that is not a regular file is refused", function* () {
      yield* useInstallation(function* (dir) {
        const directory = join(dir, "not-a-binary");
        yield* until(mkdir(directory));

        const requested: string[] = [];
        const outcome = yield* upgradeWith(
          compiledUpgradeAssembly(
            { executablePath: directory, currentVersion: INSTALLED, ...PLATFORM },
            { transport: scripted(healthyRoutes({}), requested) },
          ),
        );

        expect(outcome.ok ? "" : outcome.error.message).toContain(
          "does not support atomic replacement",
        );
        expect(requested).toEqual([]);
      });
    });

    it("UH20: an unwritable installation directory is refused before the network", function* () {
      yield* useInstallation(function* (dir, exe) {
        const nested = join(dir, "readonly");
        yield* until(mkdir(nested));
        const target = join(nested, "xmd");
        yield* until(writeFile(target, ORIGINAL, { mode: 0o755 }));
        yield* until(chmod(nested, 0o500));
        yield* ensure(() => until(chmod(nested, 0o700)));

        const requested: string[] = [];
        const outcome = yield* upgradeWith(
          compiledUpgradeAssembly(
            { executablePath: target, currentVersion: INSTALLED, ...PLATFORM },
            { transport: scripted(healthyRoutes({}), requested) },
          ),
        );

        expect(outcome.ok ? "" : outcome.error.message).toContain(
          "The directory containing this xmd binary is not writable.",
        );
        expect(outcome.ok ? "" : outcome.error.message).toContain("This command did not run sudo.");
        expect(requested).toEqual([]);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
      });
    });

    it("UH21: a second upgrade of the same installation waits for nobody", function* () {
      yield* useInstallation(function* (_dir, exe) {
        // The stable sidecar beside the exact executable. A real process in
        // another interpreter holds the kernel lock, which is the only thing an
        // acquisition here accepts as evidence that somebody else is installing.
        const lock = `${exe}.upgrade-lock`;

        const contended = yield* scoped(function* () {
          const child = yield* exec(process.execPath, {
            arguments: [
              "eval",
              [
                `const file = Deno.openSync(${JSON.stringify(lock)},`,
                "{ read: true, write: true, create: true });",
                "if (!file.tryLockSync(true)) { Deno.exit(2); }",
                'console.log("held");',
                // A timer rather than a promise nothing settles: Deno detects the
                // latter as a deadlock, exits, and releases the very lock this
                // case needs held while the second attempt runs.
                "await new Promise((resolve) => setTimeout(resolve, 60_000));",
              ].join(" "),
            ],
          });
          const output = yield* child.stdout;
          const first = yield* output.next();
          expect(first.done).toBe(false);
          expect(first.done ? "" : new TextDecoder().decode(first.value).trim()).toBe("held");

          const requested: string[] = [];
          return {
            outcome: yield* upgradeWith(
              compiledUpgradeAssembly(
                { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
                { transport: scripted(healthyRoutes({}), requested) },
              ),
            ),
            requested,
          };
        });

        expect(contended.outcome.ok ? "" : contended.outcome.error.message).toContain(
          "Another xmd upgrade is already running.",
        );
        // Refused, not queued, and refused before the release was read.
        expect(contended.requested).toEqual([]);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);

        // The holder is gone with its scope, and the kernel released what it held
        // — which is what lets the next attempt proceed over the same sidecar.
        const after = yield* run({}, _dir, exe);
        expect(after.installed).toBe(CANDIDATE);
      });
    });

    it("UH22: cancelling before the commit keeps the original and leaves no candidate", function* () {
      yield* useInstallation(function* (dir, exe) {
        const requested: string[] = [];
        const routes = healthyRoutes({});
        // The binary download suspends. Halting the scope while it is suspended
        // is a cancellation in the middle of the one act that writes a file.
        routes[`${DOWNLOAD}/${RELEASE}/${ASSET}`] = { hold: true };

        yield* scoped(function* () {
          const upgrading = yield* spawn(() =>
            upgradeWith(
              compiledUpgradeAssembly(
                { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
                { transport: scripted(routes, requested) },
              ),
            ),
          );
          // Wait until the download is the thing in flight.
          while (!requested.includes(`${DOWNLOAD}/${RELEASE}/${ASSET}`)) {
            yield* sleep(10);
          }
          yield* upgrading.halt();
        });

        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
        // The lock went back and the staging went with it.
        expect(yield* leftoversIn(dir, exe)).toEqual(["xmd.upgrade-lock"]);
      });
    });

    it("UH23: cancelling after the commit keeps the new binary", function* () {
      yield* useInstallation(function* (dir, exe) {
        const requested: string[] = [];
        let committed = false;

        yield* scoped(function* () {
          const upgrading = yield* spawn(() =>
            upgradeWith(
              compiledUpgradeAssembly(
                { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
                {
                  transport: scripted(healthyRoutes({}), requested),
                  *commit(staged, destination) {
                    // The real rename, and then a suspension standing where the
                    // final report would be. Whatever ends the command from here
                    // on, the candidate is the installed binary.
                    yield* until(rename(staged, destination));
                    committed = true;
                    yield* sleep(60_000);
                  },
                },
              ),
            ),
          );
          while (!committed) {
            yield* sleep(10);
          }
          yield* upgrading.halt();
        });

        expect(yield* until(readFile(exe, "utf8"))).toBe(CANDIDATE);
        expect((yield* until(lstat(exe))).mode & 0o111).toBeGreaterThan(0);
        // Cleanup removed the scratch it still owned and never the new binary.
        expect(yield* leftoversIn(dir, exe)).toEqual(["xmd.upgrade-lock"]);
      });
    });

    it("UH24: the request never carries a credential or a caller's header", function* () {
      // The seam records what production builds, so this reads the real request
      // rather than a description of one.
      const seen: UpgradeRequest[] = [];
      yield* useInstallation(function* (_dir, exe) {
        const routes = healthyRoutes({});
        const assembly = compiledUpgradeAssembly(
          { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
          {
            *transport(request) {
              seen.push(request);
              return yield* scripted(routes, [])(request);
            },
          },
        );
        yield* upgradeWith(assembly);
      });

      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen) {
        expect(Object.keys(request).sort()).toEqual(["accept", "url"]);
        expect(request.url.startsWith("https://")).toBe(true);
      }
      expect(seen.map((request) => request.accept)).toContain("application/vnd.github+json");
      expect(seen.map((request) => request.accept)).toContain("application/octet-stream");
    });

    it("UH25: only this invocation's own identities authorize a phase", function* () {
      // The whole authority boundary, exercised through the real components. An
      // opaque string is not a capability: what authorizes a phase is being in
      // this invocation's private map, in the state that phase accepts.
      yield* useInstallation(function* (_dir, exe) {
        const assembly = compiledUpgradeAssembly(
          { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
          { transport: scripted(healthyRoutes({}), []) },
        );
        const phases =
          assembly.authority === undefined
            ? []
            : yield* assembly.authority({
                requestedTag: null,
                status: true,
                allowDowngrade: false,
                allowPrerelease: false,
              });
        const phase = (name: string) => {
          const found = phases.find((component) => component.name === name);
          if (found === undefined) {
            throw new Error(`an eligible compiled host declared no ${name}`);
          }
          return found.factory(claimNothing);
        };

        const refusals: [string, Record<string, Json>][] = [
          // A release nothing admitted.
          ["Upgrade.Download", { release: randomUUID() }],
          // A candidate this invocation never staged — which is also what a
          // candidate from another invocation looks like from in here.
          ["Upgrade.Verify", { candidate: randomUUID() }],
          ["Upgrade.Replace", { candidate: randomUUID() }],
        ];

        for (const [name, props] of refusals) {
          let refused: unknown;
          try {
            yield* call(() => phase(name)(props, INVOCATION));
          } catch (error) {
            refused = error;
          }
          expect({ name, refused: String(refused) }).toEqual({
            name,
            refused: String(refused),
          });
          expect(String(refused)).toContain("was given");
          expect(String(refused)).toContain("xmd was not changed");
        }

        // Nothing above touched the installation.
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
      });
    });

    it("UH27: a redirect inside this repository is still bound to this exact download", function* () {
      // The host allowlist is not the whole of the binding. A redirect that
      // stays on github.com, stays in this repository and stays under the
      // release download path can still name another release or another
      // platform's binary — and the checksum set names one file, so bytes that
      // quietly became a different file are what verification cannot notice.
      const wrongRelease = `${DOWNLOAD}/v0.9.0/${ASSET}`;
      const wrongAsset = `${DOWNLOAD}/${RELEASE}/xmd-aarch64-apple-darwin`;

      for (const location of [wrongRelease, wrongAsset]) {
        const outcome = yield* attempt({
          routes: {
            [`${DOWNLOAD}/${RELEASE}/${ASSET}`]: { status: 302, location },
            [location]: { body: CANDIDATE },
          },
        });
        expect({ location, failure: outcome.failure?.includes("redirected outside") }).toEqual({
          location,
          failure: true,
        });
        expect({ location, installed: outcome.installed }).toEqual({
          location,
          installed: ORIGINAL,
        });
        // Refused before it was requested: the hop is judged, then fetched.
        expect(outcome.requested).not.toContain(location);
      }
    });

    it("UH28: a release page URL that names another tag is not a release fact", function* () {
      // The page URL is the one thing in a release fact a reader is invited to
      // go and check, so a payload naming one tag and linking another release's
      // page must not become a fact at all.
      const mismatched = {
        ...release(RELEASE),
        html_url: `https://github.com/${OWNER_REPO}/releases/tag/v9.9.9`,
      };
      const outcome = yield* attempt({ releases: [mismatched] });

      expect(outcome.failure).toContain("could not read or validate GitHub release information");
      expect(outcome.installed).toBe(ORIGINAL);

      // The same payload with its own tag's page is admitted, so the refusal
      // above is about the mismatch rather than about the shape.
      const matched = yield* attempt({ releases: [release(RELEASE)] });
      expect(matched.installed).toBe(CANDIDATE);
    });

    it("UH29: a host operation that throws becomes an answer, not a stack trace", function* () {
      // Every one of these raises out of a seam production really can hit: a
      // socket that refuses, a candidate that cannot be spawned, a lock that
      // cannot be opened. None may escape the components, because a raw error
      // ends the document before its own table can turn it into a sentence.
      const transportThrew = yield* attempt({
        dependencies: {
          // deno-lint-ignore require-yield
          *transport() {
            throw new Error("ECONNREFUSED");
          },
        },
      });
      expect(transportThrew.failure).toContain(
        "could not read or validate GitHub release information",
      );
      expect(transportThrew.installed).toBe(ORIGINAL);

      const downloadThrew = yield* attempt({
        routes: { [`${DOWNLOAD}/${RELEASE}/checksums.txt`]: { throws: true } },
      });
      expect(downloadThrew.failure).toContain("could not completely download");
      expect(downloadThrew.installed).toBe(ORIGINAL);

      let committed = 0;
      const probeThrew = yield* attempt({
        dependencies: {
          // deno-lint-ignore require-yield
          *probe() {
            throw new Error("EACCES");
          },
          // deno-lint-ignore require-yield
          *commit() {
            committed += 1;
          },
        },
      });
      expect(probeThrew.failure).toContain("did not report version");

      // A response whose own release raises is teardown, not an outcome: the
      // download still succeeds and the answer is unaffected.
      const teardownThrew = yield* attempt({
        dependencies: {
          *transport(request) {
            const response = yield* scripted(healthyRoutes({}), [])(request);
            return {
              ...response,
              // deno-lint-ignore require-yield
              *cancel() {
                throw new Error("EBADF");
              },
            };
          },
        },
      });
      expect(teardownThrew.failure).toBe(undefined);
      expect(teardownThrew.installed).toBe(CANDIDATE);
      expect({ committed, installed: probeThrew.installed }).toEqual({
        committed: 0,
        installed: ORIGINAL,
      });
    });

    it("UH30: a lock this host cannot open is refused, not raised", function* () {
      yield* useInstallation(function* (_dir, exe) {
        // A directory where the sidecar belongs: `openSync` raises rather than
        // answering, which is the shape of every lock failure that is not
        // contention.
        yield* until(mkdir(`${exe}.upgrade-lock`));

        const requested: string[] = [];
        const outcome = yield* upgradeWith(
          compiledUpgradeAssembly(
            { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
            { transport: scripted(healthyRoutes({}), requested) },
          ),
        );

        expect(outcome.ok ? "" : outcome.error.message).toContain(
          "does not support atomic replacement",
        );
        expect(requested).toEqual([]);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
      });
    });

    it("UH31: staging is owned only once its exclusive create has succeeded", function* () {
      yield* useInstallation(function* (dir, exe) {
        // A file already at the staging path belongs to somebody else. The
        // exclusive create is what would have made it ours, so a create that
        // failed must leave it exactly as it was — recording the path before
        // the create would have had teardown delete a stranger's file.
        const planted = join(dir, "already-here");
        const contents = "someone else's file\n";
        yield* until(writeFile(planted, contents));

        const requested: string[] = [];
        const outcome = yield* upgradeWith(
          compiledUpgradeAssembly(
            { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
            {
              transport: scripted(healthyRoutes({}), requested),
              stage: () => planted,
            },
          ),
        );

        expect(outcome.ok ? "" : outcome.error.message).toContain(
          "could not prepare or atomically replace",
        );
        expect(yield* until(readFile(planted, "utf8"))).toBe(contents);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
      });
    });

    it("UH32: a chunk is written completely, however many writes that takes", function* () {
      // `write` may store fewer bytes than it was given. A candidate missing
      // the remainder would fail its checksum — for a reason that says nothing
      // about the release — so the loop is what makes the digest and the file
      // describe the same bytes.
      const chunk = new TextEncoder().encode("abcdefghij");
      const stored: number[] = [];
      const received: number[] = [];
      const sink = {
        write(bytes: Uint8Array, offset: number, length: number) {
          received.push(length);
          // One byte at a time, the worst honest answer a write can give.
          stored.push(bytes[offset] ?? 0);
          return Promise.resolve({ bytesWritten: 1 });
        },
      };

      const written = yield* writeAll(sink, chunk);

      expect(written.ok).toBe(true);
      expect(new TextDecoder().decode(new Uint8Array(stored))).toBe("abcdefghij");
      // Each call asked for exactly what was left, so nothing was rewritten.
      expect(received).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it("UH33: a sink that stops accepting bytes fails rather than truncating", function* () {
      const refused = yield* writeAll(
        { write: () => Promise.resolve({ bytesWritten: 0 }) },
        new TextEncoder().encode("abc"),
      );
      expect(refused.ok).toBe(false);

      const threw = yield* writeAll(
        { write: () => Promise.reject(new Error("ENOSPC")) },
        new TextEncoder().encode("abc"),
      );
      expect(threw.ok).toBe(false);
    });

    it("UH34: a candidate write that fails reaches the approved refusal, not a throw", function* () {
      // The boundary the standalone `writeAll` cases cannot reach. A write that
      // fails part-way through a real download used to raise out of the
      // download body — past `withResponse`, past the calling phase — so the
      // document never rendered its answer and the person saw a host error.
      let closed = 0;
      let committed = 0;
      const outcome = yield* attempt({
        dependencies: {
          sink: (file) => ({
            // The first chunk lands; the next fails, the way a full disk does.
            write(chunk, offset, length) {
              return offset === 0 && length === chunk.byteLength
                ? Promise.reject(new Error("ENOSPC"))
                : file.write(chunk, offset, length);
            },
            sync: () => file.sync(),
            close: () => {
              closed += 1;
              return file.close();
            },
          }),
          // deno-lint-ignore require-yield
          *commit() {
            committed += 1;
          },
        },
      });

      expect(outcome.failure).toBe(
        [
          `The command could not prepare or atomically replace the installed binary with release ${RELEASE}.`,
          `Binary: ${outcome.executablePath}`,
          "The installed binary was not changed. Check available disk space, directory " +
            "permissions, and filesystem support, then run this command again.",
        ].join("\n"),
      );
      // Nothing was committed, the installed bytes are what they were, and the
      // staging this invocation created is gone — only the lock sidecar stays.
      expect({ committed, installed: outcome.installed }).toEqual({
        committed: 0,
        installed: ORIGINAL,
      });
      expect(outcome.leftovers).toEqual(["xmd.upgrade-lock"]);
      // And the descriptor was closed, rather than its path merely unlinked.
      expect(closed).toBeGreaterThan(0);
    });

    it("UH35: a probe name that belongs to somebody else is neither deleted nor replaced", function* () {
      // Both names the topology probe uses, one at a time. Cleanup must remove
      // only what this call exclusively created, and the rename must not
      // replace a destination somebody else holds.
      for (const collide of ["probe", "moved"] as const) {
        yield* useInstallation(function* (dir, exe) {
          const probe = join(dir, "collides");
          const planted = collide === "probe" ? probe : `${probe}.moved`;
          const contents = `someone else's ${collide}\n`;
          yield* until(writeFile(planted, contents));

          const requested: string[] = [];
          const outcome = yield* upgradeWith(
            compiledUpgradeAssembly(
              { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
              {
                transport: scripted(healthyRoutes({}), requested),
                probeStage: () => probe,
              },
            ),
          );

          // The topology question is answered "no" rather than by trampling it.
          expect({
            collide,
            refused: (outcome.ok ? "" : outcome.error.message).includes(
              "does not support atomic replacement",
            ),
          }).toEqual({ collide, refused: true });
          // The stranger's file is exactly as it was.
          expect({ collide, kept: yield* until(readFile(planted, "utf8")) }).toEqual({
            collide,
            kept: contents,
          });
          // Refused before the network, and the installation is untouched.
          expect({ collide, requested }).toEqual({ collide, requested: [] });
          expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
        });
      }
    });

    it("UH36: a healthy probe leaves neither name behind", function* () {
      // The positive control for UH35: both names the probe creates are removed
      // on the ordinary path, so the ownership rule above is not bought by
      // leaving this command's own files lying in somebody's bin directory.
      yield* useInstallation(function* (dir, exe) {
        const probe = join(dir, "probe-run");
        const outcome = yield* upgradeWith(
          compiledUpgradeAssembly(
            { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
            { transport: scripted(healthyRoutes({}), []), probeStage: () => probe },
          ),
        );

        expect(outcome.ok).toBe(true);
        // Both names this call created are gone; the sidecar is the only thing
        // the command leaves beside the binary.
        expect(yield* leftoversIn(dir, exe)).toEqual(["xmd.upgrade-lock"]);
      });
    });

    it("UH37: a cancelled download closes the candidate rather than only unlinking it", function* () {
      yield* useInstallation(function* (dir, exe) {
        const requested: string[] = [];
        const routes = healthyRoutes({});
        routes[`${DOWNLOAD}/${RELEASE}/${ASSET}`] = { hold: true };
        let closed = 0;

        yield* scoped(function* () {
          const upgrading = yield* spawn(() =>
            upgradeWith(
              compiledUpgradeAssembly(
                { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
                {
                  transport: scripted(routes, requested),
                  sink: (file) => ({
                    write: (chunk, offset, length) => file.write(chunk, offset, length),
                    sync: () => file.sync(),
                    close: () => {
                      closed += 1;
                      return file.close();
                    },
                  }),
                },
              ),
            ),
          );
          while (!requested.includes(`${DOWNLOAD}/${RELEASE}/${ASSET}`)) {
            yield* sleep(10);
          }
          yield* upgrading.halt();
        });

        // Cancelled with the file open: the descriptor went back, not just the
        // path. A teardown that only unlinked would leave this at zero.
        expect(closed).toBe(1);
        expect(yield* until(readFile(exe, "utf8"))).toBe(ORIGINAL);
        expect(yield* leftoversIn(dir, exe)).toEqual(["xmd.upgrade-lock"]);
      });
    });

    it("UH39: a phase cannot be skipped, repeated or run out of order", function* () {
      // Driven through the real components rather than the document, because
      // the document never asks in the wrong order. What is under test is that
      // the state machine refuses anyway, rather than trusting the caller.
      yield* useInstallation(function* (_dir, exe) {
        let committed = 0;
        const assembly = compiledUpgradeAssembly(
          { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
          {
            transport: scripted(healthyRoutes({}), []),
            // deno-lint-ignore require-yield
            *commit() {
              committed += 1;
            },
          },
        );
        const phases =
          assembly.authority === undefined
            ? []
            : yield* assembly.authority({
                requestedTag: null,
                status: false,
                allowDowngrade: false,
                allowPrerelease: false,
              });
        const phase = (name: string) => {
          const found = phases.find((component) => component.name === name);
          if (found === undefined) {
            throw new Error(`an eligible compiled host declared no ${name}`);
          }
          return found.factory(claimNothing);
        };
        const refusalOf = function* (name: string, props: Record<string, Json>) {
          try {
            yield* call(() => phase(name)(props, INVOCATION));
          } catch (error) {
            return String(error);
          }
          return "";
        };

        const listed = yield* call(() =>
          phase("Upgrade.Releases")({ requestedTag: null }, INVOCATION),
        );
        const release = firstReleaseIdentity(listed);
        const staged = yield* call(() => phase("Upgrade.Download")({ release }, INVOCATION));
        const candidate = candidateIdentity(staged);

        // Replace before Verify: the candidate exists and is this invocation's,
        // and is still refused because it has not been verified.
        expect(yield* refusalOf("Upgrade.Replace", { candidate })).toContain(
          "rather than verified",
        );
        // One installation attempt per invocation, however it is spelled.
        expect(yield* refusalOf("Upgrade.Download", { release })).toContain(
          "a second installation attempt",
        );

        yield* call(() => phase("Upgrade.Verify")({ candidate }, INVOCATION));
        // Verified once; asking again replays a phase that already ran.
        expect(yield* refusalOf("Upgrade.Verify", { candidate })).toContain(
          "rather than downloaded",
        );

        expect({ committed, installed: yield* until(readFile(exe, "utf8")) }).toEqual({
          committed: 0,
          installed: ORIGINAL,
        });
      });
    });

    it("UH38: the command's own exit status follows the outcome", function* () {
      // The one place the command line, the packaged policy and the process
      // status meet. Everything above reads `runUpgrade`'s Result; this reads
      // what a caller's shell would see, which is a separate mapping and the
      // only part of it no case has exercised.
      yield* useInstallation(function* (_dir, exe) {
        const assembly = compiledUpgradeAssembly(
          { executablePath: exe, currentVersion: INSTALLED, ...PLATFORM },
          { transport: scripted(healthyRoutes({}), []) },
        );

        // A completed comparison succeeds, whichever way it came out.
        expect(yield* commandStatus(["upgrade", "--status"], assembly)).toEqual({
          status: 0,
          stderr: "",
        });
        expect(yield* commandStatus(["upgrade", RELEASE, "--status"], assembly)).toEqual({
          status: 0,
          stderr: "",
        });

        // A refusal the policy decided reports on stderr and fails.
        const refused = yield* commandStatus(
          ["upgrade", RELEASE, "--status", "--allow-downgrade"],
          assembly,
        );
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("--status does not install a release");
      });
    });
  },
);

/** What one in-process `xmd` invocation settled on. */
interface CommandStatus {
  status: number;
  stderr: string;
}

/**
 * Drive `runXmd` in this process and read back the status it earned.
 *
 * The report itself goes to the real stdout, because what this is about is the
 * status: the text is asserted through `runUpgrade` everywhere above, and
 * replacing this process's stdout to read it again would prove nothing further.
 */
function* commandStatus(args: string[], assembly: UpgradeAssembly): Operation<CommandStatus> {
  let status = 0;
  let stderr = "";
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
    yield* useHostFiles();
    yield* runXmd(args, function* () {}, assembly);
    return { status, stderr: stderr.trim() };
  });
}
