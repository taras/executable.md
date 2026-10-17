/**
 * The one real-terminal journey an entry's pull requests and evidence rest on.
 *
 * Shared by two rows that differ in exactly one thing: which `xmd` runs. The
 * Deno source row proves the entry capability this repository builds; the
 * compiled row proves the binary carries it. Writing the journey twice would
 * let the two drift, and a compiled row asserting something slightly weaker
 * than the source row is how a packaging defect survives.
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that publishes a branch and opens
 * its pull request, walk away at a question, let the reviews and checks change
 * while away, and come back to the printed location. So this launches the
 * production entrypoint on a pty, against a bare remote on disk and a Git host
 * on a loopback port, and reads the answer off the screen and off both.
 *
 * ## What is substituted, and what is not
 *
 * Two leaf boundaries, and nothing else. `git` reaches a bare repository on
 * disk rather than github.com, through Git's own `insteadOf` — so the locator
 * the entry authenticates and fingerprints stays the github.com one a document
 * wrote, which is the whole point of substituting at that layer rather than
 * rewriting the document. And the configured API endpoint points at a forge in
 * this process, which counts what it was asked.
 *
 * The CLI, the per-entry factory, the selectors, the publication, the upsert,
 * the three read adapters, the storage and the terminal are all the real ones.
 */

import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { each, ensure, resource, scoped, sleep, until, useScope } from "effection";
import { fromReadable } from "@effectionx/node";
import { Buffer } from "node:buffer";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { creations, gitHubStore, mutations, respond } from "../../../git/tests/support/github.ts";
import type { GitHubHttpResponse } from "../../../git/src/deno/composition/github.ts";
import { allocate, showing, showingAcross } from "./pty.ts";
import type { Pty } from "./pty.ts";

const REACH_MS = 180_000;
const ACT_MS = 60_000;

/** How this row's `xmd` is invoked, as one shell command. */
export type ReplCommand = (args: readonly string[]) => string;

const JOURNEY_IDENTITY = { name: "Journey Author", email: "journey-author@example.test" };

/** The branch this journey publishes, which is not the repository's primary one. */
const BRANCH = "review/notes";

/**
 * The repository a document names, and the one Git reaches on disk instead.
 *
 * `owner/repository` rather than anything else, because that is the repository
 * the shared pull-request fixture reports a created pull request at — and the
 * evidence reads follow that URL. A locator naming one repository while the
 * host answered about another is exactly what those reads refuse.
 */
const LOCATOR = "https://github.com/owner/repository";

/** The credential this journey's forge requires, which no record may hold. */
const TOKEN = "journey-github-credential";

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

const FIRST_QUESTION =
  '<Elicit schema={{ type: "object", properties: { choice: { type: "string", ' +
  'enum: ["continue"] } }, required: ["choice"], additionalProperties: false }} ' +
  'as="firstAnswer">The branch containing {commit} is published. Continue to its pull ' +
  "request?</Elicit>";

// The saved evidence is rendered as output before this question rather than
// inside its prompt. A prompt carrying three collections scrolls its own option
// below the fold, which is a property of the terminal rather than of the
// behaviour under test.
const SECOND_QUESTION =
  '<Elicit schema={{ type: "object", properties: { choice: { type: "string", ' +
  'enum: ["continue"] } }, required: ["choice"], additionalProperties: false }} ' +
  'as="secondAnswer">Continue to a new review read?</Elicit>';

/**
 * The entry this journey types, as the specification shows it.
 *
 * A managed Repository, a Worktree whose captured path a `<Dir>` renders at, a
 * commit inside that linked checkout, the publication, a question, the pull
 * request and its three evidence reads, a second question, and one later
 * explicit review read after it.
 */
function entry(): string {
  return [
    `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
    `<Worktree name="review" branch=${JSON.stringify(BRANCH)} as="worktree" />`,
    "<Dir path={worktree}>",
    '<File path="notes.md">Ready for review.</File>',
    '<Git.Add paths="notes.md" />',
    '<Git.Commit message="Prepare notes" as="commit" />',
    "<Git.Push />",
    FIRST_QUESTION,
    '<PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
    "<Json value={pullRequest.number} />",
    '<PullRequest.Reviews url={pullRequest.url} as="reviews" />',
    '<PullRequest.Comments url={pullRequest.url} as="comments" />',
    '<PullRequest.Checks url={pullRequest.url} as="checks" />',
    "<Json value={{ reviews, comments, checks }} />",
    SECOND_QUESTION,
    '<PullRequest.Reviews url={pullRequest.url} as="latestReviews" />',
    "<Json value={latestReviews} />",
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/**
 * Run the whole journey, and answer both questions.
 *
 * Takes the command rather than building one, so the only difference between
 * the two rows that call this is which `xmd` they name.
 */
export function replPullRequestJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-pr-pty-");
    const origin = yield* seedBareOrigin(home);
    const shim = yield* gitShim(home, origin);
    yield* seedIdentity(home);
    const forge = yield* useForge(origin);

    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const exports = [
      // A developer laptop configures a credential helper system-wide, so a
      // fixture home that only replaced HOME would still stand on the real
      // machine's authentication.
      "export GIT_CONFIG_SYSTEM=/dev/null",
      "export GIT_CONFIG_NOSYSTEM=1",
      `export GH_TOKEN=${shellQuote(TOKEN)}`,
      `export XMD_WORKFLOW_GITHUB_PULL_REQUESTS=${shellQuote(
        JSON.stringify({
          endpoint: forge.endpoint,
          allowed: [LOCATOR],
        }),
      )}`,
    ].join("; ");
    const open = (args: readonly string[]): string =>
      `cd ${shellQuote(away)} && ${exports}; ${shim.prefix} ${repl(args)}`;

    // ---- First session: publish, then leave at the first question. ----
    const first = yield* allocate(open(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(entry());
    yield* sleep(500);
    yield* first.type("\r");

    const working = yield* managedCheckout(home, "worktrees");
    yield* holding(join(working, "notes.md"), "Ready for review.");
    yield* showing(first, "waiting for an answer", ACT_MS);

    const published = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(published).toMatch(HEAD_SHA_PATTERN);
    yield* remoteHolding(origin, BRANCH, published, home);
    const primary = yield* remoteRef(origin, "main", home);
    expect(primary).toMatch(HEAD_SHA_PATTERN);
    expect(primary).not.toBe(published);
    // Nothing of the pull request happened: the entry is standing at the
    // question before it.
    expect(forge.creations()).toBe(0);
    expect(forge.evidenceReads()).toBe(0);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // ---- Second session: answer, open the pull request, read all three. ----
    const second = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    // Reopening a location shows the entry at its checkpoint; driving the view
    // is what continues the unfinished work.
    yield* resume(second);
    yield* reach(second, "[answer]");
    yield* second.type("\r");
    yield* showingAcross(second, `The branch containing ${published} is published`, ACT_MS);
    yield* click(second, "( ) continue");

    // It stops at the second question. What says it got there is the work
    // between the two: one pull request opened, and each collection read once.
    // Every question's transcript header says "waiting", so the screen cannot
    // tell the two apart.
    yield* reached(() => forge.evidenceReads() >= 3, "the three evidence reads", second);
    expect(forge.creations()).toBe(1);
    expect(forge.reviewReads()).toBe(1);
    expect(forge.commentReads()).toBe(1);
    expect(forge.checkReads()).toBe(1);
    const number = forge.number();
    expect(number).toBeGreaterThan(0);

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);

    // ---- The service changes while the person is away. ----
    forge.change();
    const mutationsSoFar = forge.mutations();
    const evidenceSoFar = forge.evidenceReads();

    // ---- Third session: the saved identity and arrays come back unchanged. ----
    const third = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(third, "[exit]", REACH_MS);
    yield* resume(third);

    // Nothing was mutated and nothing was read again: the completed upsert came
    // from its receipt and the three reads from their saved snapshots.
    expect(forge.mutations()).toBe(mutationsSoFar);
    expect(forge.evidenceReads()).toBe(evidenceSoFar);
    expect(forge.creations()).toBe(1);

    // What proves the three arrays came back from the journal is that nothing
    // was asked for them. The second reviewer, the comment and the check all
    // arrived while the person was away, and this session reaches the question
    // it was left at without asking the host anything at all.
    yield* reach(third, "[answer]");
    yield* third.type("\r");
    yield* showingAcross(third, "Continue to a new review read", ACT_MS);
    expect(forge.evidenceReads()).toBe(evidenceSoFar);
    expect(forge.mutations()).toBe(mutationsSoFar);

    // ---- Answering performs the one later read, which sees the change. ----
    yield* click(third, "( ) continue");
    yield* showing(third, "[ok]", ACT_MS);

    // Exactly one more read — the later explicit one — and it is the only
    // thing in this session that reached the host.
    yield* reached(() => forge.reviewReads() === 2, "the later explicit review read", third);
    expect(forge.evidenceReads()).toBe(evidenceSoFar + 1);
    expect(forge.mutations()).toBe(mutationsSoFar);
    expect(forge.creations()).toBe(1);
    // The primary branch was never touched by any of it.
    expect(yield* remoteRef(origin, "main", home)).toBe(primary);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);

    yield* reach(third, "[exit]");
    yield* third.type("\r");
    expect(yield* ended(third)).toBe(0);
  });
}

/**
 * What a pull request and its reads do on a runtime with no entry capability.
 *
 * Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not got — so `<PullRequest>` and all three reads
 * there say no provider is installed rather than reaching a Git host, and say
 * it before anything is contacted or any managed root is made.
 */
export function replUnsupportedPullRequest(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-pr-pty-");
    const origin = yield* seedBareOrigin(home);
    const shim = yield* gitShim(home, origin);
    yield* seedIdentity(home);
    const forge = yield* useForge(origin);
    const head = yield* remoteRef(origin, "main", home);
    yield* writeTextFile(shim.log, "");

    const exports = [
      // A developer laptop configures a credential helper system-wide, so a
      // fixture home that only replaced HOME would still stand on the real
      // machine's authentication.
      "export GIT_CONFIG_SYSTEM=/dev/null",
      "export GIT_CONFIG_NOSYSTEM=1",
      `export GH_TOKEN=${shellQuote(TOKEN)}`,
      `export XMD_WORKFLOW_GITHUB_PULL_REQUESTS=${shellQuote(
        JSON.stringify({ endpoint: forge.endpoint, allowed: [LOCATOR] }),
      )}`,
    ].join("; ");

    const pty = yield* allocate(
      `cd ${shellQuote(home)} && ${exports}; ${shim.prefix} ${repl(["repl", "--deny-all"])}`,
      home,
    );
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(
      [
        "<PrintErrors>",
        `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
        '<PullRequest title="Prepare notes" as="pullRequest">body</PullRequest>',
        "</Repository>",
        "</PrintErrors>",
        "<PrintErrors>",
        `<PullRequest.Reviews url=${JSON.stringify(`${LOCATOR}/pull/1`)} as="reviews" />`,
        "</PrintErrors>",
        '<File path="after.md">continued</File>',
      ].join("\n"),
    );
    yield* sleep(500);
    yield* pty.type("\r");

    // Refused before a managed checkout exists, which is before a Git host
    // exists in the story at all. The refusal is a sentence, wrapped where the
    // Transcript's own width cuts it, so it is read across those rows.
    yield* showingAcross(pty, "pull-request provider is installed", ACT_MS);
    yield* holding(join(home, "after.md"), "continued");
    expect(yield* logged(shim.log)).toEqual([]);
    expect(forge.requests()).toBe(0);
    expect(yield* remoteRef(origin, "main", home)).toBe(head);
    expect(yield* exists(join(home, ".xmd", "repositories"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}

/** One review, as this forge reports one. */
/**
 * One review, as this forge reports one.
 *
 * The subject is built from this forge's own endpoint, because that is what the
 * read holds an item to: a well-formed answer about another pull request is
 * still the wrong answer.
 */
function review(id: number, author: string, subject: string, head: string): unknown {
  return {
    id,
    user: { login: author },
    state: "APPROVED",
    body: `${author} says so`,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: head,
    html_url: `https://github.com/owner/repository/pull/1#r${id}`,
    pull_request_url: subject,
  };
}

interface Forge {
  readonly endpoint: string;
  /** Add a review, a comment and a check, as a service would between sessions. */
  change(): void;
  /** How many pull requests this forge was asked to create. */
  creations(): number;
  /** How many state-changing calls it was asked for at all. */
  mutations(): number;
  /** How many evidence collections it was asked for, by kind and in total. */
  reviewReads(): number;
  commentReads(): number;
  checkReads(): number;
  evidenceReads(): number;
  /** How many requests of any kind reached it. */
  requests(): number;
  /** The number the created pull request was given. */
  number(): number;
  /** Every path this forge was asked for, in order. */
  paths(): string[];
}

/**
 * A Git host on a loopback port, holding one pull request and its evidence.
 *
 * The pull request itself is the shared fixture's, so the payloads this journey
 * answers with are the ones every other pull-request suite is written against
 * rather than a second account of what GitHub returns. What is added here is
 * the evidence half, which that fixture does not serve: the three collections
 * this entry reads, and a way to change them between sessions.
 *
 * A compiled binary has no seam a suite can substitute, so the only way to ask
 * it what it did is to count what arrived here.
 */
function useForge(origin: string): Operation<Forge> {
  return resource<Forge>(function* (provide) {
    const store = gitHubStore({ owner: "owner", repository: "repository", token: TOKEN });
    // The commit a branch holds, read from the bare remote — which is how the
    // real host knows the commit a pull request is opened from, because the
    // publication put it there.
    store.resolveHead = (branch) => resolveRef(origin, branch);

    const asked: string[] = [];
    // What the host holds, as authors and identifiers rather than as payloads:
    // an item's subject is built from this forge's own endpoint, which is not
    // known until it is listening.
    const evidence = {
      reviews: 0,
      comments: 0,
      checks: 0,
      reviewers: ["first reviewer"],
      commented: false,
      checked: false,
    };

    const scope = yield* useScope();
    let endpoint = "";
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      scope.run(function* () {
        // The body is read by a task of this server's own scope, so tearing the
        // forge down ends the reads still in progress rather than leaving their
        // listeners on sockets it is about to destroy.
        const chunks: Uint8Array[] = [];
        for (const chunk of yield* each(fromReadable(incoming))) {
          chunks.push(chunk);
          yield* each.next();
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const url = new URL(`http://localhost${incoming.url ?? "/"}`);
        const path = url.pathname;
        asked.push(`${incoming.method ?? "GET"} ${path}`);

        const answer = (status: number, payload: unknown): void => {
          outgoing.writeHead(status, { "content-type": "application/json" });
          outgoing.end(JSON.stringify(payload));
        };

        // The three evidence collections, matched for any repository so the URL
        // this forge reports a pull request at is the one that is read. They
        // come first: the shared fixture reads a number out of a pull-request
        // path and would take these for one.
        const head = resolveRef(origin, BRANCH);
        const reviewSubject = `${endpoint}/repos/owner/repository/pulls/1`;
        const issueSubject = `${endpoint}/repos/owner/repository/issues/1`;
        if (/\/pulls\/\d+\/reviews$/.test(path)) {
          evidence.reviews += 1;
          answer(
            200,
            evidence.reviewers.map((author, index) =>
              review(index + 1, author, reviewSubject, head),
            ),
          );
          return;
        }
        if (/\/issues\/\d+\/comments$/.test(path)) {
          evidence.comments += 1;
          answer(
            200,
            evidence.commented
              ? [
                  {
                    id: 9,
                    user: { login: "commenter" },
                    body: "a later comment",
                    created_at: "2026-08-25T00:00:00Z",
                    updated_at: "2026-08-25T00:00:00Z",
                    html_url: "https://github.com/owner/repository/pull/1#c9",
                    issue_url: issueSubject,
                  },
                ]
              : [],
          );
          return;
        }
        if (/\/pulls\/\d+\/comments$/.test(path)) {
          // The other half of one comments read, already counted above.
          answer(200, []);
          return;
        }
        if (/\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
          evidence.checks += 1;
          answer(200, {
            check_runs: evidence.checked
              ? [
                  {
                    id: 4,
                    name: "build",
                    head_sha: head,
                    status: "completed",
                    conclusion: "success",
                    html_url: null,
                    started_at: "2026-08-25T00:00:00Z",
                    completed_at: "2026-08-25T00:01:00Z",
                    output: { title: null, summary: null, text: null },
                  },
                ]
              : [],
          });
          return;
        }
        if (/\/commits\/[0-9a-f]+\/status$/.test(path)) {
          // The other half of one checks read, already counted above.
          answer(200, { sha: head, statuses: [] });
          return;
        }

        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          headers[name === "authorization" ? "Authorization" : name] = String(value);
        }
        let served: GitHubHttpResponse;
        try {
          served = respond(store, {
            method:
              incoming.method === "POST" ? "POST" : incoming.method === "PATCH" ? "PATCH" : "GET",
            url: `http://localhost${incoming.url ?? "/"}`,
            headers,
            body,
          });
        } catch {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(served.status, {
          "content-type": "application/json",
          ...(served.link === undefined ? {} : { link: served.link }),
        });
        outgoing.end(served.body);
      });
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;

    yield* provide({
      endpoint,
      change(): void {
        evidence.reviewers = ["first reviewer", "second reviewer"];
        evidence.commented = true;
        evidence.checked = true;
      },
      creations: () => creations(store),
      mutations: () => mutations(store).length,
      reviewReads: () => evidence.reviews,
      commentReads: () => evidence.comments,
      checkReads: () => evidence.checks,
      evidenceReads: () => evidence.reviews + evidence.comments + evidence.checks,
      requests: () =>
        store.requests.length + evidence.reviews + evidence.comments + evidence.checks,
      number: () => store.pullRequests[0]?.number ?? 0,
      paths: () => [...asked],
    });
  });
}

/** The commit one ref on the bare remote holds. */
function resolveRef(origin: string, ref: string): string {
  const shown = spawnSync("git", ["rev-parse", `refs/heads/${ref}`], {
    cwd: origin,
    encoding: "utf8",
  });
  return shown.status === 0 ? shown.stdout.trim() : "";
}

function* seedBareOrigin(home: string): Operation<string> {
  const origin = join(home, "origin.git");
  const seed = join(home, "seed");
  yield* until(mkdir(seed, { recursive: true }));
  yield* git(home, ["init", "--bare", "-b", "main", origin]);
  yield* git(home, ["init", "-b", "main", seed]);
  yield* writeTextFile(join(seed, "README.md"), "origin\n");
  yield* git(seed, ["add", "README.md"], home);
  yield* git(seed, ["commit", "-m", "first"], home);
  yield* git(seed, ["push", origin, "main:refs/heads/main"], home);
  return origin;
}

/** The commit a ref on the bare remote holds, or the empty string for absence. */
function* remoteRef(origin: string, branch: string, home: string): Operation<string> {
  const shown = yield* gitSaid(origin, ["for-each-ref", "--format=%(refname)|%(objectname)"], home);
  for (const line of shown.split("\n")) {
    const [name, commit] = line.split("|");
    if (name === `refs/heads/${branch}` && commit !== undefined) {
      return commit;
    }
  }
  return "";
}

/** Wait until the remote's branch holds this exact commit. */
function* remoteHolding(
  origin: string,
  branch: string,
  commit: string,
  home: string,
): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const held = yield* remoteRef(origin, branch, home);
    if (held === commit) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${origin} never held ${commit} at refs/heads/${branch}; it holds ` +
          JSON.stringify(held === "" ? "<absent>" : held),
      );
    }
    yield* sleep(250);
  }
}

/**
 * A `git` on `PATH` that logs every invocation and forwards to the real one.
 *
 * Counting from outside the process is the only way to ask a *packaged* binary
 * whether a reopened entry ran anything, because a binary has no seam a suite
 * can substitute.
 */
function* gitShim(
  home: string,
  origin: string,
): Operation<{ readonly prefix: string; readonly log: string }> {
  const real = yield* until(
    new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", "command -v git"], (error, stdout) =>
        error === null ? resolve(stdout.trim()) : reject(error),
      );
    }),
  );
  if (real === "") {
    throw new Error("this host has no git on PATH, so there is nothing to forward to");
  }
  const directory = join(home, "git-shim");
  yield* until(mkdir(directory, { recursive: true }));
  const log = join(home, "git-commands.log");
  const shim = join(directory, "git");
  // The one locator a document writes, swapped for the bare repository on disk
  // in `git`'s own arguments. It has to happen here rather than through Git's
  // `insteadOf`, because every remote-touching invocation this provider makes
  // runs with the invoking user's configuration off — which is exactly the
  // property that keeps a document from retargeting a publication.
  //
  // Only the arguments. What the entry authenticates and fingerprints is the
  // locator it admitted, which it holds itself and never reads back from Git,
  // so nothing has to be substituted on the way out.
  yield* writeTextFile(
    shim,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(log)}`,
      "count=$#",
      "i=0",
      'while [ "$i" -lt "$count" ]; do',
      "  arg=$1",
      "  shift",
      '  case "$arg" in',
      `    ${shellQuote(LOCATOR)}) arg=${shellQuote(origin)} ;;`,
      "  esac",
      '  set -- "$@" "$arg"',
      "  i=$((i + 1))",
      "done",
      `exec ${shellQuote(real)} "$@"`,
      "",
    ].join("\n"),
  );
  yield* until(chmod(shim, 0o755));
  yield* writeTextFile(log, "");
  return { prefix: `PATH=${shellQuote(directory)}:$PATH`, log };
}

/** Every `git` the shim has seen since it was last forgotten. */
function* logged(log: string): Operation<string[]> {
  const held = (yield* exists(log)) ? yield* readTextFile(log) : "";
  return held.split("\n").filter((line) => line !== "");
}

/**
 * Give this journey's isolated home a Git identity, and one substitution.
 *
 * `insteadOf` is Git's own: the entry clones and pushes the locator a document
 * wrote, and Git connects to the bare repository on disk instead. What the
 * checkout records as its origin — and therefore what the entry authenticates
 * and fingerprints — stays that locator, which is why the substitution belongs
 * here rather than in the document.
 */
function* seedIdentity(home: string): Operation<void> {
  yield* writeTextFile(
    join(home, ".gitconfig"),
    `[user]\n\tname = ${JOURNEY_IDENTITY.name}\n\temail = ${JOURNEY_IDENTITY.email}\n`,
  );
}

/** One `git` command, in this journey's own isolated home. */
function git(cwd: string, args: readonly string[], home = cwd): Operation<void> {
  return until(
    new Promise<void>((resolve, reject) => {
      execFile("git", [...args], { cwd, env: environment(home) }, (error) =>
        error === null ? resolve() : reject(error),
      );
    }),
  );
}

/** What one `git` command printed, for a fixture that reads a repository. */
function gitSaid(cwd: string, args: readonly string[], home: string): Operation<string> {
  return until(
    new Promise<string>((resolve, reject) => {
      execFile("git", [...args], { cwd, env: environment(home) }, (error, stdout) =>
        error === null ? resolve(stdout.trim()) : reject(error),
      );
    }),
  );
}

function environment(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Journey",
    GIT_AUTHOR_EMAIL: "journey@example.test",
    GIT_COMMITTER_NAME: "Journey",
    GIT_COMMITTER_EMAIL: "journey@example.test",
  };
}

/** The one managed checkout this journey's entry created, once it is there. */
function* managedCheckout(home: string, kind: "repositories" | "worktrees"): Operation<string> {
  const base = join(home, ".xmd", "repositories", kind);
  const depth = kind === "repositories" ? 1 : 2;
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const found = yield* slotsBeneath(base, depth);
    if (found.length === 1) {
      return found[0]!;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `expected exactly one managed ${kind} checkout beneath ${base}; found ${found.length}`,
      );
    }
    yield* sleep(250);
  }
}

function* slotsBeneath(base: string, depth: number): Operation<string[]> {
  if (!(yield* exists(base))) {
    return [];
  }
  let level = [base];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const directory of level) {
      for (const name of yield* until(readdir(directory))) {
        next.push(join(directory, name));
      }
    }
    level = next;
  }
  const found: string[] = [];
  for (const slot of level) {
    const checkout = join(slot, "checkout");
    if (yield* exists(checkout)) {
      found.push(checkout);
    }
  }
  return found;
}

/**
 * Continue the unfinished entry this reopened view is showing.
 *
 * A location opens at the entry's own checkpoint rather than running it, so
 * what resumes it is activating it — and once it is running it reaches the
 * question it was left at.
 */
function* resume(pty: Pty): Operation<void> {
  // A reopened location shows the entry at its own checkpoint. It goes live
  // when the view is driven, so this drives it until the question it was left
  // at is on the screen rather than waiting for it to resume on its own.
  const deadline = Date.now() + REACH_MS;
  while (!(yield* pty.shows()).some((line) => line.includes("waiting for an answer"))) {
    if (Date.now() > deadline) {
      throw new Error(
        `the reopened entry never reached its question. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(250);
  }
}

/** Wait until this becomes true at the Git host, which is where work shows. */
function* reached(done: () => boolean, what: string, pty?: Pty): Operation<void> {
  const deadline = Date.now() + REACH_MS;
  while (!done()) {
    if (Date.now() > deadline) {
      const screen =
        pty === undefined
          ? ""
          : ` screen=${JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd()))}`;
      throw new Error(`the entry never reached ${what}.${screen}`);
    }
    yield* sleep(250);
  }
}

/** Tab until focus reaches this label. */
function* reach(pty: Pty, label: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (!(yield* pty.shows()).some((line) => line.includes(`> ${label}`))) {
    if (Date.now() > deadline) {
      throw new Error(
        `focus never reached ${label} under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(250);
  }
}

/** Activate the control holding this text with a pointer. */
function* click(pty: Pty, text: string): Operation<void> {
  const screen = yield* pty.shows();
  const row = screen.findIndex((line) => line.includes(text));
  if (row < 0) {
    throw new Error(
      `nothing on this screen holds ${JSON.stringify(text)} to click. screen=` +
        JSON.stringify(screen.map((one) => one.trimEnd())),
    );
  }
  const column = (screen[row] ?? "").indexOf(text) + 1;
  yield* pty.type(`\u001b[<0;${column};${row + 1}M`);
  yield* pty.type(`\u001b[<0;${column};${row + 1}m`);
  yield* sleep(300);
}

/** Wait until this file holds this exact text. */
function* holding(path: string, content: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    if ((yield* exists(path)) && (yield* readTextFile(path)) === content) {
      return;
    }
    if (Date.now() > deadline) {
      const found = (yield* exists(path)) ? yield* readTextFile(path) : "<absent>";
      throw new Error(
        `${path} never held ${JSON.stringify(content)}; it holds ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/** Wait until this command finished, and answer with its exit status. */
/** The exit status, once the command has ended. */
function* ended(pty: Pty): Operation<number> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const status = yield* pty.status();
    if (status !== undefined) {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(`the command never ended\n${(yield* pty.shows()).join("\n")}`);
    }
    yield* sleep(100);
  }
}

/** The location this session printed, which the next one reopens. */
function printedLocation(screen: string): string {
  const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
  if (found === null || found[1] === undefined) {
    throw new Error(
      `this command printed no reopenable location. screen=${JSON.stringify(screen)}`,
    );
  }
  return found[1];
}
