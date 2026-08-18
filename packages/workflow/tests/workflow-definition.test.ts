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
import { isCanonicalDocumentTarget } from "@executablemd/core";
import {
  canonicalJson,
  conflictingFields,
  definitionComponents,
  definitionToJson,
  type GitWorkflowDefinitionV1,
  parseStopReasonInput,
  parseWorkflowDefinition,
  WORKFLOW_RUN_STATUSES,
  WorkflowDefinitionError,
  WorkflowRequestError,
  type WorkflowRunRecord,
  type WorkflowDefinition,
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

/** The five names the representative authored workflow declares, in one bundle. */
const BUNDLE = [
  { name: "Discovery", path: "workflows/Discovery.md", sourceHash: blob(1) },
  { name: "Implementation", path: "workflows/Implementation.md", sourceHash: blob(2) },
  { name: "InstructionFiles", path: "workflows/InstructionFiles.md", sourceHash: blob(3) },
  { name: "Planning", path: "workflows/Planning.md", sourceHash: blob(4) },
  { name: "UserCheckpoint", path: "workflows/UserCheckpoint.md", sourceHash: blob(5) },
];

/** A distinct SHA-1 blob id per component, so a swap is visible. */
function blob(nth: number): string {
  return `${nth}`.repeat(2).padEnd(40, "0");
}

function bundled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...definition(), components: BUNDLE, ...overrides };
}

function parsedBundle(overrides: Record<string, unknown> = {}): GitWorkflowDefinitionV1 {
  const result = parseWorkflowDefinition(bundled(overrides));
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
    expect(error.message).toContain("expected only the members");
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

  it("WD9: never repeats what it refused, as a value or as a name", function* () {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    for (const error of [
      refusal(definition({ objectId: secret })),
      refusal(definition({ rootDocumentPath: `/${secret}` })),
      // A member name is content too: a value carrying a credential as a key
      // is no safer to print than one carrying it as a value.
      refusal({ ...definition(), [secret]: "anything" }),
      refusal({ ...definition(), [`${secret}-nested`]: { deeper: 1 } }),
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

/**
 * Every target form this suite exercises, and whether a descriptor may carry it.
 *
 * Canonical encoding escapes everything outside RFC 3986's unreserved set, so
 * a heading holding `/`, `*`, `#`, `%`, or a space is retained as an escape and
 * cannot be read back as hierarchy or operator syntax.
 */
const CANONICAL_TARGETS = [
  "Release",
  "Release/Publish",
  "Release/Publish/Notes",
  "Release%2FNotes",
  "star%2A",
  "hash%23tag",
  "pct%25value",
  "two%20words",
  "%C3%9Cn%C3%AFc%C3%B8d%C3%A9",
];

const REFUSED_TARGETS = [
  "",
  "#Release",
  "Release/*",
  "**",
  "Rel*ease",
  "Release/**/Notes",
  "%zz",
  "%2f",
  "Release/",
  "/Release",
  "Release//Notes",
  "Release ",
  " Release",
  "Two  words",
  "éclair",
];

describe("Tier WD — a definition's exact document target", () => {
  it("WD18: an untargeted descriptor writes no target member at all", function* () {
    const untargeted = parsed();

    expect("targetPath" in untargeted).toBe(false);
    expect(Object.keys(definitionToJson(untargeted) as Record<string, unknown>)).toEqual([
      "version",
      "kind",
      "objectFormat",
      "objectId",
      "rootDocumentPath",
    ]);
  });

  it("WD19: a targeted descriptor round-trips its exact target unchanged", function* () {
    const targeted = parsed({ targetPath: "Release/Publish" });

    expect(targeted.targetPath).toBe("Release/Publish");

    const json = definitionToJson(targeted) as Record<string, unknown>;
    expect(json["targetPath"]).toBe("Release/Publish");

    const again = parseWorkflowDefinition(json);
    expect(again.ok && again.value).toEqual(targeted);
  });

  it("WD20: every canonical target survives byte for byte", function* () {
    for (const targetPath of CANONICAL_TARGETS) {
      const stored = parsed({ targetPath });
      expect({ targetPath, stored: stored.targetPath }).toEqual({ targetPath, stored: targetPath });

      const again = parseWorkflowDefinition(definitionToJson(stored));
      expect({ targetPath, ok: again.ok }).toEqual({ targetPath, ok: true });
      expect(again.ok && again.value.targetPath).toBe(targetPath);
    }
  });

  it("WD21: a target that is not exactly canonical is refused at its own path", function* () {
    for (const targetPath of REFUSED_TARGETS) {
      const error = refusal(definition({ targetPath }));
      expect({ targetPath, path: error.path }).toEqual({ targetPath, path: "$.targetPath" });
      expect(error.message).toContain("expected one exact canonical document target");
      // A canonical target encodes heading text, so the diagnostic says nothing
      // about the one it read. The empty target is skipped because every string
      // contains it.
      if (targetPath !== "") {
        expect(error.message).not.toContain(targetPath);
      }
    }
  });

  it("WD22: a present target that is not a string is refused, absence excepted", function* () {
    for (const value of [undefined, null, 1, true, ["Release"], { path: "Release" }]) {
      const error = refusal(definition({ targetPath: value }));
      expect({ value, path: error.path }).toEqual({ value, path: "$.targetPath" });
      expect(error.message).toContain("expected a string");
    }
  });

  it("WD23: the public core predicate answers exactly as definition parsing does", function* () {
    for (const targetPath of CANONICAL_TARGETS) {
      expect({ targetPath, canonical: isCanonicalDocumentTarget(targetPath) }).toEqual({
        targetPath,
        canonical: true,
      });
    }
    for (const targetPath of REFUSED_TARGETS) {
      expect({ targetPath, canonical: isCanonicalDocumentTarget(targetPath) }).toEqual({
        targetPath,
        canonical: false,
      });
    }
  });

  it("WD24: a run of one section is not a run of the whole document", function* () {
    const whole = record();
    const section = record({ definition: parsed({ targetPath: "Release/Publish" }) });
    const other = record({ definition: parsed({ targetPath: "Release/Announce" }) });

    const asking = (stored: WorkflowRunRecord, definition: WorkflowDefinition) =>
      conflictingFields(stored, {
        runId: stored.runId,
        definition,
        base: stored.base,
        props: stored.props,
      });

    // The same exact target is the same run.
    expect(asking(section, section.definition)).toEqual([]);
    expect(asking(whole, whole.definition)).toEqual([]);

    // Whole-document and targeted are different runs, in both directions.
    expect(asking(whole, section.definition)).toEqual(["definition"]);
    expect(asking(section, whole.definition)).toEqual(["definition"]);

    // So are two different sections of one document.
    expect(asking(section, other.definition)).toEqual(["definition"]);
  });
});

/**
 * Tier WD — the component bundle a definition is closed over.
 *
 * The bundle is a member of the one descriptor rather than a version past it.
 * Absent, it identifies a run closed over no components — which is what every
 * definition retained before bundles existed is. Present, it is the exact set
 * the root may resolve, and it is identity: canonical, one entry per name,
 * sorted by name, each holding the blob's own object id under the descriptor's
 * own format.
 */
describe("Tier WD — the component bundle a definition is closed over", () => {
  it("WD25: a descriptor closed over no bundle writes no bundle member", function* () {
    const first = parsed();

    expect("components" in first).toBe(false);
    expect(Object.keys(definitionToJson(first) as Record<string, unknown>)).toEqual([
      "version",
      "kind",
      "objectFormat",
      "objectId",
      "rootDocumentPath",
    ]);
    expect(definitionComponents(first)).toEqual([]);
  });

  it("WD26: a bundled descriptor round-trips its whole bundle unchanged", function* () {
    const bundle = parsedBundle();

    expect(bundle.version).toBe(1);
    expect(bundle.components).toEqual(BUNDLE);
    expect(definitionComponents(bundle)).toEqual(BUNDLE);

    const json = definitionToJson(bundle) as Record<string, unknown>;
    expect(json["components"]).toEqual(BUNDLE);

    const again = parseWorkflowDefinition(json);
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toEqual(bundle);
  });

  it("WD27: a bundle's hashes are held to the format the descriptor names", function* () {
    const sha256 = parsedBundle({
      objectFormat: "sha256",
      objectId: SHA256,
      components: [{ name: "Discovery", path: "workflows/Discovery.md", sourceHash: SHA256 }],
    });
    expect(definitionComponents(sha256)).toEqual([
      { name: "Discovery", path: "workflows/Discovery.md", sourceHash: SHA256 },
    ]);

    // The same entry under sha1 is the wrong length, and the sha1 bundle is the
    // wrong length under sha256: neither is a hash this descriptor could hold.
    expect(refusal(bundled({ components: definitionComponents(sha256) })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(refusal(bundled({ objectFormat: "sha256", objectId: SHA256 })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(
      refusal(bundled({ components: [{ ...BUNDLE[0], sourceHash: SHA1.toUpperCase() }] })).message,
    ).toContain("lowercase");
  });

  it("WD28: the bundle is canonical — one entry per name, sorted by name", function* () {
    const reversed = [...BUNDLE].reverse();
    expect(refusal(bundled({ components: reversed })).message).toContain("sorted by name");

    const duplicated = [BUNDLE[0], BUNDLE[0]];
    expect(refusal(bundled({ components: duplicated })).message).toContain("once");

    expect(refusal(bundled({ components: [] })).message).toContain("at least one component");
    expect(refusal(bundled({ components: {} })).path).toBe("$.components");
  });

  it("WD29: each entry is closed, and names a Markdown path inside the tree", function* () {
    expect(refusal(bundled({ components: [{ ...BUNDLE[0], origin: "elsewhere" }] })).path).toBe(
      "$.components[0]",
    );
    expect(refusal(bundled({ components: [{ name: "Discovery", path: "a.md" }] })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(refusal(bundled({ components: [{ ...BUNDLE[0], name: "discovery" }] })).path).toBe(
      "$.components[0].name",
    );

    for (const path of [
      "",
      "/etc/passwd",
      "workflows\\Discovery.md",
      "./Discovery.md",
      "../Discovery.md",
      "workflows/../Discovery.md",
      "workflows//Discovery.md",
      "workflows/Discovery.md/",
      "workflows/Discovery.ts",
      "workflows/Discovery",
    ]) {
      expect({
        path,
        at: refusal(bundled({ components: [{ ...BUNDLE[0], path }] })).path,
      }).toEqual({ path, at: "$.components[0].path" });
    }
  });

  it("WD30: a descriptor retained before bundles existed still reads", function* () {
    // The exact JSON a run stored before the member existed. It parses, it
    // means "closed over no components", and it serializes back byte for byte
    // — which is what keeps the bundle a member rather than a second version.
    const retained = {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: SHA1,
      rootDocumentPath: "workflows/release.md",
    };
    const again = parseWorkflowDefinition(retained);

    expect(again.ok).toBe(true);
    expect(again.ok && definitionComponents(again.value)).toEqual([]);
    expect(again.ok && definitionToJson(again.value)).toEqual(retained);

    // Presence is the member being written at all: a descriptor that wrote it
    // and named no bundle asked for one and failed to say which.
    expect(refusal({ ...retained, components: undefined }).path).toBe("$.components");
    expect(refusal({ ...retained, components: null }).path).toBe("$.components");
  });

  it("WD31: a refusal never repeats the bundle it refused", function* () {
    // A distinctive string rather than a credential-shaped one: what is proved
    // is that no part of a refused entry is echoed, and a value that is not a
    // token proves it just as well. WD9 keeps the token-shaped canary for the
    // descriptor's own members, where nothing this suite adds changes it.
    const canary = "never-printed-canary-b7a1e9";

    for (const error of [
      refusal(bundled({ components: [{ ...BUNDLE[0], path: `/${canary}.md` }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], sourceHash: canary }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], name: canary }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], [canary]: 1 }] })),
    ]) {
      expect(error.message).not.toContain(canary);
      expect(error.path).not.toContain(canary);
    }
  });
});

describe("Tier WD — a bundle decides compatible reuse", () => {
  const stored = record({ definition: parsedBundle() });
  const asking = (definition: WorkflowDefinition) =>
    conflictingFields(stored, {
      runId: stored.runId,
      definition,
      base: stored.base,
      props: stored.props,
    });

  it("WD32: the same bundle is the same run", function* () {
    expect(asking(parsedBundle())).toEqual([]);
  });

  it("WD33: a changed name, path, hash, or set is a different definition", function* () {
    const renamed = [...BUNDLE.slice(1), { ...BUNDLE[0], name: "Zeroth" }].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    const moved = [{ ...BUNDLE[0], path: "workflows/other/Discovery.md" }, ...BUNDLE.slice(1)];
    const rehashed = [{ ...BUNDLE[0], sourceHash: blob(9) }, ...BUNDLE.slice(1)];
    const fewer = BUNDLE.slice(1);

    for (const components of [renamed, moved, rehashed, fewer]) {
      expect(asking(parsedBundle({ components }))).toEqual(["definition"]);
    }
  });

  it("WD34: a run closed over a bundle is not a run closed over none", function* () {
    expect(asking(parsed())).toEqual(["definition"]);

    const unbundled = record();
    expect(
      conflictingFields(unbundled, {
        runId: unbundled.runId,
        definition: parsedBundle(),
        base: unbundled.base,
        props: unbundled.props,
      }),
    ).toEqual(["definition"]);
  });

  it("WD35: what a run accumulates still takes no part in the comparison", function* () {
    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(
        conflictingFields(record({ definition: parsedBundle(), status }), {
          runId: stored.runId,
          definition: parsedBundle(),
          base: stored.base,
          props: stored.props,
        }),
      ).toEqual([]);
    }
  });
});
