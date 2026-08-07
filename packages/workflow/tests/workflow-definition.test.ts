/**
 * Tier WD — workflow definition descriptors and stored record shapes.
 *
 * These are the provider-neutral parsers. Nothing here opens a database: the
 * question is only whether a value describes what storage was asked to keep,
 * which is the same question whichever host answers it.
 *
 * Two properties are checked throughout. A shape is closed, so a member nobody
 * declared is a parse failure rather than a field silently dropped. And a
 * failure never quotes the value it refused, because these values are retained
 * history and an error travels to logs and terminals.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  canonicalJson,
  conflictingFields,
  definitionToJson,
  type GitWorkflowDefinitionV1,
  parseStopReasonInput,
  parseWorkflowDefinition,
  WORKFLOW_RUN_STATUSES,
  WorkflowDefinitionError,
  WorkflowRequestError,
  type WorkflowRunRecord,
  WorkflowRunStorage,
  WorkflowStorageProviderError,
} from "../mod.ts";

const SHA1 = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A descriptor, loosely typed: half of these tests build ones that are wrong. */
function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: SHA1,
    rootDocumentPath: "workflows/release.md",
    ...overrides,
  };
}

/** The descriptor, parsed, for tests that need one they already trust. */
function parsed(overrides: Partial<GitWorkflowDefinitionV1> = {}): GitWorkflowDefinitionV1 {
  const result = parseWorkflowDefinition(definition(overrides));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refusal(value: unknown): WorkflowDefinitionError {
  const result = parseWorkflowDefinition(value);
  if (result.ok) {
    throw new Error("expected the descriptor to be refused");
  }
  if (!(result.error instanceof WorkflowDefinitionError)) {
    throw result.error;
  }
  return result.error;
}

function record(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: "release-1.4",
    definition: parsed(),
    base: "main",
    props: { channel: "stable", tags: ["a", "b"] },
    status: "running",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("Tier WD — workflow definition descriptors", () => {
  it("WD1: reads a complete descriptor and round-trips it through JSON", function* () {
    const first = parsed();

    expect(first).toEqual({
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: SHA1,
      rootDocumentPath: "workflows/release.md",
    });

    const again = parseWorkflowDefinition(definitionToJson(first));
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toEqual(first);
  });

  it("WD2: refuses a member nobody declared", function* () {
    const error = refusal({ ...definition(), repository: "https://example.invalid/a.git" });

    expect(error.path).toBe("$");
    expect(error.message).toContain("unexpected member");
  });

  it("WD3: refuses anything that is not an object", function* () {
    expect(refusal(null).message).toContain("found null");
    expect(refusal([]).message).toContain("found an array");
    expect(refusal("git").message).toContain("found string");
  });

  it("WD4: admits only version 1 and only the git kind", function* () {
    expect(refusal(definition({ version: 2 })).path).toBe("$.version");
    expect(refusal(definition({ kind: "svn" })).path).toBe("$.kind");
  });

  it("WD5: holds an object id to the length its format requires", function* () {
    expect(parsed({ objectFormat: "sha256", objectId: SHA256 }).objectId).toBe(SHA256);

    expect(refusal(definition({ objectFormat: "sha256" })).path).toBe("$.objectId");
    expect(refusal(definition({ objectId: SHA1.slice(1) })).path).toBe("$.objectId");
    expect(refusal(definition({ objectFormat: "sha512" })).path).toBe("$.objectFormat");
  });

  it("WD6: admits lowercase hexadecimal only, so one commit has one spelling", function* () {
    const error = refusal(definition({ objectId: SHA1.toUpperCase() }));

    expect(error.path).toBe("$.objectId");
    expect(error.message).toContain("lowercase");
  });

  it("WD7: refuses a root path that is not repository-relative POSIX", function* () {
    const refused = [
      "",
      "/etc/passwd",
      "workflows\\release.md",
      "./release.md",
      "../release.md",
      "workflows/../release.md",
      "workflows//release.md",
      "workflows/release.md/",
      "workflows/rele\u0000ase.md",
    ];

    for (const rootDocumentPath of refused) {
      expect(refusal(definition({ rootDocumentPath })).path).toBe("$.rootDocumentPath");
    }
  });

  it("WD8: admits an ordinary nested path", function* () {
    expect(parsed({ rootDocumentPath: "a/b/c.md" }).rootDocumentPath).toBe("a/b/c.md");
    expect(parsed({ rootDocumentPath: "release.md" }).rootDocumentPath).toBe("release.md");
    expect(parsed({ rootDocumentPath: ".github/release.md" }).rootDocumentPath).toBe(
      ".github/release.md",
    );
  });

  it("WD9: never quotes the value it refused", function* () {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    for (const error of [
      refusal(definition({ objectId: secret })),
      refusal(definition({ rootDocumentPath: `/${secret}` })),
      refusal({ ...definition(), token: secret }),
    ]) {
      expect(error.message).not.toContain(secret);
      expect(error.path).not.toContain(secret);
    }
  });
});

describe("Tier WD — stored record shapes", () => {
  it("WD10: retains exactly the six statuses", function* () {
    expect(WORKFLOW_RUN_STATUSES).toEqual([
      "running",
      "suspended",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("WD11: reads both stop reason variants and refuses a mixture", function* () {
    const host = parseStopReasonInput({ kind: "host", code: "interrupted" });
    expect(host.ok && host.value).toEqual({ kind: "host", code: "interrupted" });

    const journal = parseStopReasonInput({ kind: "journal", eventId: "e17" });
    expect(journal.ok && journal.value).toEqual({ kind: "journal", eventId: "e17" });

    for (const refused of [
      { kind: "host", eventId: "e17" },
      { kind: "journal", code: "interrupted" },
      { kind: "host", code: "interrupted", eventId: "e17" },
      { kind: "other", code: "interrupted" },
      { kind: "host", code: "" },
    ]) {
      const result = parseStopReasonInput(refused);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
  });

  it("WD12: a stop reason carries a code, never a message", function* () {
    const message = "connect ECONNREFUSED 10.0.0.1:5432 while reading /etc/shadow";
    const result = parseStopReasonInput({ kind: "host", code: "interrupted", message });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain(message);
  });

  it("WD13: names one value however its keys were ordered", function* () {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("Tier WD — the storage Api without a provider", () => {
  it("WD17: refuses rather than retaining nothing quietly", function* () {
    for (const attempt of [
      function* () {
        yield* WorkflowRunStorage.operations.create({
          runId: "release-1.4",
          definition: parsed(),
          base: "main",
          props: {},
        });
      },
      function* () {
        yield* WorkflowRunStorage.operations.lookup("release-1.4");
      },
    ]) {
      let raised: unknown;
      try {
        yield* attempt();
      } catch (error) {
        raised = error;
      }

      // A run that appears to start and retains nothing has not started, so
      // the default handler says so rather than answering with an empty store.
      expect(raised).toBeInstanceOf(WorkflowStorageProviderError);
    }
  });
});

describe("Tier WD — compatible reuse", () => {
  it("WD14: a request describing the stored run conflicts in nothing", function* () {
    const stored = record();

    expect(
      conflictingFields(stored, {
        runId: stored.runId,
        definition: stored.definition,
        base: stored.base,
        props: { tags: ["a", "b"], channel: "stable" },
      }),
    ).toEqual([]);
  });

  it("WD15: every immutable field is compared, and named when it differs", function* () {
    const stored = record();
    const request = {
      runId: stored.runId,
      definition: stored.definition,
      base: stored.base,
      props: stored.props,
    };

    expect(conflictingFields(stored, { ...request, runId: "other" })).toEqual(["run id"]);
    expect(conflictingFields(stored, { ...request, base: "develop" })).toEqual(["base"]);
    expect(conflictingFields(stored, { ...request, props: { channel: "beta" } })).toEqual([
      "props",
    ]);

    for (const changed of [
      parsed({ objectId: SHA1.replace("9", "a") }),
      parsed({ rootDocumentPath: "workflows/other.md" }),
      parsed({ objectFormat: "sha256", objectId: SHA256 }),
    ]) {
      expect(conflictingFields(stored, { ...request, definition: changed })).toEqual([
        "definition",
      ]);
    }
  });

  it("WD16: what a run accumulates takes no part in the comparison", function* () {
    const request = {
      runId: "release-1.4",
      definition: parsed(),
      base: "main",
      props: { channel: "stable", tags: ["a", "b"] },
    };

    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(conflictingFields(record({ status }), request)).toEqual([]);
    }

    expect(
      conflictingFields(
        record({
          status: "failed",
          stopReason: { kind: "journal", eventId: "e17" },
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }),
        request,
      ),
    ).toEqual([]);
  });
});
