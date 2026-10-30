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
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { sep } from "node:path";
import { decodeLocation } from "../../src/repl/route.ts";
import { readRecords } from "../../src/repl/journal.ts";
import { pairedLocation } from "../../src/repl/sidekick/history.ts";
import { platformDataRoot } from "../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../src/repl/storage.ts";
import {
  parseReplPullRequestRequestRecord,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
} from "../../src/repl/repositories/pull-request-records.ts";
import type { ReplPullRequestRequestRecord } from "../../src/repl/repositories/pull-request-records.ts";
import {
  GIT_HOST_EFFECT,
  parseCompletePullRequestReadResult,
  parseGitHostReconciliationRecord,
  PULL_REQUEST,
} from "@executablemd/git";
import type { GitHostReconciliationRecord } from "@executablemd/git";
import type { DurableEvent } from "@executablemd/durable-streams";
import { allocate, settledEntry, showing, showingAcross, terminalDataHome } from "./pty.ts";
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

/**
 * The question, which renders everything this entry has learned so far.
 *
 * Every value in it is a binding: the pull request's own three facts and the
 * length of each evidence array. That is what makes the reopened dialog
 * evidence of *restoration* — the text is evaluated again when the entry is
 * projected, so a reopening that had lost a binding could not print it, and one
 * that resolved it afresh would print what the service holds now instead of
 * what this entry recorded.
 */
const QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", ' +
  'enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} ' +
  'as="answer">Opened {pullRequest.number} at {pullRequest.url} is ' +
  "{pullRequest.state} with {reviews.length}/{comments.length}/{checks.length} " +
  "feedback. Continue this experiment?</Elicit>";

const ASKED = `Opened 1 at ${LOCATOR}/pull/1 is open with 0/0/0 feedback.`;

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
 * The entry history the printed location addresses, as the command stores it.
 *
 * Read through the command's own recipes rather than by guessing at a path:
 * `decodeLocation` says which execution the location names, the per-user data
 * root and `pairedLocation` say where that execution's two files live, and
 * `readRecords` is the same reader the command opens a retained history with.
 * Nothing here adds a storage interface or a second parser.
 */
function* history(home: string, location: string): Operation<DurableEvent[]> {
  const route = decodeLocation(location);
  if (!route.ok) {
    throw route.error;
  }
  // The environment the terminal was given, not this process's own. A platform
  // that reads `XDG_DATA_HOME` resolves the command's root from it, and the
  // harness exports it into every allocated shell; passing the parent's
  // environment instead would look under the default place while the command
  // wrote under the isolated one. A platform that ignores it answers the same
  // either way.
  const root = join(
    platformDataRoot(process.platform, home, { XDG_DATA_HOME: terminalDataHome(home) }, sep),
    ...REPL_DIRECTORY,
  );
  return yield* readRecords(pairedLocation(root, route.value.execution).entries);
}

function held(events: readonly DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === type);
}

/**
 * What each retained evidence read holds, by collection.
 *
 * Read back through the delivered parser, so a snapshot that is not complete
 * contributes nothing rather than being counted as one.
 */
function snapshots(
  events: readonly DurableEvent[],
  read: string,
): { kind: string; items: number }[] {
  const found: { kind: string; items: number }[] = [];
  for (const event of held(events, read)) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    for (const kind of ["reviews", "comments", "checks"] as const) {
      const parsed = parseCompletePullRequestReadResult(event.result.value, kind);
      if (parsed !== undefined) {
        found.push({ kind, items: parsed.items.length });
      }
    }
  }
  return found;
}

/**
 * The Git-host outcomes of one kind this history holds, parsed.
 *
 * Selected by the kind the reconciled request names, because publication and
 * the pull request over it are both `git_host_effect` records: counting the
 * type alone would mix the two.
 */
function reconciled(events: readonly DurableEvent[], kind: string): GitHostReconciliationRecord[] {
  const found: GitHostReconciliationRecord[] = [];
  for (const event of held(events, GIT_HOST_EFFECT)) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record?.request.kind === kind) {
      found.push(record);
    }
  }
  return found;
}

function asked(events: readonly DurableEvent[]): ReplPullRequestRequestRecord[] {
  const found: ReplPullRequestRequestRecord[] = [];
  for (const event of held(events, REPL_REPOSITORY_PULL_REQUEST_REQUEST)) {
    if (event.type === "yield" && event.result.status === "ok") {
      const record = parseReplPullRequestRequestRecord(event.result.value);
      if (record !== undefined) {
        found.push(record);
      }
    }
  }
  return found;
}

/**
 * Run the whole journey, and answer with nothing.
 *
 * Takes the command rather than building one, so the only difference between
 * the two rows that call this is which `xmd` they name.
 */
export function replPullRequestJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    // Loaded here rather than at the top of this module, because this file is
    // also on the import graph of `replUnsupportedPullRequest` below. The Deno
    // entrypoint reaches Workflow's storage adapter and so `node:sqlite`, which
    // Bun does not have; a static import is evaluated before either journey is
    // chosen, so it would turn "this runtime installs no entry provider" from
    // something that suite observes into a module it cannot even load.
    const { PULL_REQUEST_READ: read } = yield* until(import("@executablemd/git/deno"));
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
    // its three collections each bound their own array. These two files are
    // *first-run* evidence: they were written here, and their surviving bytes
    // afterwards prove only that nothing rewrote them. What a reopening
    // restored is read off the re-evaluated dialog instead.
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

    yield* click(first, "[exit]");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));
    // The screen never showed the credential.
    expect((yield* first.shows()).join("\n")).not.toContain(TOKEN);

    // And this is what it wrote down. One saved pull-request request, naming
    // the branch and head this entry published; one successful Git-host
    // outcome for it; and one complete snapshot for each of the three
    // collections. Read out of the file the printed location addresses.
    const left = yield* history(home, location);
    const leftAsked = asked(left);
    expect(leftAsked).toHaveLength(1);
    expect(leftAsked[0]?.resolved.inputs.headBranch).toBe(BRANCH);
    expect(leftAsked[0]?.resolved.inputs.headSha).toBe(published);
    expect(leftAsked[0]?.resolved.inputs.title).toBe(TITLE);
    // The body is the verbatim child content, which is what a resumed update
    // has to present again rather than re-derive.
    expect(leftAsked[0]?.resolved.inputs.body).toContain(BODY);
    // Asking for one to exist, not for a number.
    expect(leftAsked[0]?.resolved.inputs.number).toBe(null);
    // One pull-request outcome, and it performed. The publication beside it is
    // its own reconciliation and is not counted here.
    const leftOutcomes = reconciled(left, PULL_REQUEST);
    expect(leftOutcomes).toHaveLength(1);
    expect(leftOutcomes[0]?.decision).toBe("performed");
    expect([...snapshots(left, read)].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "checks", items: 0 },
      { kind: "comments", items: 0 },
      { kind: "reviews", items: 0 },
    ]);
    // The credential is in none of it.
    expect(JSON.stringify(left)).not.toContain(TOKEN);

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

    // And the two first-run files are still exactly as that run left them:
    // these bytes say nothing was rewritten, which is a different claim from
    // the restored bindings above.
    yield* holding(join(working, "opened.md"), `1 ${LOCATOR}/pull/1 open`);
    yield* holding(join(working, "evidence.md"), "0 0 0");

    // The selected records are the same ones, neither changed nor written
    // again. Compared by selection rather than by whole-file bytes, because a
    // reopening legitimately appends to the history as it projects.
    const reopened = yield* history(home, location);
    expect(asked(reopened)).toEqual(leftAsked);
    expect(reconciled(reopened, PULL_REQUEST)).toEqual(leftOutcomes);
    expect([...snapshots(reopened, read)].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "checks", items: 0 },
      { kind: "comments", items: 0 },
      { kind: "reviews", items: 0 },
    ]);
    expect(service.requests).toEqual([]);
    expect(yield* logged(shim.log)).toEqual([]);
    expect(creations(service)).toBe(0);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);
    expect(yield* gitSaid(working, ["rev-parse", "HEAD"], home)).toBe(advanced);
    expect(yield* exists(join(working, "after.md"))).toBe(false);

    yield* click(second, "[answer]");
    // Everything acknowledged answers historically, and the proof is the
    // question itself: its text is evaluated again as this entry is projected,
    // so the number, the URL, the state and all three counts on this screen are
    // restored bindings. The service now holds two reviews, one comment and one
    // check, so a reopening that resolved any of it again would print `2/1/1`
    // here instead. Read before the answer is given.
    //
    // Only here, and not on the first run: opening this drawer changes which
    // controls the footer offers, and the first run has to walk to `[exit]`
    // afterwards. What the first run resolved is already established by
    // opened.md and evidence.md, written from the same bindings.
    yield* showingAcross(second, ASKED, ACT_MS);
    yield* click(second, "( ) continue");
    // The rail's own mark for the first entry. `[ok] entry-1` is a row of the
    // Entries catalog, which this screen keeps in a drawer.
    yield* settledEntry(second, 1, "ok", ACT_MS);

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

    // The history now holds one more reviews snapshot — the fresh occurrence,
    // which saw the two reviews the service gained — beside the three the first
    // run retained. Nothing opened a second pull request, and the saved request
    // is still the one request.
    const answered = yield* history(home, location);
    expect(asked(answered)).toEqual(leftAsked);
    expect(reconciled(answered, PULL_REQUEST)).toEqual(leftOutcomes);
    expect([...snapshots(answered, read)].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "checks", items: 0 },
      { kind: "comments", items: 0 },
      { kind: "reviews", items: 0 },
      { kind: "reviews", items: 2 },
    ]);
    expect(JSON.stringify(answered)).not.toContain(TOKEN);

    yield* click(second, "[exit]");
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

    yield* click(pty, "[exit]");
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
function* described(error: unknown, log: string, service: PullRequestServer): Operation<Error> {
  const asked = yield* logged(log);
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\ngit=${JSON.stringify(
      asked.map((line) => line.split(" ").slice(-6).join(" ")),
    )}\nservice=${JSON.stringify(service.requests)}`,
  );
}

/**
 * The commit a branch holds in a bare repository, as Git wrote it.
 *
 * The loose ref first, then the packed table. Both reads suspend: the service
 * answers each request inside an Effection task of its own, so there is no
 * synchronous correctness requirement here — only a value the response needs
 * before it is written.
 *
 * A branch that is in neither place answers `undefined`, which is how the
 * service reports a head it has never seen.
 */
function* bareHead(origin: string, branch: string): Operation<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const loose = join(origin, ref);
  if (yield* exists(loose)) {
    return (yield* readTextFile(loose)).trim();
  }
  const packed = join(origin, "packed-refs");
  if (!(yield* exists(packed))) {
    // No packed table either, so this branch is not there.
    return undefined;
  }
  for (const line of (yield* readTextFile(packed)).split("\n")) {
    const [commit, named] = line.split(" ");
    if (named === ref && commit !== undefined) {
      return commit;
    }
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
 * What it answers with is bound before it is written into the line, the same
 * way `packages/git/tests/support/credential-home.ts` binds it. Spelled
 * inline, the line reads to a scanner meeting this file as a credential-named
 * field with a long value — which it is not, and which refuses this
 * repository's own review of it.
 *
 * No URL rewrite is written here. The product reads neither global nor system
 * configuration, by design, so a rewrite in this file would do nothing; the
 * mapping lives in the shim's delegation instead.
 */
function* seedOrigin(home: string, origin: string): Operation<void> {
  const seed = join(home, "seed");
  const proof = "journey-git-credential";
  yield* until(mkdir(seed, { recursive: true }));
  yield* writeTextFile(
    join(home, ".gitconfig"),
    [
      "[user]",
      "\tname = Journey Author",
      "\temail = journey-author@example.test",
      "[credential]",
      `\thelper = "!f() { echo username=journey; echo password=${proof}; }; f"`,
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
