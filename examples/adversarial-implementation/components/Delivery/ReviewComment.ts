import { rm } from "@effectionx/fs";
import { API, cwd, exec, parseFilesFailure } from "@executablemd/runtime";
import { ensure, scoped, type Operation } from "effection";
import { z } from "zod";
import { createDirectory, digest } from "../Ticket/native-node.ts";
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
const pulls = z.object({
  number: targetSchema.shape.number,
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  head: z.object({ ref: z.string(), sha }),
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

function* readTarget(target: Target) {
  const { exitCode, stdout } = yield* github(`repos/${target.repository}/pulls/${target.number}`);
  if (exitCode !== 0) {
    return false;
  }
  const pr = pulls.parse(JSON.parse(stdout));
  return (
    pr.number === target.number &&
    pr.base.repo.full_name.toLowerCase() === target.repository.toLowerCase() &&
    pr.head.ref === target.branch &&
    pr.head.sha === target.revision
  );
}

function findComment(
  target: Target,
  comments: z.infer<typeof input>["comments"],
  marker: string,
  body: string,
): Verified | null {
  const matches = comments.filter(
    (item) => item.kind === "conversation" && item.body.split("\n", 1)[0] === marker,
  );
  if (matches.length > 1) {
    throw new Error("Multiple GitHub comments claim the same review revision.");
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
    throw new Error("The GitHub comment does not match the saved review.");
  }
  return { revision, bodySha256: digest(new TextEncoder().encode(body)), id, url: value.url };
}

function* readSaved(directory: string) {
  const result = yield* API.Files.operations.readTextFile({ cwd: directory, path: "comment.json" });
  if (result.ok) {
    return saved.parse(JSON.parse(result.value));
  }
  if (parseFilesFailure(result.error)?.reason === "missing") {
    return null;
  }
  throw result.error;
}

function* post(target: Target, reservation: string, body: string): Operation<void> {
  try {
    // A reservation survives interruption so a retry can adopt the remote comment.
    yield* createDirectory(reservation);
  } catch (error) {
    if (z.object({ code: z.literal("EEXIST") }).safeParse(error).success) {
      return;
    }
    throw error;
  }
  yield* scoped(function* () {
    let release = true;
    yield* ensure(function* () {
      if (release) {
        yield* rm(reservation, { recursive: true, force: true });
      }
    });
    const payload = reservation + "/request.json";
    yield* write(target.directory, payload, JSON.stringify({ body }));
    if (!(yield* readTarget(target))) {
      return;
    }
    release = false;
    const { exitCode, stdout } = yield* github(
      "--include",
      "--method",
      "POST",
      `repos/${target.repository}/issues/${target.number}/comments`,
      "--input",
      payload,
    );
    // An explicit rejection permits another attempt. Transport and server errors leave the reservation in place.
    release = exitCode !== 0 && /^HTTP\/\d(?:\.\d)? (400|401|403|404|422|429)\b/.test(stdout);
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
    if (publish && !(yield* readTarget(target))) {
      return pending("The current pull request does not match the reviewed revision.");
    }

    const observed = findComment(target, comments, marker, body);
    if (observed === null && publish && allowPost && previous === null) {
      yield* post(target, record, body);
      return { state: "readback" };
    }
    if (observed === null) {
      return pending(
        "The current review comment could not be verified. Retry publication from the saved receipt.",
      );
    }
    if (previous !== null && JSON.stringify(previous) !== JSON.stringify(observed)) {
      return pending("The GitHub comment differs from its recorded identity.");
    }
    if (publish && previous === null) {
      // A matching comment may already exist even if no local request survived.
      yield* API.Fs.operations.ensureDir(record);
      yield* write(target.directory, record + "/comment.json", JSON.stringify(observed));
    }
    return { state: "verified", ...observed };
  } catch {
    return pending(
      "The current review comment could not be verified. Check publication access and reconcile the saved receipt.",
    );
  }
}
