/**
 * Review-scoped GitHub authentication middleware.
 *
 * The provider is intentionally exercised through Markdown projection. The
 * request recorder is outside that scope, so these assertions distinguish
 * middleware inheritance from a helper that merely adds headers at call sites.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import type { Operation } from "effection";
import { scoped } from "effection";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

const PROVIDER = `---
meta:
  componentName: GitHubAuth
props:
  type: object
  properties: {}
  additionalProperties: false
---

\`\`\`ts persist eval
import { API, env as runtimeEnv } from "@executablemd/runtime";

function* installGitHubAuth() {
  const token = yield* runtimeEnv("GITHUB_TOKEN");
  if (token) {
    yield* API.Fetch.around({
      *fetch([input, init], next) {
        let url;
        try {
          url = new URL(input);
        } catch {
          return yield* next(input, init);
        }

        if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
          return yield* next(input, init);
        }

        return yield* next(input, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            "Accept": "application/vnd.github+json",
            "Authorization": ["Bearer", token].join(" "),
          },
        });
      },
    }, { at: "min" });
  }
}

yield* installGitHubAuth();
\`\`\`

<Content />
`;

const PROBE = `---
meta:
  componentName: Probe
props:
  type: object
  properties:
    label:
      type: string
    url:
      type: string
  required: [label, url]
  additionalProperties: false
---

\`\`\`ts eval
import { fetch as runtimeFetch } from "@executablemd/runtime";

const response = yield* runtimeFetch(url, {
  method: "POST",
  headers: { "X-Caller": "kept", "Content-Type": "application/custom" },
  body: "request-body",
});
const responseText = yield* response.text();
\`\`\`

{label}={responseText}
`;

const FILES: Record<string, string> = {
  "doc.md": [
    "<GitHubAuth><Wrapper /></GitHubAuth>",
    '<GitHubAuth><Probe label="lookalike" url="https://api.github.com.example.com/repos/a" /></GitHubAuth>',
    '<GitHubAuth><Probe label="plain" url="https://example.com/request" /></GitHubAuth>',
    '<Probe label="outside" url="https://api.github.com/repos/outside" />',
  ].join("\n"),
  "components/GitHubAuth.md": PROVIDER,
  "components/Probe.md": PROBE,
  "components/Wrapper.md": '<Probe label="nested" url="https://api.github.com/repos/nested" />',
};

interface RequestRecord {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
}

interface Run {
  output: string;
  serialized: string;
  requests: RequestRecord[];
}

function run(token?: string): Operation<Run> {
  return scoped(function* () {
    const requests: RequestRecord[] = [];
    yield* useStubFs(FILES);
    yield* API.Env.around(
      {
        *env([name], next) {
          if (name === "GITHUB_TOKEN") {
            return token;
          }
          return yield* next(name);
        },
      },
      { at: "min" },
    );
    yield* API.Fetch.around(
      {
        *fetch([input, init]) {
          requests.push({ input, init });
          return {
            status: 200,
            headers: { get: () => null },
            *text() {
              return "ok";
            },
          };
        },
      },
      { at: "min" },
    );

    const stream = new InMemoryStream();
    const execution = yield* execute({ path: "doc.md", stream });
    const output = yield* forEach(function* () {}, execution.output);
    const result = yield* execution;
    expect(result.ok).toBe(true);
    return { output, serialized: JSON.stringify(stream.snapshot()), requests };
  });
}

describe("review-scoped GitHub authentication", () => {
  beforeAll(() => useTempFileCompiler());

  it("injects only for the exact GitHub API host and preserves requests", function* () {
    const runResult = yield* run("secret-token");

    expect(runResult.output).toContain("nested=ok");
    expect(runResult.output).toContain("lookalike=ok");
    expect(runResult.output).toContain("plain=ok");
    expect(runResult.output).toContain("outside=ok");

    const nested = runResult.requests[0];
    expect(nested.input).toBe("https://api.github.com/repos/nested");
    expect(nested.init).toEqual({
      method: "POST",
      headers: {
        "X-Caller": "kept",
        "Content-Type": "application/custom",
        Accept: "application/vnd.github+json",
        Authorization: "Bearer secret-token",
      },
      body: "request-body",
    });

    for (const request of runResult.requests.slice(1)) {
      expect(request.init?.headers?.Authorization).toBe(undefined);
      expect(request.init?.headers?.["X-Caller"]).toBe("kept");
      expect(request.init?.body).toBe("request-body");
    }
    expect(runResult.requests[3].init?.headers?.Authorization).toBe(undefined);
    expect(runResult.serialized).not.toContain("secret-token");
  });

  it("delegates unchanged when the token is unavailable", function* () {
    const runResult = yield* run();

    for (const request of runResult.requests) {
      expect(request.init?.headers).toEqual({
        "X-Caller": "kept",
        "Content-Type": "application/custom",
      });
      expect(request.init?.body).toBe("request-body");
    }
    expect(runResult.serialized).not.toContain("secret-token");
  });
});
