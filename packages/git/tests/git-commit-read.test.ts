/**
 * Tier GCR — `<Git.Commit ref>` reads an existing commit, against real
 * repositories.
 *
 * The read form returns one commit's stored facts — full id, message, author,
 * committer, tree and ordered parents — selected by ordinary yq and paged by
 * the standard selected-value page. `verify={true}` adds the receipt of the
 * checkout's own configured `git verify-commit`. Every case runs real `git`
 * against a repository this suite built commit by commit, with SSH signing keys
 * and an allowed-signers file of its own: what the read has to get right is
 * which commit it described, what Git's configured verifier said about it, and
 * that it changed nothing while asking.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Json } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { ensureDir, exists } from "@effectionx/fs";
import { collect, execute, inlineSource, inspectComponent } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { GitQuery, Repository } from "@executablemd/git/api";
import type { GitCommitPage, RepositorySelection } from "@executablemd/git/api";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { selectedRepository } from "../src/composition/context.ts";
import { GitObservationError, GitObservationProviderError } from "../src/composition/errors.ts";
import { denoCommitVerifier } from "../src/deno/run-composition/verification.ts";
import type { CommitVerifier } from "../src/deno/run-composition/verification.ts";
import { capturingProbe } from "./support/observations.ts";
import { raised, runOrdinaryDocument, useManagedRoot } from "./support/run-composition.ts";

/** Whether this host can sign and verify the SSH fixture commits at all. */
const SSH_KEYGEN = spawnSync("ssh-keygen", ["-?"]).error === undefined;

/** A whole case that needs `ssh-keygen`, skipped with its reason where it is absent. */
const withSshKeygen = SSH_KEYGEN ? it : it.skip;
const SKIP_REASON = SSH_KEYGEN ? "" : " (skipped: ssh-keygen is not installed on this host)";

const ASTRAL = "\u{1D11E}";

/** 10 000 code points, with an astral character as the 4096th. */
const LONG_MESSAGE = `${"a".repeat(4095)}${ASTRAL}${"b".repeat(5903)}\n`;

const A_MESSAGE = "Implement the change\n\nBody line one.\n  indented, with trailing spaces  \n";

interface CommitFixture {
  readonly root: string;
  readonly home: string;
  /** Run Git in the checkout under the fixture's own isolated configuration. */
  run(args: readonly string[], extra?: Record<string, string>): string;
  readonly r: string;
  readonly a: string;
  readonly x: string;
  readonly m: string;
  /** A commit on top of M whose message is LONG_MESSAGE. */
  readonly long: string;
  /** An SSH-signed commit on top of M, by the fixture key. */
  readonly signed: string | undefined;
}

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "1767225600 +0000",
    GIT_COMMITTER_DATE: "1767225600 +0000",
    ...extra,
  };
}

function gitIn(
  root: string,
  home: string,
  args: readonly string[],
  extra: Record<string, string> = {},
): string {
  const output = spawnSync("git", [...args], {
    cwd: root,
    env: environment(home, extra),
    encoding: "utf8",
  });
  if (output.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${output.status}: ${output.stderr}`);
  }
  return output.stdout.trim();
}

/**
 * Root R, then A with a multi-line message, a distinct author and committer and
 * two non-zero offsets, then a merge M of A and a side commit X; HEAD is M.
 * Two more commits sit on top of M without moving HEAD: one with a long
 * message, and one SSH-signed by a fixture key the checkout's own
 * configuration trusts.
 */
function* useCommitFixture(): Operation<CommitFixture> {
  const home = yield* until(realpath(yield* useTempDirectory("xmd-commit-read-home-")));
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-commit-read-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  const run = (args: readonly string[], extra: Record<string, string> = {}) =>
    gitIn(root, home, args, extra);
  run(["init", "--initial-branch=main", "."]);
  yield* until(writeFile(join(root, "a.txt"), "one\n"));
  run(["add", "a.txt"]);
  run(["commit", "-m", "root"]);
  const r = run(["rev-parse", "HEAD"]);

  run(["switch", "-c", "side"]);
  yield* until(writeFile(join(root, "side.txt"), "side\n"));
  run(["add", "side.txt"]);
  run(["commit", "-m", "side"]);
  const x = run(["rev-parse", "HEAD"]);

  run(["switch", "main"]);
  yield* until(writeFile(join(root, "a.txt"), "two\n"));
  run(["add", "a.txt"]);
  const messageFile = join(home, "a-message");
  yield* until(writeFile(messageFile, A_MESSAGE));
  run(["commit", "--cleanup=verbatim", "-F", messageFile], {
    GIT_AUTHOR_NAME: "Ada Author",
    GIT_AUTHOR_EMAIL: "ada@example.invalid",
    GIT_AUTHOR_DATE: "1700000000 +0530",
    GIT_COMMITTER_NAME: "Cee Committer",
    GIT_COMMITTER_EMAIL: "cee@example.invalid",
    GIT_COMMITTER_DATE: "1700003600 -0500",
  });
  const a = run(["rev-parse", "HEAD"]);
  run(["merge", "--no-ff", "-m", "merge side", "side"]);
  const m = run(["rev-parse", "HEAD"]);
  const tree = run(["rev-parse", "HEAD^{tree}"]);

  const longFile = join(home, "long-message");
  yield* until(writeFile(longFile, LONG_MESSAGE));
  const long = run(["commit-tree", "-p", m, "-F", longFile, tree]);

  let signed: string | undefined;
  if (SSH_KEYGEN) {
    const key = join(home, "signing-key");
    const generated = spawnSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "fixture",
      "-f",
      key,
    ]);
    if (generated.status !== 0) {
      throw new Error(`ssh-keygen could not generate the fixture key: ${generated.stderr}`);
    }
    signed = run([
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${key}`,
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "commit-tree",
      "-S",
      "-p",
      m,
      "-m",
      "signed",
      tree,
    ]);
    const publicKey = (yield* until(readFile(`${key}.pub`, "utf8"))).trim();
    yield* until(
      writeFile(
        join(root, ".git", "allowed-signers"),
        `fixture@example.invalid namespaces="git" ${publicKey}\n`,
      ),
    );
    run(["config", "gpg.format", "ssh"]);
    run(["config", "gpg.ssh.program", "ssh-keygen"]);
    // Relative, so the verifier has to read it against the checkout root.
    run(["config", "gpg.ssh.allowedSignersFile", ".git/allowed-signers"]);
  }
  return { root, home, run, r, a, x, m, long, signed };
}

/** A verifier that counts how often it was started and then runs the real one. */
function countingVerifier(count: { starts: number }): CommitVerifier {
  const real = denoCommitVerifier();
  return function* (request) {
    count.starts += 1;
    return yield* real(request);
  };
}

/** What `git verify-commit` says directly, in the same checkout and environment. */
function directVerification(root: string, commit: string) {
  const output = spawnSync("git", ["verify-commit", commit], {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
  });
  return { exitCode: output.status, stdout: output.stdout, stderr: output.stderr };
}

/** The one page a document bound and projected, as an object. */
function pageOf(value: Json | undefined): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected one bound page, received ${JSON.stringify(value)}`);
  }
  return value;
}

function objectOf(value: Json | undefined): Record<string, Json> {
  return pageOf(value);
}

function reasonOf(value: unknown): string {
  return value instanceof GitObservationError ? value.reason : String(value);
}

/** Read one commit with these attributes and answer with the bound page. */
function* readPage(
  fixture: CommitFixture,
  attributes: string,
  options: { readonly verifier?: CommitVerifier; readonly cwd?: string } = {},
): Operation<Record<string, Json>> {
  const root = yield* useManagedRoot();
  const seen: Json[] = [];
  yield* runOrdinaryDocument(
    [`<Git.Commit ${attributes} as="read" />`, "", "<Captured value={read} />", ""].join("\n"),
    {
      root,
      cwd: options.cwd ?? fixture.root,
      components: [capturingProbe(seen)],
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    },
  );
  return pageOf(seen[0]);
}

/** What a read with these attributes refused with. */
function* refused(fixture: CommitFixture, source: string): Operation<unknown> {
  const root = yield* useManagedRoot();
  return yield* raised(runOrdinaryDocument(`${source}\n`, { root, cwd: fixture.root }));
}

/** Follow `next` from this page to the end through the installed provider. */
function* follow(
  fixture: CommitFixture,
  ref: string,
  first: Record<string, Json>,
): Operation<string> {
  const root = yield* useManagedRoot();
  let text = String(first.value);
  let next = first.next;
  yield* runOrdinaryDocument("<Follows />\n", {
    root,
    cwd: fixture.root,
    components: [
      {
        name: "Follows",
        origin: "test://follows",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn(): Operation<string> {
          const repository = yield* selectedRepository();
          if (repository === undefined) {
            throw new Error("the probe is written outside every repository");
          }
          while (typeof next === "string") {
            const page: GitCommitPage = yield* GitQuery.operations.commit({
              repository,
              workingDirectory: yield* cwd(),
              request: { kind: "commit", ref, verify: false, yq: next, maxBytes: null },
            });
            text += String(page.value);
            next = page.next;
          }
          return "";
        },
      },
    ],
  });
  return text;
}

describe("GCR1 — an older commit's stored metadata (A1)", () => {
  it("reads the requested commit, not HEAD, with exact text, dates and ordered parents", function* () {
    const fixture = yield* useCommitFixture();

    const a = objectOf((yield* readPage(fixture, `ref="${fixture.a}"`)).value);
    expect(a).toEqual({
      sha: fixture.a,
      author: {
        name: "Ada Author",
        email: "ada@example.invalid",
        date: "2023-11-15T03:43:20+05:30",
      },
      committer: {
        name: "Cee Committer",
        email: "cee@example.invalid",
        date: "2023-11-14T18:13:20-05:00",
      },
      message: A_MESSAGE,
      tree: { sha: fixture.run(["rev-parse", `${fixture.a}^{tree}`]) },
      parents: [{ sha: fixture.r }],
      git_verify_commit_result: null,
    });

    const r = objectOf((yield* readPage(fixture, `ref="${fixture.r}"`)).value);
    expect(r.sha).toBe(fixture.r);
    expect(r.parents).toEqual([]);

    // HEAD is the merge, and its parents keep the order Git stored.
    const m = yield* readPage(fixture, `ref="HEAD" yq='pick(["sha", "parents"])'`);
    expect(m).toEqual({
      value: { sha: fixture.m, parents: [{ sha: fixture.a }, { sha: fixture.x }] },
      next: null,
      prev: null,
      last: null,
    });
  });
});

describe("GCR2 — configured verification (A2)", () => {
  withSshKeygen(
    `distinguishes accepted, unsigned, rejected and unavailable${SKIP_REASON}`,
    function* () {
      const fixture = yield* useCommitFixture();
      const signed = fixture.signed ?? "";
      const count = { starts: 0 };
      const verifier = countingVerifier(count);
      const verification = (page: Record<string, Json>) => objectOf(page.value);
      const receipt = (commit: string) => directVerification(fixture.root, commit);

      // Requested nothing: no record and no verifier, whichever way it was said.
      expect(
        (yield* readPage(fixture, `ref="${signed}" yq=".git_verify_commit_result"`, { verifier }))
          .value,
      ).toBe(null);
      expect(
        (yield* readPage(fixture, `ref="${signed}" verify={false} yq=".git_verify_commit_result"`, {
          verifier,
        })).value,
      ).toBe(null);
      expect(count.starts).toBe(0);

      const accepted = verification(
        yield* readPage(fixture, `ref="${signed}" verify={true} yq=".git_verify_commit_result"`, {
          verifier,
        }),
      );
      expect(accepted).toEqual({
        signed: true,
        verifier_unavailable: false,
        ...receiptOf(receipt(signed)),
      });
      expect(accepted.exitCode).toBe(0);

      const unsigned = verification(
        yield* readPage(
          fixture,
          `ref="${fixture.a}" verify={true} yq=".git_verify_commit_result"`,
          {
            verifier,
          },
        ),
      );
      expect(unsigned).toEqual({
        signed: false,
        verifier_unavailable: false,
        ...receiptOf(receipt(fixture.a)),
      });
      expect(unsigned.exitCode).not.toBe(0);

      // The signing principal is no longer in the allowed signers — only another
      // key is — so Git rejects the signature.
      const other = join(fixture.home, "other-key");
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "other", "-f", other]);
      const otherKey = (yield* until(readFile(`${other}.pub`, "utf8"))).trim();
      yield* until(
        writeFile(
          join(fixture.root, ".git", "other-signers"),
          `someone@example.invalid namespaces="git" ${otherKey}\n`,
        ),
      );
      fixture.run(["config", "gpg.ssh.allowedSignersFile", ".git/other-signers"]);
      const rejected = verification(
        yield* readPage(fixture, `ref="${signed}" verify={true} yq=".git_verify_commit_result"`, {
          verifier,
        }),
      );
      expect(rejected).toEqual({
        signed: true,
        verifier_unavailable: false,
        ...receiptOf(receipt(signed)),
      });
      expect(rejected.exitCode).not.toBe(0);

      // A configured program that is not there, named relative to the checkout.
      fixture.run(["config", "gpg.ssh.allowedSignersFile", ".git/allowed-signers"]);
      fixture.run(["config", "gpg.ssh.program", "./missing-ssh-keygen"]);
      const unavailable = verification(
        yield* readPage(fixture, `ref="${signed}" verify={true} yq=".git_verify_commit_result"`, {
          verifier,
        }),
      );
      expect(unavailable).toEqual({
        signed: true,
        verifier_unavailable: true,
        ...receiptOf(receipt(signed)),
      });
      expect(unavailable.exitCode).not.toBe(0);
      expect(count.starts).toBe(4);
    },
  );
});

/**
 * A commit carrying an OpenPGP signature header, written directly into the
 * object store.
 *
 * Its signature is not valid, and does not need to be: what these cases ask is
 * which configured program Git runs for it, and whether that program exists.
 */
function* craftOpenPgpCommit(fixture: CommitFixture): Operation<string> {
  const tree = fixture.run(["rev-parse", `${fixture.r}^{tree}`]);
  const object = join(fixture.home, "openpgp-commit");
  yield* until(
    writeFile(
      object,
      [
        `tree ${tree}`,
        "author Fixture <fixture@example.invalid> 1700000000 +0000",
        "committer Fixture <fixture@example.invalid> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " iQEzBAABCAAdFiEE",
        " -----END PGP SIGNATURE-----",
        "",
        "openpgp signed",
        "",
      ].join("\n"),
    ),
  );
  return fixture.run(["hash-object", "-t", "commit", "-w", object]);
}

describe("GCR8 — the OpenPGP program Git actually runs decides availability (A2)", () => {
  it("follows Git's last-read value across gpg.program, gpg.openpgp.program and includes", function* () {
    const fixture = yield* useCommitFixture();
    const signed = yield* craftOpenPgpCommit(fixture);
    const present = join(fixture.home, "present-verifier");
    yield* until(writeFile(present, "#!/bin/sh\nexit 1\n", { mode: 0o755 }));
    const config = join(fixture.root, ".git", "config");
    const original = yield* until(readFile(config, "utf8"));
    const presentSection = `[gpg "openpgp"]\n\tprogram = ${present}\n`;
    const missingSection = "[gpg]\n\tprogram = ./missing-verifier\n";
    const included = join(fixture.root, ".git", "alias.config");
    yield* until(writeFile(included, missingSection));
    const including = "[include]\n\tpath = alias.config\n";

    const layouts: { name: string; text: string; unavailable: boolean }[] = [
      {
        name: "openpgp then gpg.program",
        text: presentSection + missingSection,
        unavailable: true,
      },
      {
        name: "gpg.program then openpgp",
        text: missingSection + presentSection,
        unavailable: false,
      },
      { name: "openpgp then include", text: presentSection + including, unavailable: true },
      { name: "include then openpgp", text: including + presentSection, unavailable: false },
    ];
    for (const layout of layouts) {
      yield* until(writeFile(config, original + layout.text));
      const direct = directVerification(fixture.root, signed);
      // Git's own diagnostic names the program it tried to start, so the native
      // command is the oracle for which alias won.
      expect(`${layout.name}: ${direct.stderr.includes("missing-verifier")}`).toBe(
        `${layout.name}: ${layout.unavailable}`,
      );
      const page = yield* readPage(
        fixture,
        `ref="${signed}" verify={true} yq=".git_verify_commit_result"`,
      );
      expect({ layout: layout.name, ...objectOf(page.value) }).toEqual({
        layout: layout.name,
        signed: true,
        verifier_unavailable: layout.unavailable,
        ...receiptOf(direct),
      });
      expect(direct.exitCode).not.toBe(0);
    }
  });
});

function receiptOf(direct: ReturnType<typeof directVerification>): Record<string, Json> {
  return { exitCode: direct.exitCode, stdout: direct.stdout, stderr: direct.stderr };
}

describe("GCR3 — yq selects from the whole commit before anything is paged (A3)", () => {
  it("selects objects, scalars and answers, pages a long message, and refuses what is not one value", function* () {
    const fixture = yield* useCommitFixture();

    const facts = yield* readPage(
      fixture,
      `ref="${fixture.a}" yq='pick(["sha", "tree", "parents"])'`,
    );
    expect(Object.keys(objectOf(facts.value)).sort()).toEqual(["parents", "sha", "tree"]);
    expect((yield* readPage(fixture, `ref="${fixture.a}" yq=".author.date"`)).value).toBe(
      "2023-11-15T03:43:20+05:30",
    );
    for (const [expression, answer] of [
      [".missing", null],
      ["false", false],
      ["[]", []],
    ] as const) {
      expect((yield* readPage(fixture, `ref="${fixture.a}" yq="${expression}"`)).value).toEqual(
        answer,
      );
    }

    // The selected string is what pages, by code points, and following it
    // reassembles the stored message exactly.
    const first = yield* readPage(fixture, `ref="${fixture.long}" yq=".message"`);
    expect([...String(first.value)]).toHaveLength(4096);
    expect(String(first.value).endsWith(ASTRAL)).toBe(true);
    expect(first.prev).toBe(null);
    expect(typeof first.next).toBe("string");
    expect(typeof first.last).toBe("string");
    expect(yield* follow(fixture, fixture.long, first)).toBe(LONG_MESSAGE);

    // The whole object is one value: nothing inside it is paged.
    const whole = yield* readPage(fixture, `ref="${fixture.long}" yq="."`);
    expect(objectOf(whole.value).message).toBe(LONG_MESSAGE);
    expect([whole.next, whole.prev, whole.last]).toEqual([null, null, null]);

    for (const source of [
      `<Git.Commit ref="${fixture.a}" yq="empty" as="x" />`,
      `<Git.Commit ref="${fixture.m}" yq=".parents[]" as="x" />`,
      `<Git.Commit ref="${fixture.a}" yq='pick(["sha", "tree", "parents"])' maxBytes={10} as="x" />`,
    ]) {
      expect(`${source}: ${reasonOf(yield* refused(fixture, source))}`).toBe(
        `${source}: invalid-query`,
      );
    }
  });
});

describe("GCR4 — a symbolic ref is observed fresh (A4)", () => {
  it("reads the moved branch anew, refuses its old window, and still pages the old commit", function* () {
    const fixture = yield* useCommitFixture();
    const tree = fixture.run(["rev-parse", `${fixture.m}^{tree}`]);
    const otherFile = join(fixture.home, "other-message");
    yield* until(writeFile(otherFile, `${"z".repeat(5000)}\n`));
    const b = fixture.run(["commit-tree", "-p", fixture.m, "-F", otherFile, tree]);
    fixture.run(["branch", "b", fixture.long]);

    const before = yield* readPage(fixture, `ref="b" yq=".message"`);
    const window = before.next;
    if (typeof window !== "string") {
      throw new Error("the first page of a long message names a next page");
    }
    fixture.run(["branch", "-f", "b", b]);

    // (a) A new read of the branch sees where it is now.
    expect((yield* readPage(fixture, `ref="b" yq=".sha"`)).value).toBe(b);

    // (b) The earlier window, followed through the moved branch, is refused.
    const root = yield* useManagedRoot();
    const stale = yield* raised(
      runOrdinaryDocument("<Stale />\n", {
        root,
        cwd: fixture.root,
        components: [windowProbe("Stale", "b", window)],
      }),
    );
    expect(reasonOf(stale)).toBe("stale-continuation");

    // (c) The same window through the commit's own id still pages it.
    const seen: Json[] = [];
    yield* runOrdinaryDocument("<Kept />\n", {
      root,
      cwd: fixture.root,
      components: [windowProbe("Kept", fixture.long, window, seen)],
    });
    expect(seen[0]).toBe([...LONG_MESSAGE].slice(4096, 8192).join(""));
  });
});

/** A component that asks for one window of one ref, and records what it bound. */
function windowProbe(name: string, ref: string, window: string, seen: Json[] = []) {
  return {
    name,
    origin: `test://${name.toLowerCase()}`,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<string> {
      const repository = yield* selectedRepository();
      if (repository === undefined) {
        throw new Error("the probe is written outside every repository");
      }
      const page = yield* GitQuery.operations.commit({
        repository,
        workingDirectory: yield* cwd(),
        request: { kind: "commit" as const, ref, verify: false, yq: window, maxBytes: null },
      });
      seen.push(page.value);
      return "";
    },
  };
}

describe("GCR5 — wrong forms and targets refuse; creation is unchanged (A5)", () => {
  it("refuses an invalid ref, a tree, a blob and every mixed form before any effect", function* () {
    const fixture = yield* useCommitFixture();
    const tree = fixture.run(["rev-parse", `${fixture.a}^{tree}`]);
    const blob = fixture.run(["rev-parse", `${fixture.a}:a.txt`]);
    const head = fixture.run(["rev-parse", "HEAD"]);

    const targets: { source: string; sentence: string }[] = [
      { source: `<Git.Commit ref="no-such-ref" as="x" />`, sentence: "names no object" },
      { source: `<Git.Commit ref="${tree}" as="x" />`, sentence: "names a tree rather than" },
      { source: `<Git.Commit ref="${blob}" as="x" />`, sentence: "names a blob rather than" },
    ];
    for (const target of targets) {
      const refusal = yield* refused(fixture, target.source);
      expect(`${target.source}: ${reasonOf(refusal)}`).toBe(`${target.source}: invalid-revision`);
      expect(refusal instanceof Error ? refusal.message : "").toContain(target.sentence);
    }

    const forms: { source: string; reason: string }[] = [
      {
        source: `<Git.Commit ref="${fixture.a}" message="also create" as="x" />`,
        reason: "invalid-invocation",
      },
      {
        source: `<Git.Commit ref="${fixture.a}" as="x">content</Git.Commit>`,
        reason: "unexpected-content",
      },
      {
        source: [
          `<Git.Commit ref="${fixture.a}" as="x">`,
          `<File path="written-by-child.txt">child</File>`,
          "</Git.Commit>",
        ].join("\n"),
        reason: "unexpected-content",
      },
      {
        source: `<Git.Commit verify={true} message="create" as="x" />`,
        reason: "invalid-invocation",
      },
    ];
    for (const form of forms) {
      expect(`${form.source}: ${reasonOf(yield* refused(fixture, form.source))}`).toBe(
        `${form.source}: ${form.reason}`,
      );
    }
    expect(yield* exists(join(fixture.root, "written-by-child.txt"))).toBe(false);
    expect(fixture.run(["rev-parse", "HEAD"])).toBe(head);
  });
});

/** The bytes of one file, as a digest a comparison can state. */
function* digestOf(path: string): Operation<string> {
  return createHash("sha256")
    .update(yield* until(readFile(path)))
    .digest("hex");
}

const SUPPLIED_SELECTION: RepositorySelection = Object.freeze({
  selection: "supplied",
  name: "supplied",
  identity: Object.freeze({
    name: "supplied",
    locatorFingerprint: "1".repeat(64),
    requestedBase: null,
    creationCommit: "0".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  checkoutPath: "/nowhere",
});

describe("GCR6 — the selected checkout answers, and nothing changes (A6)", () => {
  it("selects each sibling checkout's own commit", function* () {
    const fixture = yield* useCommitFixture();
    const linked = join(fixture.root, "..", "linked");
    fixture.run(["worktree", "add", "-b", "linked", linked, fixture.r]);
    yield* until(writeFile(join(linked, "linked.txt"), "linked\n"));
    gitIn(linked, fixture.home, ["add", "linked.txt"]);
    gitIn(linked, fixture.home, ["commit", "-m", "linked only"]);
    const linkedHead = gitIn(linked, fixture.home, ["rev-parse", "HEAD"]);

    expect((yield* readPage(fixture, `ref="HEAD" yq=".sha"`, { cwd: linked })).value).toBe(
      linkedHead,
    );
    expect((yield* readPage(fixture, `ref="HEAD" yq=".sha"`)).value).toBe(fixture.m);
  });

  withSshKeygen(
    `leaves refs, index, files and configuration byte-identical and runs no hook${SKIP_REASON}`,
    function* () {
      const fixture = yield* useCommitFixture();
      const hooks = join(fixture.root, ".git", "marker-hooks");
      yield* ensureDir(hooks);
      const marker = join(fixture.home, "hook-ran");
      for (const hook of [
        "reference-transaction",
        "post-index-change",
        "post-checkout",
        "pre-auto-gc",
      ]) {
        const path = join(hooks, hook);
        yield* until(writeFile(path, `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 }));
      }
      fixture.run(["config", "core.hooksPath", hooks]);
      const state = function* () {
        return {
          head: fixture.run(["rev-parse", "HEAD"]),
          refs: fixture.run(["for-each-ref"]),
          index: yield* digestOf(join(fixture.root, ".git", "index")),
          file: yield* digestOf(join(fixture.root, "a.txt")),
          config: yield* digestOf(join(fixture.root, ".git", "config")),
        };
      };
      const before = yield* state();

      const page = yield* readPage(fixture, `ref="${fixture.signed ?? ""}" verify={true}`);
      expect(objectOf(objectOf(page.value).git_verify_commit_result).exitCode).toBe(0);

      expect(yield* state()).toEqual(before);
      expect(yield* exists(marker)).toBe(false);
    },
  );

  it("refuses with the absent-provider error on a host that installs no reads", function* () {
    const failure = yield* raised(
      scoped(function* () {
        yield* useCompositionComponents();
        yield* Repository.around(
          {
            // deno-lint-ignore require-yield
            *ambient(): Operation<RepositorySelection | undefined> {
              return SUPPLIED_SELECTION;
            },
          },
          { at: "min" },
        );
        return yield* collect(
          yield* execute({
            ...inlineSource(`<Git.Commit ref="HEAD" as="x" />\n`),
            stream: new InMemoryStream(),
          }),
        );
      }),
    );
    expect(failure instanceof GitObservationProviderError).toBe(true);
  });
});

describe("GCR7 — the syntax reference describes both forms (A8)", () => {
  it("states both forms, the read props, both return shapes and both bindings", function* () {
    const info = yield* scoped(function* () {
      yield* useCompositionComponents();
      return yield* inspectComponent({ name: "Git.Commit", includes: [] });
    });
    if (info.kind !== "registered") {
      throw new Error(`Git.Commit described as ${info.kind}`);
    }
    expect([...info.forms]).toEqual(["self-closing", "paired"]);
    expect(Object.keys(objectOf(info.props.properties)).sort()).toEqual([
      "maxBytes",
      "message",
      "ref",
      "verify",
      "yq",
    ]);
    const shapes = info.returns?.anyOf;
    expect(Array.isArray(shapes) ? shapes.length : 0).toBe(2);
    expect(info.description).toContain("<Git.Commit ref=");
    expect(info.description).toContain("<Git.Commit>Prepare 1.4</Git.Commit>");
    expect(info.as).toContain("full object id");
    expect(info.as).toContain("value, next, prev and last");
  });
});
