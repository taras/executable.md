import { createHash } from "node:crypto";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { CheckLogs } from "../../composition/check-logs.ts";
import type { CheckLogRequest } from "../../composition/check-logs.ts";
import { getExpansion, sourceDescription } from "@executablemd/core";
import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import {
  Files,
  FilesInvariantError,
  Permissions,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { createWorkflowWorkspaceEffect, writeWorkspaceTextFile } from "@executablemd/workflow/deno";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { joinedReadCoordinator } from "./pull-request-read-retention.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import { authorizedHeaders, member, readJson } from "./github.ts";
import {
  gitHubPullRequestReadResolver,
  parseGitHubPullRequestUrl,
  pullRequestAllowed,
} from "./pull-request-reads.ts";

const CHECK_LOG = "<PullRequest.Checks>";
const MAX_LOG_BYTES = 16 * 1024 * 1024;

function refused(sentence: string): never {
  throw new PullRequestReadError("unavailable", CHECK_LOG, sentence);
}

function identityMismatch(): never {
  throw new PullRequestReadError(
    "protocol",
    CHECK_LOG,
    "GitHub returned a different pull request, check, job, run attempt, or head.",
  );
}

function id(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : undefined;
}

function actionJobLink(link: string, repository: string) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.origin !== "https://github.com" || url.username || url.password) {
    return undefined;
  }
  const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(
    url.pathname,
  );
  if (match === null || match[1]?.toLowerCase() !== repository.toLowerCase()) {
    return undefined;
  }
  const [, , runId, jobId] = match;
  return { runId, jobId };
}

function storageUrl(location: string | null): string {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    return refused("GitHub did not return a valid log download URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return refused("GitHub did not return a valid HTTPS log download URL.");
  }
  return url.href;
}

function* readBody(response: Response): Operation<{ content: string; sha256: string }> {
  const body = response.body;
  const length = response.headers.get("content-length");
  if (response.status !== 200 || body === null) {
    return refused("the log response did not contain a complete download.");
  }
  if (length !== null && Number(length) > MAX_LOG_BYTES) {
    return refused("the response exceeds the 16 MiB download limit.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const hash = createHash("sha256");
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = yield* until(reader.read());
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_LOG_BYTES) {
        return refused("the response exceeds the 16 MiB download limit.");
      }
      hash.update(chunk.value);
      const text = decoder.decode(chunk.value, { stream: true });
      if (text !== "") {
        parts.push(text);
      }
    }
    parts.push(decoder.decode());
  } catch (error) {
    if (error instanceof PullRequestReadError) {
      throw error;
    }
    return refused("the response could not be read completely as UTF-8.");
  } finally {
    reader.releaseLock();
  }

  if (
    size === 0 ||
    (length !== null && !response.headers.has("content-encoding") && size !== Number(length))
  ) {
    return refused("the response was empty or incomplete.");
  }
  return { content: parts.join(""), sha256: hash.digest("hex") };
}

type Transfer = {
  content: string;
  sha256: string;
  jobId: string;
  runId: string;
  runAttempt: number;
};

function download(
  { url, checkId, headSha }: CheckLogRequest,
  resolved: ReturnType<typeof gitHubPullRequestReadResolver>,
): Operation<Transfer | null> {
  return scoped(function* () {
    if (id(checkId) === undefined || !/^[a-f0-9]{40}$/.test(headSha)) {
      return identityMismatch();
    }
    const name = parseGitHubPullRequestUrl(url);
    if (
      name === undefined ||
      new URL(url).origin !== "https://github.com" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.owner) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.repository)
    ) {
      return refused("the URL must name a pull request on github.com.");
    }
    const configuration = yield* resolved.authorized();
    if (
      configuration === undefined ||
      (configuration.allowed !== undefined && !pullRequestAllowed(configuration.allowed, url))
    ) {
      return refused("this host has not authorized the pull request that URL names.");
    }
    const access = yield* resolved.transport(configuration).open();
    const openResponse = access.openResponse?.bind(access);
    if (openResponse === undefined) {
      return refused("the GitHub log transport is unavailable.");
    }
    const headers = yield* authorizedHeaders(access, false);
    if (headers === undefined) {
      return refused("the GitHub credential is unavailable.");
    }
    const repository = `${name.owner}/${name.repository}`;
    const repo = `${access.endpoint}/repos/${repository}`;

    const send = function* (
      target: string,
      requestHeaders: Readonly<Record<string, string>>,
    ): Operation<Response> {
      try {
        return yield* openResponse({ method: "GET", url: target, headers: requestHeaders });
      } catch {
        return refused("the GitHub log request failed.");
      }
    };

    const json = (suffix: string): Operation<unknown> =>
      scoped(function* () {
        const response = yield* send(repo + suffix, headers);
        return readJson((yield* readBody(response)).content);
      });

    function sameRepository(value: unknown): boolean {
      return typeof value === "string" && value.toLowerCase() === repository.toLowerCase();
    }

    const pull = yield* json(`/pulls/${name.number}`);
    if (
      member(pull, "number") !== name.number ||
      !sameRepository(member(member(member(pull, "base"), "repo"), "full_name")) ||
      member(member(pull, "head"), "sha") !== headSha
    ) {
      return identityMismatch();
    }

    const check = yield* json(`/check-runs/${checkId}`);
    if (id(member(check, "id")) !== checkId || member(check, "head_sha") !== headSha) {
      return identityMismatch();
    }
    const app = member(member(check, "app"), "slug");
    if (typeof app !== "string" || app === "") {
      return identityMismatch();
    }
    if (app !== "github-actions") {
      return null;
    }
    if (!(yield* Permissions.operations.files("write"))) {
      return refused("the destination is not writable.");
    }
    if (member(check, "status") !== "completed" || member(check, "conclusion") !== "failure") {
      return identityMismatch();
    }
    const details = member(check, "details_url");
    const location = typeof details === "string" ? actionJobLink(details, repository) : undefined;
    const requestedJob = location?.jobId ?? checkId;
    const job = yield* json(`/actions/jobs/${requestedJob}`);
    const jobId = id(member(job, "id"));
    const runId = id(member(job, "run_id"));
    const runAttempt = member(job, "run_attempt");
    if (
      jobId !== requestedJob ||
      (location !== undefined && location.runId !== runId) ||
      runId === undefined ||
      typeof runAttempt !== "number" ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt < 1 ||
      member(job, "head_sha") !== headSha ||
      member(job, "status") !== "completed" ||
      member(job, "conclusion") !== "failure" ||
      member(job, "check_run_url") !== `${repo}/check-runs/${checkId}`
    ) {
      return identityMismatch();
    }

    const attempt = yield* json(`/actions/runs/${runId}/attempts/${runAttempt}`);
    if (
      id(member(attempt, "id")) !== runId ||
      member(attempt, "run_attempt") !== runAttempt ||
      member(attempt, "head_sha") !== headSha ||
      !sameRepository(member(member(attempt, "repository"), "full_name"))
    ) {
      return identityMismatch();
    }
    const logUrl = yield* scoped(function* () {
      const redirect = yield* send(`${repo}/actions/jobs/${jobId}/logs`, headers);
      if (redirect.status !== 302) {
        return refused("GitHub did not provide the job log redirect.");
      }
      return storageUrl(redirect.headers.get("location"));
    });
    const log = yield* readBody(yield* send(logUrl, {}));
    return { ...log, jobId, runId, runAttempt };
  });
}

function logPath(directory: string, runId: string, runAttempt: number, jobId: string): string {
  return `${directory}/run-${runId}-attempt-${runAttempt}-job-${jobId}.log`;
}

function logError(checkId: string, message: string): Json {
  return { checkId, status: "error", message };
}

function* publishLog(
  request: CheckLogRequest,
  project: string,
  resolved: ReturnType<typeof gitHubPullRequestReadResolver>,
  write: FilesHandler["writeTextFile"],
): Operation<Json> {
  let transfer: Transfer | null;
  try {
    transfer = yield* download(request, resolved);
  } catch (error) {
    if (error instanceof PullRequestReadError) {
      return logError(request.checkId, error.message);
    }
    throw error;
  }
  if (transfer === null) {
    return null;
  }
  const { content, jobId, runId, runAttempt, sha256 } = transfer;
  const path = logPath(request.directory, runId, runAttempt, jobId);
  const written = yield* write({ cwd: project, path, content });
  if (!written.ok) {
    const failure = parseFileWriteFailure(written.error);
    if (failure === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return logError(
      request.checkId,
      `The destination write failed (${failure.reason}, ${failure.target}).`,
    );
  }
  if (parseFileWriteSuccess(written.value) === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return {
    checkId: request.checkId,
    status: "saved",
    path,
    jobId,
    runId,
    runAttempt,
    headSha: request.headSha,
    sha256,
  };
}

function validLog(value: unknown, request: CheckLogRequest): value is Json {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object" || Array.isArray(value) || value === undefined) {
    return false;
  }
  if (member(value, "checkId") !== request.checkId) {
    return false;
  }
  if (member(value, "status") === "error") {
    return Object.keys(value).length === 3 && typeof member(value, "message") === "string";
  }
  const job = member(value, "jobId");
  const run = member(value, "runId");
  const attempt = member(value, "runAttempt");
  const digest = member(value, "sha256");
  return (
    Object.keys(value).length === 8 &&
    member(value, "status") === "saved" &&
    typeof job === "string" &&
    id(job) !== undefined &&
    typeof run === "string" &&
    id(run) !== undefined &&
    typeof attempt === "number" &&
    Number.isSafeInteger(attempt) &&
    attempt > 0 &&
    member(value, "path") === logPath(request.directory, run, attempt, job) &&
    member(value, "headSha") === request.headSha &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/.test(digest)
  );
}

export function* useGitHubCheckLogs(
  project: string,
  resolved: ReturnType<typeof gitHubPullRequestReadResolver>,
  options: { database?: WorkflowRunDatabase; write?: FilesHandler["writeTextFile"] } = {},
): Operation<void> {
  yield* CheckLogs.set(function* (request) {
    if (
      (request.provider !== undefined && request.provider !== "github") ||
      new URL(request.url).origin !== "https://github.com"
    ) {
      return null;
    }
    const expansion = yield* getExpansion();
    const description = {
      type: "github_failed_check_log",
      name: `${expansion.id}:${JSON.stringify([project, request])}`,
      ...sourceDescription(expansion.position),
    };
    const effect =
      options.database === undefined
        ? createDurableOperation(
            description,
            () =>
              publishLog(
                request,
                project,
                resolved,
                options.write ?? Files.operations.writeTextFile,
              ),
            { coordinator: joinedReadCoordinator },
          )
        : createWorkflowWorkspaceEffect(options.database, description, (transaction) =>
            publishLog(request, project, resolved, (input) =>
              writeWorkspaceTextFile(transaction, input),
            ),
          );

    const stored: unknown = yield effect;
    if (!validLog(stored, request)) {
      throw new StaleInputError("The retained failed check log receipt is invalid.");
    }
    return stored;
  });
}
