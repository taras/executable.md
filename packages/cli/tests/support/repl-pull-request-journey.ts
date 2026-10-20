/**
 * The one real-terminal journey an entry's pull requests rest on.
 *
 * Shared by two rows that differ in exactly one thing: which `xmd` runs. The
 * Deno source row proves the entry capability this repository builds; the
 * compiled row proves the binary carries it. Writing the journey twice would
 * let the two drift, and a compiled row asserting something slightly weaker
 * than the source row is how a packaging defect survives.
 *
 * Every other row of this feature's evidence installs its own host. None of
 * them can show what a person actually does: type an entry that publishes a
 * branch, opens a pull request and reads its feedback, walk away at a question,
 * let the checkout and the service both move on, and reopen the printed
 * location. So this launches the production entrypoint on a pty and reads the
 * answer off the screen, off the checkout, off the bare remote and off the
 * service's own request log.
 *
 * ## The two leaves, and nothing else
 *
 * A bare repository on disk stands in for the remote, and a loopback listener
 * stands in for GitHub. The document still names `github.com`, because that is
 * what selects the adapter and what a person would write.
 *
 * Git is pointed at the bare repository by the shim this journey already needs
 * for counting invocations: it delegates to the real Git with one
 * invocation-local destination mapping. A configuration file could not say so —
 * the host pins global and system configuration off, deliberately — and that
 * restriction is left exactly as it is. What the entry admits and retains is
 * the URL the document wrote, and real Git makes every checkout, object, commit
 * and remote ref underneath it.
 */

import { expect } from "@executablemd/test-support/expect";
import { shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allocate, showing, showingAcross } from "./pty.ts";
import type { Pty } from "./pty.ts";
import {
  ACT_MS,
  ended,
  git,
  gitShim,
  gitSaid,
  holding,
  logged,
  managedCheckout,
  printedLocation,
  pushes,
  reach,
  REACH_MS,
  remoteHolding,
  remoteRef,
  click,
} from "./repl-push-journey.ts";
import type { ReplCommand } from "./repl-push-journey.ts";
import { usePullRequestServer } from "./pull-request-server.ts";
import type { PullRequestServer } from "./pull-request-server.ts";

/** The repository the document names, and the one the modeled service holds. */
const OWNER = "octo";
const REPOSITORY = "project";
const LOCATOR = `https://github.com/${OWNER}/${REPOSITORY}`;

/** The branch this journey publishes, which is not the repository's primary one. */
const BRANCH = "review/pull-request";

const TITLE = "Prepare the release";
const BODY = "Ready for review.";

/** The credential this journey's operator configured. A journal may never hold it. */
const TOKEN = "pull-request-server-credential";

const QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", ' +
  'enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} ' +
  'as="answer">Opened {pullRequest.number}. Continue this experiment?</Elicit>';

/**
 * The entry this journey types, as the specification shows it.
 *
 * A managed Repository, a Worktree whose captured path a `<Dir>` renders at, a
 * commit inside that linked checkout, the publication, the pull request over
 * it, and its three evidence collections. Then the question, the write after
 * it, and one explicitly authored later read — which is a new occurrence and
 * therefore new work, however much of what precedes it is history.
 */
function entry(): string {
  return [
    `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
    `<Worktree name="experiment" branch=${JSON.stringify(BRANCH)} as="worktree" />`,
    "<Dir path={worktree}>",
    '<File path="notes.md">ready</File>',
    '<Git.Add paths="notes.md" />',
    '<Git.Commit message="Prepare notes" as="commit" />',
    "<Git.Push />",
    `<PullRequest title=${JSON.stringify(TITLE)} as="pullRequest">`,
    BODY,
    "</PullRequest>",
    '<PullRequest.Reviews url={pullRequest.url} as="reviews" />',
    '<PullRequest.Comments url={pullRequest.url} as="comments" />',
    '<PullRequest.Checks url={pullRequest.url} as="checks" />',
    // Written down rather than rendered: the Transcript scrolls a long source
    // out of view, and what a binding held is read back from the file it was
    // written into whatever the screen happens to be showing.
    '<File path="opened.md">{pullRequest.number} {pullRequest.url} {pullRequest.state}</File>',
    '<File path="evidence.md">{reviews.length} {comments.length} {checks.length}</File>',
    QUESTION,
    '<File path="after.md">continued</File>',
    '<PullRequest.Reviews url={pullRequest.url} as="fresh" />',
    '<File path="fresh.md">{fresh.length}</File>',
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/**
 * Run the whole journey, and answer with nothing.
 *
 * Takes the command rather than building one, so the only difference between
 * the two rows that call this is which `xmd` they name.
 */
export function replPullRequestJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-pull-request-pty-");
    // Named before it exists, because the shim's mapping is what makes the
    // document's locator reach it.
    const origin = join(home, "origin.git");
    const shim = yield* gitShim(home, { map: { from: LOCATOR, to: origin } });
    const service = yield* usePullRequestServer({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      // This GitHub reads the branch out of the bare repository the
      // publication actually pushed to, which is how the real one knows.
      resolveHead: (branch) => bareHead(origin, branch),
    });
    yield* seedOrigin(home, origin);
    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const open = (args: readonly string[]): string =>
      `cd ${shellQuote(away)} && ${shim.prefix} ${configured(service)} ${repl(args)}`;

    const first = yield* allocate(open(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(entry());
    yield* sleep(500);
    yield* first.type("\r");

    // Waited for first, so a prefix that refused is reported as the sentence on
    // the screen rather than as an absent managed checkout. What Git was asked
    // travels with that report, because the sentence alone cannot say which
    // locator a clone actually attempted.
    yield* reached(first, "waiting for an answer", shim.log, service);
    const working = yield* managedCheckout(home, "worktrees");

    // The prefix ran: the file is there, the commit was made, and the branch
    // reached the remote before anything was asked of the service.
    yield* holding(join(working, "notes.md"), "ready");
    const published = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(published).toMatch(/^[0-9a-f]{40}$/);
    yield* remoteHolding(origin, BRANCH, published, home);

    // The pull request opened once, over the branch this entry published, and
    // its three collections each bound their own array.
    yield* holding(join(working, "opened.md"), `1 ${LOCATOR}/pull/1 open`);
    yield* holding(join(working, "evidence.md"), "0 0 0");
    expect(creations(service)).toBe(1);
    const opened = service.pullRequests.find((held) => held.number === 1);
    expect(opened?.title).toBe(TITLE);
    expect(opened?.headRef).toBe(BRANCH);
    expect(opened?.headSha).toBe(published);
    expect(opened?.baseRef).toBe("main");
    // The credential reached the service and nothing reached it unauthorized.
    expect(service.requests.every((asked) => asked.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(collections(service)).toEqual(["reviews", "comments", "checks"]);
    // Neither the suffix write nor the later read has happened.
    expect(yield* exists(join(working, "after.md"))).toBe(false);
    expect(yield* exists(join(working, "fresh.md"))).toBe(false);
    expect(reviewReads(service)).toBe(1);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));
    // The screen never showed the credential.
    expect((yield* first.shows()).join("\n")).not.toContain(TOKEN);

    // Both sides move on while the person is away. The checkout advances, and
    // the service gains feedback this entry has never seen.
    yield* writeTextFile(join(working, "later.md"), "later\n");
    yield* gitSaid(working, ["add", "later.md"], home);
    yield* gitSaid(working, ["commit", "-m", "theirs"], home);
    const advanced = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(advanced).not.toBe(published);
    if (opened !== undefined) {
      opened.reviews = ["ship it", "one note"];
      opened.comments = ["thanks"];
      opened.checks = ["build"];
    }

    // Both logs forgotten here, so what they hold afterwards is what
    // *reopening* did.
    yield* writeTextFile(shim.log, "");
    service.requests.length = 0;

    const second = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    yield* showing(second, "waiting for an answer", ACT_MS);

    // Everything acknowledged answers historically. The pull request is the one
    // that was opened, the three arrays are the ones that were read, and the
    // service was not asked about any of it — nor was `git` run at all.
    yield* holding(join(working, "opened.md"), `1 ${LOCATOR}/pull/1 open`);
    yield* holding(join(working, "evidence.md"), "0 0 0");
    expect(service.requests).toEqual([]);
    expect(yield* logged(shim.log)).toEqual([]);
    expect(creations(service)).toBe(0);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);
    expect(yield* gitSaid(working, ["rev-parse", "HEAD"], home)).toBe(advanced);
    expect(yield* exists(join(working, "after.md"))).toBe(false);

    yield* reach(second, "[answer]");
    yield* second.type("\r");
    // The saved number, which describes what was opened rather than anything
    // resolved again now.
    yield* showing(second, "Opened 1.", ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // The suffix executed for the first time on the answer: the write landed,
    // and the read written after the question is a new occurrence, so it
    // reaches the service and sees what is there now.
    yield* holding(join(working, "after.md"), "continued");
    // The read written after the question saw what is there now.
    yield* holding(join(working, "fresh.md"), "2");
    expect(reviewReads(service)).toBe(1);
    // And answering published nothing and opened nothing further.
    expect(yield* pushes(shim.log)).toEqual([]);
    expect(creations(service)).toBe(0);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);
    // And the historical arrays are still the historical ones.
    yield* holding(join(working, "evidence.md"), "0 0 0");

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);
  });
}

/**
 * What a pull request does on a runtime with no entry capability.
 *
 * Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not got — so `<PullRequest>` and its evidence
 * reads there say no provider is installed rather than reaching anything, and
 * say it before a credential is read or a managed root is made.
 */
export function replUnsupportedPullRequest(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-pull-request-pty-");
    const origin = join(home, "origin.git");
    const shim = yield* gitShim(home, { map: { from: LOCATOR, to: origin } });
    const service = yield* usePullRequestServer({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      pullRequests: [{ number: 1, headSha: "a".repeat(40), reviews: ["ship it"] }],
    });
    yield* seedOrigin(home, origin);
    yield* writeTextFile(shim.log, "");

    const pty = yield* allocate(
      `cd ${shellQuote(home)} && ${shim.prefix} ${configured(service)} ${repl(["repl", "--deny-all"])}`,
      home,
    );
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(
      [
        "<PrintErrors>",
        `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
        `<PullRequest title=${JSON.stringify(TITLE)} as="pullRequest">`,
        BODY,
        "</PullRequest>",
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

    // Both refusals are sentences, wrapped where the Transcript's own width
    // cuts them, so they are read across those rows.
    yield* showingAcross(pty, "composition provider is installed", ACT_MS);
    yield* showingAcross(pty, "no pull-request provider", ACT_MS);
    yield* holding(join(home, "after.md"), "continued");
    // Nothing was contacted, no credential was read, and no managed root was
    // made: the refusal is upstream of all three.
    expect(service.requests).toEqual([]);
    expect(yield* logged(shim.log)).toEqual([]);
    expect(yield* exists(join(home, ".xmd", "repositories"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}

/**
 * Wait for the question, reporting what Git was asked if it never arrives.
 *
 * A refusal prints one sentence, and the sentence for a transport that could
 * not authenticate looks the same whether the locator was unreachable or the
 * credential was missing. The invocations the shim saw distinguish them.
 */
function* reached(
  pty: Pty,
  text: string,
  log: string,
  service: PullRequestServer,
): Operation<void> {
  try {
    yield* showing(pty, text, ACT_MS);
  } catch (error) {
    throw yield* described(error, log, service);
  }
}

/** What was asked of Git and of the service, beside whatever went wrong. */
function* described(
  error: unknown,
  log: string,
  service: PullRequestServer,
): Operation<Error> {
  const asked = yield* logged(log);
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\ngit=${JSON.stringify(
      asked.map((line) => line.split(" ").slice(-6).join(" ")),
    )}\nservice=${JSON.stringify(service.requests)}`,
  );
}

/**
 * The commit a branch holds in a bare repository, read synchronously.
 *
 * The service answers one request at a time and has to name a commit while it
 * is answering, so this is the one place in this journey that reads a file
 * without suspending. It reads what Git wrote: the loose ref first, then the
 * packed table.
 */
function bareHead(origin: string, branch: string): string | undefined {
  const ref = `refs/heads/${branch}`;
  try {
    return readFileSync(join(origin, ref), "utf8").trim();
  } catch {
    // Not loose, so it may be packed.
  }
  try {
    for (const line of readFileSync(join(origin, "packed-refs"), "utf8").split("\n")) {
      const [commit, named] = line.split(" ");
      if (named === ref && commit !== undefined) {
        return commit;
      }
    }
  } catch {
    // No packed table either, so this branch is not there.
  }
  return undefined;
}

/** The two variables an operator sets to point this host at that service. */
function configured(service: PullRequestServer): string {
  const stated = JSON.stringify({ allowed: [LOCATOR], endpoint: service.url });
  return `GH_TOKEN=${shellQuote(TOKEN)} XMD_WORKFLOW_GITHUB_PULL_REQUESTS=${shellQuote(stated)}`;
}

/** How many pull requests this service was asked to open. */
function creations(service: PullRequestServer): number {
  return service.requests.filter(
    (asked) => asked.method === "POST" && asked.path.endsWith("/pulls"),
  ).length;
}

/** How many times it was asked for a pull request's reviews. */
function reviewReads(service: PullRequestServer): number {
  return service.requests.filter((asked) => asked.path.endsWith("/reviews")).length;
}

/** Which evidence collections it was asked for, in order, once each. */
function collections(service: PullRequestServer): string[] {
  const seen: string[] = [];
  for (const asked of service.requests) {
    const found = /\/(reviews|comments|check-runs)$/.exec(asked.path);
    const named = found?.[1] === "check-runs" ? "checks" : found?.[1];
    if (named !== undefined && !seen.includes(named)) {
      seen.push(named);
    }
  }
  return seen;
}

/**
 * A bare repository with one commit, and the credential its locator needs.
 *
 * An `https://` locator carries an identity, so this host asks Git for a
 * credential for it before it clones. The helper below is the operator's own
 * credential machinery answering — the same `git credential fill` a person's
 * keychain answers — with a synthetic value that depends on no account. The
 * local transport the shim maps to never uses what it hands back.
 *
 * No URL rewrite is written here. The product reads neither global nor system
 * configuration, by design, so a rewrite in this file would do nothing; the
 * mapping lives in the shim's delegation instead.
 */
function* seedOrigin(home: string, origin: string): Operation<void> {
  const seed = join(home, "seed");
  yield* until(mkdir(seed, { recursive: true }));
  yield* writeTextFile(
    join(home, ".gitconfig"),
    [
      "[user]",
      "\tname = Journey Author",
      "\temail = journey-author@example.test",
      "[credential]",
      '\thelper = "!f() { echo username=journey; echo password=journey-git-credential; }; f"',
      "",
    ].join("\n"),
  );
  yield* git(home, ["init", "--bare", "-b", "main", origin]);
  yield* git(home, ["init", "-b", "main", seed]);
  yield* writeTextFile(join(seed, "README.md"), "origin\n");
  yield* git(seed, ["add", "README.md"], home);
  yield* git(seed, ["commit", "-m", "first"], home);
  yield* git(seed, ["push", origin, "main:refs/heads/main"], home);
}
