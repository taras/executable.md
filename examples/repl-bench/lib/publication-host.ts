import { Stdio } from "@effectionx/process";
import { fetch } from "@effectionx/fetch";
import { cwd, exec, Permissions } from "@executablemd/runtime";
import { call, each, race, scoped, sleep, until, type Operation } from "effection";
import { z } from "zod";
import { inheritedEnvironment, png } from "./publication-files-deno.ts";
import { IMAGE_LIMIT, sha256, type Evidence } from "./publication-receipt.ts";

const processTimeout = 120_000;
const commandEnv = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
};

export function boundedCommand(
  command: string[],
  limit: number,
  environment?: Record<string, string>,
): Operation<{ exitCode: number; stdout: string }> {
  return scoped(function* () {
    let length = 0;
    let overflow = false;
    let stdout = "";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    yield* Stdio.around({
      *stdout([bytes]) {
        if (limit > 0) {
          length += bytes.byteLength;
          if (length > limit) {
            overflow = true;
          } else {
            stdout += decoder.decode(bytes, { stream: true });
          }
        }
      },
      stderr: () => call(() => undefined),
    });
    let exitCode: number;
    try {
      ({ exitCode } = yield* exec({
        command,
        cwd: yield* cwd(),
        ...(environment === undefined ? {} : { env: inheritedEnvironment(environment) }),
        retain: false,
        timeout: processTimeout,
      }));
    } catch {
      throw new Error("The publication command did not settle with an exit status.");
    }
    if (overflow) {
      throw new Error("A publication command exceeded its output limit.");
    }
    return { exitCode, stdout: stdout + decoder.decode() };
  });
}

export function gh(args: string[], limit = 0) {
  return boundedCommand(["gh", ...args], limit, commandEnv);
}

export function* checkCli() {
  const help = yield* gh(["pr", "edit", "--help"], 32 * 1024);
  if (help.exitCode !== 0 || !/^\s+--attach\s/m.test(help.stdout)) {
    throw new Error("Use GitHub CLI with native gh pr edit --attach support.");
  }
}

export function* checkCheckout({ pins }: Evidence) {
  const commands = [
    ["git", "remote", "get-url", "--all", "origin"],
    ["git", "remote", "get-url", "--push", "--all", "origin"],
    ["git", "symbolic-ref", "--short", "HEAD"],
    ["git", "rev-parse", "--verify", "HEAD"],
  ];
  const results = [];
  for (const command of commands) {
    const result = yield* boundedCommand(command, 4096);
    if (result.exitCode !== 0) {
      throw new Error("Select the caller checkout for the pinned repository and head.");
    }
    results.push(result.stdout.replace(/\r?\n$/, ""));
  }
  const [origin, pushOrigin, branch, head] = results;
  const allowed = [
    `https://github.com/${pins.repository}`,
    `git@github.com:${pins.repository}`,
    `ssh://git@github.com/${pins.repository}`,
  ];
  if (
    [origin, pushOrigin].some((url) => !allowed.includes(url.replace(/\.git$/, ""))) ||
    branch !== pins.headBranch ||
    head !== pins.head
  ) {
    throw new Error("Checkout origin, push origin, branch and HEAD must match the receipt.");
  }
}

const ref = z.object({
  ref: z.string(),
  sha: z.string(),
  repo: z.object({ full_name: z.string() }),
});
const draft = z.object({
  number: z.number(),
  html_url: z.string(),
  state: z.literal("open"),
  draft: z.literal(true),
  body: z.string().nullable(),
  base: ref,
  head: ref,
});

export function draftIdentity({ pins }: Evidence, number: number) {
  return { number, url: `https://github.com/${pins.repository}/pull/${number}`, ...pins };
}

export function* readDraft(evidence: Evidence, number: number) {
  const target = draftIdentity(evidence, number);
  const result = yield* gh(
    ["api", "--hostname", "github.com", `repos/${target.repository}/pulls/${number}`],
    1024 * 1024,
  );
  if (result.exitCode !== 0) {
    throw new Error("Could not read the pinned GitHub draft.");
  }
  const parsed = draft.safeParse(JSON.parse(result.stdout));
  if (
    !parsed.success ||
    parsed.data.number !== number ||
    parsed.data.html_url !== target.url ||
    parsed.data.base.repo.full_name !== target.repository ||
    parsed.data.head.repo.full_name !== target.repository ||
    parsed.data.base.ref !== target.baseBranch ||
    parsed.data.head.ref !== target.headBranch ||
    parsed.data.base.sha !== target.base ||
    parsed.data.head.sha !== target.head
  ) {
    throw new Error(
      "The exact open same-repository draft and revision pins could not be verified.",
    );
  }
  return { target, body: parsed.data.body ?? "" };
}

export function nativeAttachment(destination: string): boolean {
  return /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
    destination,
  );
}

const servingOrigins = new Set([
  "https://objects.githubusercontent.com",
  "https://user-images.githubusercontent.com",
  "https://private-user-images.githubusercontent.com",
  "https://secured-user-images.githubusercontent.com",
  "https://github-production-user-asset-6210df.s3.amazonaws.com",
]);

export function verifyAttachment(
  destination: string,
  digest: string,
  size: number,
): Operation<boolean> {
  return race([
    scoped(function* () {
      let url = new URL(destination);
      for (let redirects = 0; redirects <= 4; redirects++) {
        if (!(yield* Permissions.operations.fetch(url.href, { method: "GET" }))) {
          return false;
        }
        const response = yield* fetch(url, { redirect: "manual", credentials: "omit" });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (response.raw.body !== null) {
            yield* until(response.raw.body.cancel());
          }
          const location = response.headers.get("location");
          if (location === null) {
            return false;
          }
          url = new URL(location, url);
          if (
            url.username !== "" ||
            url.password !== "" ||
            (!servingOrigins.has(url.origin) && !nativeAttachment(url.href))
          ) {
            return false;
          }
          continue;
        }
        if (!response.ok || size > IMAGE_LIMIT) {
          if (response.raw.body !== null) {
            yield* until(response.raw.body.cancel());
          }
          return false;
        }
        const bytes = new Uint8Array(size);
        let count = 0;
        for (const chunk of yield* each(response.body())) {
          if (count + chunk.length > bytes.length) {
            return false;
          }
          bytes.set(chunk, count);
          count += chunk.length;
          yield* each.next();
        }
        return count === size && png(bytes) && sha256(bytes) === digest;
      }
      return false;
    }),
    (function* () {
      yield* sleep(30_000);
      return false;
    })(),
  ]);
}
