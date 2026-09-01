/**
 * Tier UG — the packaged upgrade command document, executed as itself.
 *
 * This runs the exact Markdown the CLI ships, read through the packaged loader,
 * with deterministic components standing where an eligible compiled host
 * declares its own two. The schemas those fakes declare are the production
 * ones, imported rather than restated, so a policy that keeps passing here is
 * passing against the contract a release actually has.
 *
 * The seams record what they were asked and answer; they do nothing. That is
 * what makes each case evidence about the document's control flow rather than
 * about a host: a branch that must not install is proven by an install that was
 * never called, not by output that happens not to mention one.
 *
 * Every host capability is refused for the length of a run. The document
 * decides which release to install and says so; reading a file, running a
 * command, reaching the network and starting a service are the compiled host's
 * business and are not reachable from this program at all.
 *
 * The include list is empty on purpose. Repository component search must not be
 * able to supply `If`, `Return`, `Fail` or either upgrade component.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { useNormalizedOutput, useTempFileCompiler } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";
import { API } from "@executablemd/runtime";

import {
  UPGRADE_CANDIDATE_PROPS,
  UPGRADE_DOWNLOAD_PROPS,
  UPGRADE_DOWNLOAD_RETURNS,
  UPGRADE_ORIGIN,
  UPGRADE_RELEASES_PROPS,
  UPGRADE_RELEASES_RETURNS,
  UPGRADE_REPLACE_RETURNS,
  UPGRADE_VERIFY_RETURNS,
} from "../src/compiled-upgrade.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { readPackagedDocument, UPGRADE_COMMAND_DOCUMENT } from "../src/packaged-document.ts";
import { runUpgrade } from "../src/upgrade.ts";
import type { UpgradeAssembly, UpgradeProvenance } from "../src/upgrade.ts";

/** A release as `Upgrade.Releases` would hand it over. */
interface Fact {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** The releases most cases choose among, newest first as GitHub lists them. */
const RELEASES: Fact[] = [
  { tag: "v0.13.0", draft: true },
  { tag: "v0.12.0-rc.1", prerelease: true },
  { tag: "v0.11.0" },
  { tag: "v0.10.2" },
  { tag: "v0.9.0" },
];

const INSTALLED = "0.10.2";
const EXECUTABLE = "/opt/xmd/bin/xmd";
const TARGET = "aarch64-apple-darwin";

interface Scenario {
  tag?: string | null;
  status?: boolean;
  allowDowngrade?: boolean;
  allowPrerelease?: boolean;
  currentVersion?: string;
  provenance?: UpgradeProvenance;
  target?: string | null;
  releases?: Fact[];
  /** The code `<Upgrade.Releases>` answers with instead of a listing. */
  releaseFailure?: string;
  /** The code the named phase answers with instead of succeeding. */
  downloadFailure?: string;
  verifyFailure?: string;
  replaceFailure?: string;
}

/** What one run of the document asked its host for, and what it settled on. */
interface Run {
  /** One entry per `<Upgrade.Releases>` invocation, with the tag it passed. */
  releaseReads: (string | null)[];
  /** One entry per `<Upgrade.Download>` invocation, with the release it named. */
  downloads: string[];
  /** One entry per `<Upgrade.Verify>` invocation, with the candidate it named. */
  verifies: string[];
  /** One entry per `<Upgrade.Replace>` invocation, with the candidate it named. */
  replacements: string[];
  /** How many eval blocks this run asked the host to compile. */
  compiles: number;
  /** The transcript, exactly as a piped caller would receive it. */
  output: string;
  failure?: string;
}

function facts(releases: Fact[]): Json[] {
  return releases.map((release, index) => ({
    tag: release.tag,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    url: `https://github.com/taras/executable.md/releases/tag/${release.tag}`,
    identity: `admitted-${index}`,
    assets: [`xmd-${TARGET}`, "checksums.txt"],
  }));
}

/**
 * The four phases an eligible compiled host declares, as deterministic seams
 * that record and answer.
 */
function seams(scenario: Scenario, run: Run): readonly IdentityComponent[] {
  return [
    {
      name: "Upgrade.Releases",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_RELEASES_PROPS,
      returns: UPGRADE_RELEASES_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* upgradeReleases(props: Record<string, Json>) {
          run.releaseReads.push(typeof props.requestedTag === "string" ? props.requestedTag : null);
          if (scenario.releaseFailure !== undefined) {
            return { ok: false, error: { code: scenario.releaseFailure }, value: null };
          }
          return {
            ok: true,
            error: null,
            value: { releases: facts(scenario.releases ?? RELEASES) },
          };
        },
    },
    {
      name: "Upgrade.Download",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_DOWNLOAD_PROPS,
      returns: UPGRADE_DOWNLOAD_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* upgradeDownload(props: Record<string, Json>) {
          const identity = String(props.release);
          run.downloads.push(identity);
          if (scenario.downloadFailure !== undefined) {
            return { ok: false, error: { code: scenario.downloadFailure }, value: null };
          }
          return {
            ok: true,
            error: null,
            value: { asset: `xmd-${TARGET}`, candidate: `candidate-of-${identity}` },
          };
        },
    },
    {
      name: "Upgrade.Verify",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_CANDIDATE_PROPS,
      returns: UPGRADE_VERIFY_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* upgradeVerify(props: Record<string, Json>) {
          const identity = String(props.candidate);
          run.verifies.push(identity);
          if (scenario.verifyFailure !== undefined) {
            return { ok: false, error: { code: scenario.verifyFailure }, value: null };
          }
          return { ok: true, error: null, value: { candidate: identity, version: "0.11.0" } };
        },
    },
    {
      name: "Upgrade.Replace",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_CANDIDATE_PROPS,
      returns: UPGRADE_REPLACE_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* upgradeReplace(props: Record<string, Json>) {
          const identity = String(props.candidate);
          run.replacements.push(identity);
          if (scenario.replaceFailure !== undefined) {
            return { ok: false, error: { code: scenario.replaceFailure }, value: null };
          }
          const chosen = (scenario.releases ?? RELEASES).find(
            (_release, index) => `candidate-of-admitted-${index}` === identity,
          );
          return {
            ok: true,
            error: null,
            value: {
              previousVersion: scenario.currentVersion ?? INSTALLED,
              installedVersion: (chosen?.tag ?? "v0.0.0").slice(1),
              executablePath: EXECUTABLE,
              releaseUrl: `https://github.com/taras/executable.md/releases/tag/${chosen?.tag}`,
            },
          };
        },
    },
  ];
}

/**
 * Refuse every host capability for the length of one run.
 *
 * A tripwire rather than an absence: the document is supposed to reach none of
 * these, and a case that only checked what it produced could not tell "never
 * asked" from "asked and was answered".
 */
function* refuseHostCapabilities(): Operation<void> {
  const refuse = (capability: string) => {
    throw new Error(`the upgrade command document reached for ${capability}`);
  };
  yield* API.Files.around({
    // deno-lint-ignore require-yield
    *checkFilePath() {
      return refuse("a file");
    },
    // deno-lint-ignore require-yield
    *readTextFile() {
      return refuse("a file");
    },
    // deno-lint-ignore require-yield
    *writeTextFile() {
      return refuse("a file");
    },
    // deno-lint-ignore require-yield
    *deleteFile() {
      return refuse("a file");
    },
    // deno-lint-ignore require-yield
    *globFiles() {
      return refuse("a file");
    },
    // deno-lint-ignore require-yield
    *temporaryDirectory() {
      return refuse("a directory");
    },
  });
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec() {
      return refuse("a command");
    },
  });
  yield* API.Fetch.around({
    // deno-lint-ignore require-yield
    *fetch() {
      return refuse("the network");
    },
  });
  yield* API.Service.around({
    // deno-lint-ignore require-yield
    *start() {
      return refuse("a service");
    },
  });
}

function* upgrade(scenario: Scenario): Operation<Run> {
  const run: Run = {
    releaseReads: [],
    downloads: [],
    verifies: [],
    replacements: [],
    compiles: 0,
    output: "",
  };
  const provenance = scenario.provenance ?? "compiled";
  const target = scenario.target === undefined ? TARGET : scenario.target;
  const assembly: UpgradeAssembly = {
    provenance,
    currentVersion: scenario.currentVersion ?? INSTALLED,
    executablePath: EXECUTABLE,
    platform: "darwin",
    architecture: "arm64",
    ...(target === null ? {} : { target }),
    // Only an eligible compiled host states one, which is what an unsupported
    // provenance case is about: there is nothing for the document to reach.
    ...(provenance === "compiled" && target !== null
      ? { authority: () => seamsOperation(scenario, run) }
      : {}),
  };

  const chunks: string[] = [];
  yield* scoped(function* () {
    yield* refuseHostCapabilities();
    // A refusal this document reaches before any eval block compiles nothing at
    // all. That matters where the entrypoint is the one being refused: the npm
    // package's `xmd upgrade` must answer without asking its eval compiler to
    // resolve anything, and a count is the only thing that says it did not.
    yield* API.Env.around({
      *compile([source, options], next) {
        run.compiles += 1;
        return yield* next(source, options);
      },
    });
    const result = yield* runUpgrade({
      command: {
        requestedTag: scenario.tag ?? null,
        status: scenario.status === true,
        allowDowngrade: scenario.allowDowngrade === true,
        allowPrerelease: scenario.allowPrerelease === true,
      },
      assembly,
      stream: new InMemoryStream(),
      // deno-lint-ignore require-yield
      *consume(chunk) {
        chunks.push(chunk);
      },
    });
    run.output = chunks.join("");
    if (!result.ok) {
      run.failure = result.error.message;
    }
  });

  return run;
}

// deno-lint-ignore require-yield
function* seamsOperation(scenario: Scenario, run: Run): Operation<readonly IdentityComponent[]> {
  return seams(scenario, run);
}

/** The ordering the document reported for one exact tag, through `--status`. */
function* orderingOf(tag: string, currentVersion: string): Operation<string> {
  const run = yield* upgrade({
    tag,
    status: true,
    currentVersion,
    releases: [{ tag }],
  });
  const matched = /^Selected release: .* \((newer|older|current)\)$/m.exec(run.output);
  return matched?.[1] ?? `refused: ${run.failure ?? run.output}`;
}

/** The transcript with blank runs collapsed, so a case reads as a reader does. */
function transcript(run: Run): string[] {
  return run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

describe("Tier UG — the packaged upgrade command document", () => {
  beforeAll(() => useTempFileCompiler());

  it("UG1: an authorized install renders its milestones in source order", function* () {
    const run = yield* upgrade({});

    // The draft above it and the prerelease above that are both skipped, and
    // the choice was made from the facts rather than by the host.
    expect(run.releaseReads).toEqual([null]);
    expect(run.downloads).toEqual(["admitted-2"]);
    // Each phase received only what the previous one handed back.
    expect(run.verifies).toEqual(["candidate-of-admitted-2"]);
    expect(run.replacements).toEqual(["candidate-of-admitted-2"]);
    expect(run.compiles).toBeGreaterThan(0);
    expect(run.failure).toBe(undefined);

    // The approved transcript, in order: an opening, the selection, then one
    // milestone per completed phase. This is the whole terminal experience —
    // there is no separate summary.
    expect(transcript(run)).toEqual([
      "# Upgrade XMD",
      "Installs the latest published stable version of XMD. Verifies the release before",
      "replacing the standalone binary that ran this command.",
      "## Select a release",
      "Checks that the installed XMD binary can be replaced atomically and takes its",
      "installation lock without waiting. Reads release information from",
      "`taras/executable.md`. Ignores drafts and releases with invalid tags.",
      "## Install selected release",
      "The selected release passed the comparison and consent checks.",
      "Selected release: v0.11.0 (newer than installed version 0.10.2)",
      "Downloads the checksum file and target binary from the selected GitHub release.",
      "Stages the binary beside the installed one without making it executable.",
      `Downloaded binary: xmd-${TARGET}`,
      "Verifies the binary against its published SHA-256 checksum. Makes it executable",
      "only after the checksum passes, then checks that it reports the selected",
      "version.",
      "Verified: SHA-256 checksum and version 0.11.0",
      "Atomically replaces the installed binary with the verified binary. Until",
      "replacement succeeds, the installed binary remains unchanged.",
      "Installed xmd 0.11.0 (replaced 0.10.2).",
      `Binary: ${EXECUTABLE}`,
      "Release notes: https://github.com/taras/executable.md/releases/tag/v0.11.0",
    ]);
  });

  it("UG2: an exact tag names itself in the opening", function* () {
    const run = yield* upgrade({ tag: "v0.11.0" });

    expect(transcript(run).slice(0, 3)).toEqual([
      "# Upgrade XMD",
      "Installs XMD release v0.11.0. Verifies the release before replacing",
      "the standalone binary that ran this command.",
    ]);
  });

  it("UG3: --status reports the comparison and reaches no install phase", function* () {
    const run = yield* upgrade({ status: true });

    expect({
      downloads: run.downloads,
      verifies: run.verifies,
      replacements: run.replacements,
    }).toEqual({ downloads: [], verifies: [], replacements: [] });
    expect(transcript(run)).toEqual([
      "# Upgrade XMD",
      "Compares the installed XMD version with the selected release without downloading",
      "a binary or changing the installation.",
      "## Select a release",
      "Reads release information from `taras/executable.md`. Ignores drafts and",
      "releases with invalid tags.",
      "## Release status",
      "The installed and selected versions were compared using semantic version",
      "precedence.",
      "Installed version: 0.10.2",
      "Selected release: v0.11.0 (newer)",
      "Release notes: https://github.com/taras/executable.md/releases/tag/v0.11.0",
      "No files were changed.",
    ]);
    // Status says nothing about locking, because status takes no lock.
    expect(run.output).not.toContain("installation lock");
  });

  it("UG4: an already-installed selection downloads nothing and says so", function* () {
    const run = yield* upgrade({ tag: "v0.10.2" });

    expect(run.downloads).toEqual([]);
    expect(run.failure).toBe(undefined);
    expect(transcript(run).slice(-7)).toEqual([
      "## Installing existing version",
      "The selected release was compared with the installed version. They are the same,",
      "so no download or replacement was needed.",
      "xmd 0.10.2 is already installed.",
      `Binary: ${EXECUTABLE}`,
      "Release notes: https://github.com/taras/executable.md/releases/tag/v0.10.2",
      "No download or replacement was needed.",
    ]);
  });

  it("UG5: an untaken branch contributes no prose at all", function* () {
    // The defect this catches is reference documentation leaking: every branch
    // description now lives inside the branch that uses it.
    const install = yield* upgrade({});
    for (const absent of [
      "## Release status",
      "## Installing existing version",
      "Compares the installed XMD version",
      "No files were changed.",
    ]) {
      expect({ absent, present: install.output.includes(absent) }).toEqual({
        absent,
        present: false,
      });
    }

    const status = yield* upgrade({ status: true });
    for (const absent of [
      "## Install selected release",
      "## Installing existing version",
      "Downloads the checksum file",
      "Atomically replaces the installed binary",
      "Installs the latest published stable version",
    ]) {
      expect({ absent, present: status.output.includes(absent) }).toEqual({
        absent,
        present: false,
      });
    }
  });

  it("UG6: a phase failure keeps completed milestones and claims nothing more", function* () {
    const download = yield* upgrade({ downloadFailure: "download-failed" });
    expect(download.verifies).toEqual([]);
    expect(download.output).toContain(
      "Selected release: v0.11.0 (newer than installed version 0.10.2)",
    );
    expect(download.output).toContain("Downloads the checksum file");
    expect(download.output).not.toContain("Downloaded binary:");
    expect(download.output).not.toContain("Verified:");
    expect(download.failure).toContain("could not completely download");

    const verify = yield* upgrade({ verifyFailure: "checksum-mismatch" });
    expect(verify.replacements).toEqual([]);
    expect(verify.output).toContain(`Downloaded binary: xmd-${TARGET}`);
    expect(verify.output).toContain("Verifies the binary against its published SHA-256 checksum.");
    expect(verify.output).not.toContain("Verified: SHA-256");
    expect(verify.failure).toContain("does not match its published SHA-256 checksum");

    const replace = yield* upgrade({ replaceFailure: "replacement-failed" });
    expect(replace.output).toContain("Verified: SHA-256 checksum and version 0.11.0");
    expect(replace.output).toContain("Atomically replaces the installed binary");
    expect(replace.output).not.toContain("Installed xmd 0.11.0 (replaced");
    expect(replace.failure).toContain("could not prepare or atomically replace");
  });

  it("UG7: an older release needs --allow-downgrade, and installs with it", function* () {
    const refused = yield* upgrade({ tag: "v0.9.0" });
    expect(refused.downloads).toEqual([]);
    expect(refused.failure).toBe(
      [
        "v0.9.0 is older than installed version 0.10.2.",
        "To install it, run:",
        "xmd upgrade v0.9.0 --allow-downgrade",
        "No binary was downloaded, and the installation was not changed.",
      ].join("\n"),
    );
    // Refused before authorization, so no installation milestone rendered.
    expect(refused.output).not.toContain("Selected release: v0.9.0");

    const consented = yield* upgrade({ tag: "v0.9.0", allowDowngrade: true });
    expect(consented.downloads).toEqual(["admitted-4"]);
    expect(consented.output).toContain("Installed xmd 0.9.0 (replaced 0.10.2).");
  });

  it("UG8: a prerelease needs --allow-prerelease, and installs with it", function* () {
    const refused = yield* upgrade({ tag: "v0.12.0-rc.1" });
    expect(refused.downloads).toEqual([]);
    expect(refused.failure).toBe(
      [
        "v0.12.0-rc.1 is a prerelease.",
        "To install it, run:",
        "xmd upgrade v0.12.0-rc.1 --allow-prerelease",
        "No binary was downloaded, and the installation was not changed.",
      ].join("\n"),
    );

    const consented = yield* upgrade({ tag: "v0.12.0-rc.1", allowPrerelease: true });
    expect(consented.downloads).toEqual(["admitted-1"]);
    expect(consented.output).toContain("Installed xmd 0.12.0-rc.1 (replaced 0.10.2).");
  });

  it("UG9: an older prerelease is refused with one command carrying both consents", function* () {
    const releases: Fact[] = [{ tag: "v0.9.0-rc.1", prerelease: true }];
    const both = "xmd upgrade v0.9.0-rc.1 --allow-prerelease --allow-downgrade";

    const neither = yield* upgrade({ tag: "v0.9.0-rc.1", releases });
    expect(neither.failure).toContain(both);

    const downgradeOnly = yield* upgrade({
      tag: "v0.9.0-rc.1",
      releases,
      allowDowngrade: true,
    });
    expect(downgradeOnly.failure).toContain(both);

    const prereleaseOnly = yield* upgrade({
      tag: "v0.9.0-rc.1",
      releases,
      allowPrerelease: true,
    });
    expect(prereleaseOnly.failure).toContain(
      "xmd upgrade v0.9.0-rc.1 --allow-downgrade --allow-prerelease",
    );

    const consented = yield* upgrade({
      tag: "v0.9.0-rc.1",
      releases,
      allowDowngrade: true,
      allowPrerelease: true,
    });
    expect(consented.downloads).toEqual(["admitted-0"]);

    // A stable older release names only the downgrade consent: a command
    // carrying an option that would itself be refused is not a repair.
    const stableOlder = yield* upgrade({ tag: "v0.9.0" });
    expect(stableOlder.failure).toContain("xmd upgrade v0.9.0 --allow-downgrade\n");
    expect(stableOlder.failure).not.toContain("--allow-prerelease");

    expect([neither.downloads, downgradeOnly.downloads, prereleaseOnly.downloads]).toEqual([
      [],
      [],
      [],
    ]);
  });

  it("UG10: consent that describes nothing is refused rather than ignored", function* () {
    const noTag = yield* upgrade({ allowPrerelease: true });
    expect(noTag.releaseReads).toEqual([]);
    expect(noTag.failure).toContain("--allow-prerelease requires a valid prerelease tag.");

    const stableTag = yield* upgrade({ tag: "v0.11.0", allowPrerelease: true });
    expect(stableTag.releaseReads).toEqual([]);

    // Irrelevant only after the comparison, because only the comparison knows.
    const notOlder = yield* upgrade({ tag: "v0.11.0", allowDowngrade: true });
    expect(notOlder.releaseReads).toEqual(["v0.11.0"]);
    expect(notOlder.downloads).toEqual([]);
    expect(notOlder.failure).toContain(
      "--allow-downgrade applies only to an older release. v0.11.0 is newer compared with " +
        "installed version 0.10.2.",
    );
  });

  it("UG11: --status refuses either consent option, before reading anything", function* () {
    for (const consent of [{ allowDowngrade: true }, { allowPrerelease: true }]) {
      const run = yield* upgrade({ status: true, tag: "v0.9.0", ...consent });
      expect(run.releaseReads).toEqual([]);
      expect(run.failure).toContain(
        "--status does not install a release, so it cannot be used with --allow-downgrade or " +
          "--allow-prerelease.",
      );
    }
  });

  it("UG12: --status accepts an older or prerelease tag without consent", function* () {
    const older = yield* upgrade({ tag: "v0.9.0", status: true });
    expect(older.downloads).toEqual([]);
    expect(older.output).toContain("Selected release: v0.9.0 (older)");

    const prerelease = yield* upgrade({ tag: "v0.12.0-rc.1", status: true });
    expect(prerelease.downloads).toEqual([]);
    expect(prerelease.output).toContain("Selected release: v0.12.0-rc.1 (newer)");
  });

  it("UG13: an already-installed prerelease needs no prerelease consent", function* () {
    const scenario: Scenario = {
      tag: "v0.12.0-rc.1",
      currentVersion: "0.12.0-rc.1",
      releases: [{ tag: "v0.12.0-rc.1", prerelease: true }],
    };

    const bare = yield* upgrade(scenario);
    expect(bare.downloads).toEqual([]);
    expect(bare.output).toContain("xmd 0.12.0-rc.1 is already installed.");

    const consented = yield* upgrade({ ...scenario, allowPrerelease: true });
    expect(consented.downloads).toEqual([]);
    expect(consented.output).toContain("xmd 0.12.0-rc.1 is already installed.");
  });

  it("UG14: a draft, a missing tag and an empty listing are each refused by name", function* () {
    const draft = yield* upgrade({ tag: "v0.13.0" });
    expect(draft.downloads).toEqual([]);
    expect(draft.failure).toContain("GitHub has no published xmd release tagged v0.13.0");

    const missing = yield* upgrade({ tag: "v9.9.9" });
    expect(missing.failure).toContain("GitHub has no published xmd release tagged v9.9.9");

    const prereleasesOnly = yield* upgrade({
      releases: [
        { tag: "v0.12.0-rc.1", prerelease: true },
        { tag: "v0.13.0", draft: true },
      ],
    });
    expect(prereleasesOnly.downloads).toEqual([]);
    expect(prereleasesOnly.failure).toContain("GitHub has no published stable xmd release");
  });

  it("UG15: an unsupported entrypoint refuses before it could read anything", function* () {
    const expected: [UpgradeProvenance, string][] = [
      [
        "compiled-windows",
        "The Windows xmd binary cannot replace itself while it is running. Run the standalone " +
          "installer again or download xmd-x86_64-pc-windows-msvc.exe from the Releases page. " +
          "No release was read, and the binary was not changed.",
      ],
      [
        "npm-node",
        "npm manages this xmd installation. Run npm install -g @executablemd/cli@latest, or " +
          "replace latest with an exact package version. No release was read, and the binary was " +
          "not changed.",
      ],
      [
        "bun-source",
        "Bun manages this xmd installation. Run bun add -g @executablemd/cli@latest, or replace " +
          "latest with an exact package version. No release was read, and the binary was not " +
          "changed.",
      ],
      [
        "deno-source",
        "This xmd is running through Deno or a repository checkout. Update the " +
          "jsr:@executablemd/cli version, or update the checkout and run deno task setup. " +
          "No release was read, and no binary was changed.",
      ],
    ];

    for (const [provenance, message] of expected) {
      const run = yield* upgrade({ provenance });
      expect({
        provenance,
        reads: run.releaseReads,
        downloads: run.downloads,
        compiles: run.compiles,
      }).toEqual({ provenance, reads: [], downloads: [], compiles: 0 });
      expect({ provenance, failure: run.failure }).toEqual({ provenance, failure: message });
      // The heading is all a refused host renders: it claims no status and no
      // installation, because neither began.
      expect(transcript(run)).toEqual(["# Upgrade XMD"]);
    }
  });

  it("UG16: a compiled binary the release does not target refuses too", function* () {
    const run = yield* upgrade({ target: null });

    expect(run.releaseReads).toEqual([]);
    expect(run.compiles).toBe(0);
    expect(run.failure).toContain(
      "No xmd release is published for darwin/arm64. Build xmd from a checkout for this platform,",
    );
  });

  it("UG17: every release-read failure code reaches its own answer", function* () {
    const expected: [string, string][] = [
      ["busy", "Another xmd upgrade is already running."],
      ["symbolic-link", "This xmd binary is a symbolic link."],
      ["unwritable-parent", "The directory containing this xmd binary is not writable."],
      [
        "unsupported-filesystem",
        "The filesystem containing this xmd binary does not support atomic replacement.",
      ],
      ["metadata-invalid", "The command could not read or validate GitHub release information."],
      ["metadata-incomplete", "The command could not read or validate GitHub release information."],
      ["unexpected", "The command could not read or validate GitHub release information."],
    ];

    for (const [code, message] of expected) {
      const run = yield* upgrade({ releaseFailure: code });
      expect({ code, downloads: run.downloads }).toEqual({ code, downloads: [] });
      expect(run.failure).toContain(message);
      // The opening and the selection prose are already on screen; nothing
      // claims an installation began.
      expect(run.output).toContain("## Select a release");
      expect(run.output).not.toContain("Selected release:");
    }

    for (const code of ["busy", "symbolic-link", "unwritable-parent", "unsupported-filesystem"]) {
      const run = yield* upgrade({ releaseFailure: code });
      expect({ code, named: run.failure?.includes(`\nBinary: ${EXECUTABLE}\n`) }).toEqual({
        code,
        named: true,
      });
    }
  });

  it("UG18: every installation failure code reaches its own answer", function* () {
    const download: [string, string][] = [
      ["asset-missing", `Release v0.11.0 does not include a binary for ${TARGET}.`],
      [
        "checksums-missing",
        "Release v0.11.0 does not include checksums.txt, so its binary cannot be verified.",
      ],
      [
        "download-failed",
        "The command could not completely download the v0.11.0 binary or checksums.txt.",
      ],
      [
        "redirect-refused",
        "A download for release v0.11.0 redirected outside GitHub\u2019s release download service.",
      ],
      ["unexpected", "xmd 0.11.0 was not installed. The installed binary was not changed."],
    ];
    for (const [code, message] of download) {
      const run = yield* upgrade({ downloadFailure: code });
      expect({ code, downloads: run.downloads }).toEqual({ code, downloads: ["admitted-2"] });
      expect(run.failure).toContain(message);
    }

    const verify: [string, string][] = [
      [
        "checksum-entry-missing",
        `checksums.txt for release v0.11.0 does not include the ${TARGET} binary, so it cannot ` +
          "be verified.",
      ],
      [
        "checksum-entry-duplicate",
        `checksums.txt for release v0.11.0 includes the ${TARGET} binary more than once, so it ` +
          "cannot be verified reliably.",
      ],
      [
        "checksum-mismatch",
        "The downloaded v0.11.0 binary does not match its published SHA-256 checksum. The " +
          "installed binary was not changed, and the downloaded binary was not run.",
      ],
      [
        "candidate-version-mismatch",
        "The checksum-verified v0.11.0 binary did not report version 0.11.0.",
      ],
    ];
    for (const [code, message] of verify) {
      const run = yield* upgrade({ verifyFailure: code });
      expect({ code, verifies: run.verifies.length }).toEqual({ code, verifies: 1 });
      expect(run.failure).toContain(message);
    }

    const replaced = yield* upgrade({ replaceFailure: "replacement-failed" });
    expect(replaced.failure).toContain(
      "The command could not prepare or atomically replace the installed binary with release " +
        "v0.11.0.",
    );
    // The failure that also covers staging and permissions must not claim the
    // candidate reached verification.
    expect(replaced.failure).not.toContain("verified");

    // `replacement-failed` reaches all three phases, because staging a
    // candidate and preparing one are the same kind of filesystem work as the
    // rename. Each phase answers it with the same words, so a person who
    // could not write to the directory reads the same advice wherever the
    // attempt stopped.
    const wherever =
      "The command could not prepare or atomically replace the installed binary " +
      "with release v0.11.0.";
    const staging = yield* upgrade({ downloadFailure: "replacement-failed" });
    expect(staging.failure).toContain(wherever);
    expect(staging.verifies).toEqual([]);

    const preparation = yield* upgrade({ verifyFailure: "replacement-failed" });
    expect(preparation.failure).toContain(wherever);
    expect(preparation.replacements).toEqual([]);
  });

  it("UG19: semantic version precedence is exact, past the safe-integer range", function* () {
    const ordered: [string, string, string][] = [
      ["v1.10.0", "1.9.0", "newer"],
      ["v1.9.0", "1.10.0", "older"],
      ["v2.0.0", "2.0.0", "current"],
      ["v1.0.0-rc.1", "1.0.0", "older"],
      ["v1.0.0", "1.0.0-rc.1", "newer"],
      ["v1.0.0-2", "1.0.0-10", "older"],
      ["v1.0.0-alpha", "1.0.0-beta", "older"],
      ["v1.0.0-alpha", "1.0.0-1", "newer"],
      ["v1.0.0-alpha.1", "1.0.0-alpha", "newer"],
      ["v1.0.0-alpha", "1.0.0-alpha.1", "older"],
      ["v1.0.0-9007199254740994", "1.0.0-9007199254740992", "newer"],
      // Where `semver` collapses two distinct identifiers through `Number`.
      // Both directions, because a tie-break that answered one and not the
      // other would not be antisymmetric.
      ["v1.0.0-9007199254740993", "1.0.0-9007199254740992", "newer"],
      ["v1.0.0-9007199254740992", "1.0.0-9007199254740993", "older"],
      ["v1.0.0-18446744073709551617", "1.0.0-18446744073709551616", "newer"],
      ["v1.0.0-18446744073709551616", "1.0.0-18446744073709551617", "older"],
      ["v1.0.0-9007199254740993", "1.0.0-9007199254740993", "current"],
    ];

    for (const [tag, current, expected] of ordered) {
      expect({ tag, current, ordering: yield* orderingOf(tag, current) }).toEqual({
        tag,
        current,
        ordering: expected,
      });
    }
  });

  it("UG20: a tag that is not exactly vX.Y.Z is refused before anything is read", function* () {
    const malformed = [
      "0.11.0",
      "V0.11.0",
      "v1.0",
      "v1.0.0+build.5",
      "v01.0.0",
      "v1.0.0-",
      "v1.0.0-01",
      "v1.0.0 ",
      " v1.0.0",
      "v1.0.0.0",
      "latest",
      "",
    ];

    for (const tag of malformed) {
      const run = yield* upgrade({ tag });
      expect({ tag, reads: run.releaseReads, downloads: run.downloads }).toEqual({
        tag,
        reads: [],
        downloads: [],
      });
      expect(run.failure).toContain("is not a valid release tag format");
      // Refused before either opening: no claim that status or installation
      // began.
      expect(transcript(run)).toEqual(["# Upgrade XMD"]);
    }
  });

  it("UG21: a running binary that reports no release version is refused", function* () {
    const run = yield* upgrade({ currentVersion: "0.10.2-dirty+local" });

    expect(run.releaseReads).toEqual([]);
    expect(run.failure).toContain(
      "The installed binary reports version 0.10.2-dirty+local, which is not a valid release version.",
    );
  });

  it("UG22: a published release whose own tag is malformed is never selected", function* () {
    const implicit = yield* upgrade({ releases: [{ tag: "release-2" }, { tag: "v0.11.0" }] });
    expect(implicit.downloads).toEqual(["admitted-1"]);

    const exact = yield* upgrade({ tag: "v0.11.0", releases: [{ tag: "release-2" }] });
    expect(exact.downloads).toEqual([]);
    expect(exact.failure).toContain("GitHub has no published xmd release tagged v0.11.0");
  });

  it("UG23: the packaged source is an ordinary streaming text root", function* () {
    // No root return schema, no `<Output>` region and no `<Return>`: the
    // document's rendered body *is* the command's output, rather than a hidden
    // program that synthesizes one string at the end.
    const source = yield* readPackagedDocument(UPGRADE_COMMAND_DOCUMENT);

    for (const absent of ["<Return", "<Output", "\nreturns:"]) {
      expect({ absent, present: source.includes(absent) }).toEqual({ absent, present: false });
    }
    // The four phases the private profile declares, and nothing else.
    expect([...source.matchAll(/<Upgrade\.[A-Za-z]+/g)].map((match) => match[0]).sort()).toEqual([
      "<Upgrade.Download",
      "<Upgrade.Releases",
      "<Upgrade.Replace",
      "<Upgrade.Verify",
    ]);
  });

  it("UG24: every exact multi-way choice is a <Switch>, not a lookup table", function* () {
    // The document decides six things by comparing one value against a fixed
    // set of alternatives. Each is written as a `<Switch>` so the alternatives
    // are visible as a set. Two of them used to be TypeScript objects keyed by
    // an error code, which put the policy where a reader of the Markdown could
    // not see it and where an unlisted key answered silently.
    const source = yield* readPackagedDocument(UPGRADE_COMMAND_DOCUMENT);

    for (const classifier of ["releaseReadFailures", "installationFailure"]) {
      expect({ classifier, present: source.includes(classifier) }).toEqual({
        classifier,
        present: false,
      });
    }

    for (const selector of [
      "<Switch value={props.installation.provenance}>",
      "<Switch value={mode}>",
      "<Switch value={releaseRead.error.code}>",
      "<Switch value={outcome}>",
      "<Switch value={downloadResult.error.code}>",
      "<Switch value={verifyResult.error.code}>",
      "<Switch value={replacementResult.error.code}>",
    ]) {
      expect({ selector, present: source.includes(selector) }).toEqual({ selector, present: true });
    }
  });

  it("UG25: each phase answers for the codes it can produce, and no others", function* () {
    // The compiled host decides which code each phase can return, and the
    // document answers each one by name. Listing a code under the wrong phase
    // would be dead policy; omitting a reachable one would send a person the
    // generic fallback for a failure the command knows the words for. Reading
    // the matchers out of the source is what makes this a claim about the
    // policy rather than about the four scenarios a behavioral case tries.
    const source = yield* readPackagedDocument(UPGRADE_COMMAND_DOCUMENT);

    /** The `value` matchers of the cases directly beneath one switch. */
    function matchers(selector: string): string[] {
      const start = source.indexOf(selector);
      const end = source.indexOf("\n</Switch>", start);
      expect({ selector, found: start >= 0 && end > start }).toEqual({ selector, found: true });
      const block = source.slice(start, end);
      return [...block.matchAll(/<Case value="([^"]+)">/g)].map((match) => match[1]).sort();
    }

    /** Whether the block ends with the general refusal every code falls back to. */
    function hasDefault(selector: string): boolean {
      const start = source.indexOf(selector);
      return source.slice(start, source.indexOf("\n</Switch>", start)).includes("<Case default>");
    }

    expect(matchers("<Switch value={releaseRead.error.code}>")).toEqual([
      "busy",
      "symbolic-link",
      "unsupported-filesystem",
      "unwritable-parent",
    ]);
    expect(matchers("<Switch value={downloadResult.error.code}>")).toEqual([
      "asset-missing",
      "checksums-missing",
      "download-failed",
      "redirect-refused",
      "replacement-failed",
    ]);
    expect(matchers("<Switch value={verifyResult.error.code}>")).toEqual([
      "candidate-version-mismatch",
      "checksum-entry-duplicate",
      "checksum-entry-missing",
      "checksum-mismatch",
      "replacement-failed",
    ]);
    expect(matchers("<Switch value={replacementResult.error.code}>")).toEqual([
      "replacement-failed",
    ]);

    // A code no phase list names still gets an answer rather than an empty
    // branch, which is the whole reason a `<Switch>` may replace a lookup that
    // ended in `??`.
    for (const selector of [
      "<Switch value={releaseRead.error.code}>",
      "<Switch value={downloadResult.error.code}>",
      "<Switch value={verifyResult.error.code}>",
      "<Switch value={replacementResult.error.code}>",
    ]) {
      expect({ selector, fallback: hasDefault(selector) }).toEqual({ selector, fallback: true });
    }

    // Every provenance the props schema admits is decided by name, and the one
    // eligible provenance is written as an empty case rather than left to fall
    // off the end — so adding a provenance to the schema without deciding what
    // it may do shows up here.
    expect(matchers("<Switch value={props.installation.provenance}>")).toEqual([
      "bun-source",
      "compiled",
      "compiled-windows",
      "deno-source",
      "npm-node",
    ]);
    expect(hasDefault("<Switch value={props.installation.provenance}>")).toBe(false);
  });
});
