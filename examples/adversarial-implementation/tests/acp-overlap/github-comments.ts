import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { PullRequestAPI } from "@executablemd/git/api";
import { API } from "@executablemd/runtime";
import { z } from "zod";
import { waitForFile } from "./receipts.ts";

const repository = "taras/executable.md";
const comments = `repos/${repository}/issues/7/comments`;
const url = `https://github.com/${repository}/pull/7`;
const evidence = z.strictObject({
  kind: z.literal("conversation"),
  id: z.string(),
  url: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const reply = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode });

export function* installGitHub(directory: string, checkout: string, actor: string) {
  let lost = false;
  const remote = z.object({ revision: z.string(), branch: z.string() });
  const payload = z.strictObject({ body: z.string() });
  const tracked = `${directory}/comment.json`;

  yield* PullRequestAPI.around({
    *read([target, options]) {
      if (target !== url) {
        throw new Error("Unexpected pull request evidence read.");
      }
      const { revision, branch } = remote.parse(
        JSON.parse(yield* readTextFile(`${checkout}/remote.json`)),
      );
      if (options.kind === "details") {
        const stale = yield* exists(`${directory}/stale`);
        return {
          kind: "details",
          details: {
            providerId: "fixture-pr-7",
            number: 7,
            url,
            state: "open",
            title: "Review publication fixture",
            body: "",
            draft: false,
            headBranch: branch,
            headSha: stale ? "0".repeat(40) : revision,
            headRepository: repository,
            baseBranch: "main",
            baseSha: "1".repeat(40),
            baseRepository: repository,
          },
        };
      }
      if (options.kind !== "comments") {
        throw new Error("Unexpected pull request evidence kind.");
      }
      if (lost || (yield* exists(`${directory}/comments-unavailable`))) {
        throw new Error("The pull request comments are unavailable.");
      }
      if (
        actor === "later" &&
        (yield* exists(`${directory}/deny-reconciliation`)) &&
        (yield* exists(`${directory}/../review-${revision}/publication-7/active`))
      ) {
        throw new Error("The authorized comment read failed under the write reservation.");
      }
      const items = (yield* exists(tracked))
        ? [evidence.parse(JSON.parse(yield* readTextFile(tracked)))]
        : [];
      return { kind: "comments", items };
    },
  });
  yield* API.Process.around({
    *exec([options], next) {
      const [tool, ...args] = options.command;
      if (tool !== "gh") {
        return yield* next(options);
      }
      if (args.slice(0, 3).join(" ") !== "api --hostname github.com") {
        throw new Error("Unexpected GitHub CLI boundary.");
      }
      const rest = args.slice(3);
      if (
        rest.length !== 6 ||
        rest.slice(0, 5).join(" ") !== `--include --method POST ${comments} --input`
      ) {
        throw new Error("Unexpected GitHub comment command.");
      }
      yield* writeTextFile(`${directory}/${actor}-posted`, "");
      const body = payload.parse(JSON.parse(yield* readTextFile(rest[5]))).body;
      const delayed = yield* exists(`${directory}/delay-post`);
      if (delayed && actor === "winner") {
        yield* writeTextFile(`${directory}/post-ready`, "");
        if ((yield* waitForFile(`${directory}/release-post`, 45_000)).timeout) {
          throw new Error("Timed out waiting to release the GitHub write.");
        }
      }
      if (actor === "winner" && (yield* exists(`${directory}/drop-post`))) {
        return reply("HTTP/2.0 502 Bad Gateway\r\n\r\n", 1);
      }
      if (yield* exists(tracked)) {
        throw new Error("GitHub received a duplicate review write.");
      }
      const saved = evidence.parse({
        kind: "conversation",
        id: "42",
        url: `${url}#issuecomment-42`,
        author: "workflow",
        createdAt: "2026-11-15T00:00:00Z",
        updatedAt: "2026-11-15T00:00:00Z",
        body,
      });
      yield* writeTextFile(tracked, JSON.stringify(saved));
      if (yield* exists(`${directory}/interrupt-post`)) {
        yield* writeTextFile(`${directory}/post-accepted`, "");
        yield* waitForFile(`${directory}/never-acknowledge`, 45_000);
        throw new Error("The publication process survived interruption.");
      }
      lost = delayed && actor === "winner";
      return lost ? reply("", 1) : reply("HTTP/2.0 201 Created\r\n\r\n" + JSON.stringify(saved));
    },
  });
}
