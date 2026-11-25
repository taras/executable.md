import { PullRequestAPI } from "@executablemd/git/api";
import { API, cwd, exec, parseFilesFailure } from "@executablemd/runtime";
import { scoped } from "effection";
import { z } from "zod";
import { reserveDirectory, digest } from "../Ticket/native-node.ts";
import { clear, write } from "../Ticket/text-storage.ts";
import { reviewerSchema } from "./records.ts";

export const props = {
  type: "object",
  properties: {
    target: { type: "object" },
    review: { type: "object" },
    publish: { type: "boolean" },
    allowPost: { type: "boolean" },
    comments: { type: "array" },
  },
  required: ["target", "review", "publish", "allowPost", "comments"],
  additionalProperties: false,
};

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const targetSchema = z.strictObject({
  directory: z.string().startsWith("/"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  branch: z.string().min(1),
  revision: sha,
});
const input = z.strictObject({
  target: targetSchema,
  review: z.object({
    reviewer: reviewerSchema,
    model: z.string().min(1).nullable(),
    result: z.object({
      revision: sha,
      verdict: z.enum(["pass", "changes_required", "blocked"]),
      summary: z.string().min(1).max(1500),
      findings: z.array(z.object({ blocking: z.boolean(), description: z.string().min(1) })),
    }),
  }),
  publish: z.boolean(),
  allowPost: z.boolean(),
  comments: z.array(
    z.object({
      kind: z.enum(["conversation", "review"]),
      id: z.string(),
      url: z.string(),
      body: z.string(),
    }),
  ),
});
const saved = z.strictObject({
  revision: sha,
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string(),
});

type Target = z.infer<typeof targetSchema>;
type Review = z.infer<typeof input>["review"];
type Verified = z.infer<typeof saved>;

function pending(reason: string) {
  return { state: "pending", reason };
}

function quote(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
}

function render(marker: string, review: Review, model: string) {
  const { revision, verdict, summary, findings } = review.result;
  const titles = { pass: "PASS", changes_required: "CHANGES REQUIRED", blocked: "BLOCKED" };
  return [
    marker,
    "## Independent review",
    "Reviewed commit `" + revision + "`",
    "Verdict **" + titles[verdict] + "**",
    "Reviewer\n\n" + quote(review.reviewer.provider + " / " + model),
    "### Summary\n\n" + quote(summary),
    "### Findings",
    ...(findings.length === 0
      ? ["None."]
      : findings.map(
          ({ blocking, description: findingText }) =>
            (blocking ? "**Blocking**" : "**Non-blocking**") + "\n\n" + quote(findingText),
        )),
  ].join("\n\n");
}

function* github(...args: string[]) {
  return yield* exec({
    command: ["gh", "api", "--hostname", "github.com", ...args],
    cwd: yield* cwd(),
    timeout: 30_000,
  });
}

function targetUrl(target: Target) {
  return `https://github.com/${target.repository}/pull/${target.number}`;
}

function* readTarget(target: Target) {
  const url = targetUrl(target);
  const result = yield* PullRequestAPI.operations.read(url, { kind: "details" });
  if (result.kind !== "details") {
    return false;
  }
  const pr = result.details;
  const repository = target.repository.toLowerCase();
  return (
    pr.url.toLowerCase() === url.toLowerCase() &&
    pr.number === target.number &&
    pr.baseRepository.toLowerCase() === repository &&
    pr.headRepository.toLowerCase() === repository &&
    pr.baseBranch === "main" &&
    pr.headBranch === target.branch &&
    pr.headSha === target.revision
  );
}

class CommentConflict extends Error {}

function findComment(
  target: Target,
  comments: readonly z.infer<typeof input>["comments"][number][],
  marker: string,
  body: string,
): Verified | null {
  const matches = comments.filter(
    (item) => item.kind === "conversation" && item.body.split("\n", 1)[0] === marker,
  );
  if (matches.length > 1) {
    throw new CommentConflict("Multiple GitHub comments claim the same review revision.");
  }
  const [value] = matches;
  if (value === undefined) {
    return null;
  }
  const { repository, number, revision } = target;
  const id = Number(value.id);
  const urls = ["issues", "pull"].map((kind) =>
    `https://github.com/${repository}/${kind}/${number}#issuecomment-${id}`.toLowerCase(),
  );
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    value.id !== String(id) ||
    value.body !== body ||
    !urls.includes(value.url.toLowerCase())
  ) {
    throw new CommentConflict("The GitHub comment does not match the saved review.");
  }
  return { revision, bodySha256: digest(new TextEncoder().encode(body)), id, url: value.url };
}

function* readPublicationFile(directory: string, path: string) {
  const result = yield* API.Files.operations.readTextFile({ cwd: directory, path });
  if (result.ok) {
    return result.value;
  }
  if (parseFilesFailure(result.error)?.reason === "missing") {
    return null;
  }
  throw result.error;
}

function* readSaved(directory: string) {
  const text = yield* readPublicationFile(directory, "comment.json");
  return text === null ? null : saved.parse(JSON.parse(text));
}

function* recordComment(
  record: string,
  target: Target,
  previous: Verified | null,
  observed: Verified,
) {
  if (previous !== null) {
    if (
      previous.id !== observed.id ||
      previous.url !== observed.url ||
      previous.revision !== observed.revision ||
      previous.bodySha256 !== observed.bodySha256
    ) {
      return pending("The GitHub comment differs from its recorded identity.");
    }
  } else {
    yield* API.Fs.operations.ensureDir(record);
    yield* write(target.directory, record + "/comment.json", JSON.stringify(observed));
  }
  return { state: "verified", ...observed };
}

function* reconcileAndPost(target: Target, record: string, marker: string, body: string) {
  return yield* scoped(function* () {
    yield* API.Fs.operations.ensureDir(record);
    if (!(yield* reserveDirectory(record + "/active"))) {
      return pending("Another publication attempt holds the reservation. Retry after it settles.");
    }

    const previous = yield* readSaved(record);
    let observed: Verified | null;
    try {
      // An earlier snapshot can predate the last writer. Reconcile again under the reservation.
      const result = yield* PullRequestAPI.operations.read(targetUrl(target), { kind: "comments" });
      if (result.kind !== "comments") {
        return pending("The GitHub provider did not return a complete comment read.");
      }
      observed = findComment(target, result.items, marker, body);
    } catch (error) {
      if (error instanceof CommentConflict) {
        throw error;
      }
      return pending(
        "Could not reconcile pull request comments. Check GitHub read access and retry.",
      );
    }
    if (!(yield* readTarget(target))) {
      return pending("The current pull request does not match the reviewed revision.");
    }
    if (observed !== null) {
      return yield* recordComment(record, target, previous, observed);
    }
    if (previous !== null) {
      return pending("The recorded GitHub comment is missing. Restore or reconcile its identity.");
    }

    if ((yield* readPublicationFile(record, "acknowledged")) !== null) {
      return pending("GitHub acknowledged the POST. The comment is still missing from readback.");
    }

    const payload = record + "/request.json";
    yield* write(target.directory, payload, JSON.stringify({ body }));
    const { exitCode, stdout } = yield* github(
      "--include",
      "--method",
      "POST",
      `repos/${target.repository}/issues/${target.number}/comments`,
      "--input",
      payload,
    );
    if (exitCode === 0) {
      yield* write(target.directory, record + "/acknowledged", target.revision);
    }
    const httpStatus = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(stdout)?.[1];
    return {
      state: "readback",
      reason:
        exitCode === 0
          ? "GitHub acknowledged the comment request."
          : `GitHub comment POST failed${httpStatus === undefined ? "" : " (HTTP " + httpStatus + ")"}.`,
    };
  });
}

export default function* ReviewComment(value: unknown) {
  const { target, review, publish, allowPost, comments } = input.parse(value);
  if (review.result.revision !== target.revision) {
    return pending("The retained review names a different revision.");
  }
  const marker = `<!-- xmd-independent-review:v1 ${target.revision} -->`;
  const model = review.model ?? review.reviewer.model;
  const body = render(marker, review, model);
  const record = `${target.directory}/review-${target.revision}/publication-${target.number}`;
  try {
    const previous = yield* readSaved(record);
    if (!publish && previous === null) {
      return pending("Publish the joined review and verify the GitHub comment.");
    }
    if (body.length > 65_536) {
      return pending("The rendered review exceeds the GitHub comment limit.");
    }
    yield* clear(
      [
        model,
        review.result.summary,
        ...review.result.findings.map((finding) => finding.description),
      ].join("\n"),
    );
    yield* clear(body);
    if (!(yield* readTarget(target))) {
      return pending("The current pull request does not match the reviewed revision.");
    }

    const observed = findComment(target, comments, marker, body);
    if (observed === null) {
      if (previous !== null) {
        return pending(
          "The recorded GitHub comment is missing. Restore or reconcile its identity.",
        );
      }
      if (publish && allowPost) {
        return yield* reconcileAndPost(target, record, marker, body);
      }
      return pending(
        "The current review comment could not be verified. Retry from the saved receipt.",
      );
    }
    if (publish || previous !== null) {
      return yield* recordComment(record, target, previous, observed);
    }
    return pending("Publish the joined review and verify the GitHub comment.");
  } catch (error) {
    if (error instanceof CommentConflict) {
      return pending(error.message);
    }
    return pending(
      "Could not verify the review publication record or pull request target. Check local records and GitHub access.",
    );
  }
}
