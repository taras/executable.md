/**
 * Who may execute a run, on real workerd.
 *
 * Admission order and acquisition lifetime are the two things this suite is
 * about. The order matters because a mismatched build must not reach a token
 * and a bad token must not reach run state; the lifetime matters because the
 * connection *is* the acquisition, with no lease to expire and no heartbeat to
 * miss, so the only proof that ownership ended is that the socket did.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, VALID_CLAIMS } from "./support/executor-object.ts";

let unique = 0;

function executor() {
  unique += 1;
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(`executor-${unique}-${Math.random()}`));
}

function on<T>(
  stub: ReturnType<typeof executor>,
  body: (instance: ExecutorObject) => T,
): Promise<Awaited<T>> {
  return runInDurableObject(stub, body) as Promise<Awaited<T>>;
}

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

describe("admitting an executor", () => {
  it("admits a matching build with authenticated claims", async () => {
    const stub = executor();
    expect(await on(stub, (o) => o.admitConnection({}))).toBe("admitted");
    expect(await on(stub, (o) => o.holders())).toBe(1);
  });

  it("refuses a build the owner did not agree to, before reading the token", async () => {
    const stub = executor();
    // The claims are deliberately unusable. If the release were checked after
    // them, the refusal would name the token rather than the build.
    expect(await on(stub, (o) => o.admitConnection({ release: "other-build", claims: null }))).toBe(
      "release:release-mismatch",
    );
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });

  it("refuses an absent or malformed build identity", async () => {
    const stub = executor();
    expect(await on(stub, (o) => o.admitConnection({ release: undefined }))).toBe(
      "release:release-absent",
    );
    expect(await on(stub, (o) => o.admitConnection({ release: "not a fingerprint" }))).toBe(
      "release:release-malformed",
    );
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });

  it("refuses every claim the policy names, one at a time", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["admission:issuer", { iss: "https://evil.example" }],
      ["admission:audience", { aud: "https://somebody-else" }],
      ["admission:repository-id", { repository_id: "999" }],
      ["admission:repository-owner-id", { repository_owner_id: "999" }],
      ["admission:event-name", { event_name: "push" }],
      [
        "admission:workflow-ref",
        {
          workflow_ref: "octo/repo/.github/workflows/other.yml@refs/heads/main",
        },
      ],
      [
        "admission:workflow-sha",
        {
          workflow_sha: "1111111111111111111111111111111111111111",
        },
      ],
      [
        "admission:workflow-identity",
        {
          job_workflow_ref: "octo/repo/.github/workflows/other.yml@refs/heads/main",
        },
      ],
    ];
    for (const [expected, overrides] of cases) {
      const stub = executor();
      const claims = { ...VALID_CLAIMS, ...overrides };
      expect(await on(stub, (o) => o.admitConnection({ claims }))).toBe(expected);
      expect(await on(stub, (o) => o.holders())).toBe(0);
    }
  });

  it("accepts an audience array containing the configured one", async () => {
    const stub = executor();
    const claims = { ...VALID_CLAIMS, aud: ["https://other", POLICY.audience] };
    expect(await on(stub, (o) => o.admitConnection({ claims }))).toBe("admitted");
  });

  it("refuses a token that is not a claim set at all", async () => {
    const stub = executor();
    expect(await on(stub, (o) => o.admitConnection({ claims: "a string" }))).toBe(
      "admission:token-malformed",
    );
  });

  it("refuses a run id that could not address an owner", async () => {
    const stub = executor();
    expect(await on(stub, (o) => o.admitConnection({ runId: "" }))).toBe("run-id:run-id-empty");
    expect(await on(stub, (o) => o.admitConnection({ runId: 42 }))).toBe("run-id:run-id-absent");
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });
});

describe("holding an acquisition", () => {
  it("refuses a second healthy executor rather than following it", async () => {
    const stub = executor();
    expect(await on(stub, (o) => o.admitConnection({}))).toBe("admitted");
    expect(await on(stub, (o) => o.admitConnection({}))).toBe("acquisition:already-running");
    expect(await on(stub, (o) => o.holders())).toBe(1);
  });

  it("lets the admitted connection send, and answers what it performed", async () => {
    const stub = executor();
    await on(stub, (o) => o.admitConnection({}));
    expect(
      await on(stub, (o) => o.send(1, JSON.stringify({ id: "1", command: "frontier" }))),
    ).toEqual({ id: "1", outcome: "performed", value: { performed: "frontier" } });
  });

  it("refuses a socket it never admitted", async () => {
    const stub = executor();
    await on(stub, (o) => o.admitConnection({}));
    expect(
      await on(stub, (o) => o.sendAsStranger(JSON.stringify({ id: "1", command: "frontier" }))),
    ).toEqual({ id: "", outcome: "refused", refusal: "acquisition:foreign-connection" });
  });

  it("owns nothing once the connection ends, and rolls nothing back", async () => {
    const stub = executor();
    await on(stub, (o) => o.admitConnection({}));
    await on(stub, (o) => o.closeConnection(1));
    expect(await on(stub, (o) => o.holders())).toBe(0);
    // And the next executor may take it, with no lease having expired.
    expect(await on(stub, (o) => o.admitConnection({}))).toBe("admitted");
  });

  it("proves the acquisition before it reads a command", async () => {
    const stub = executor();
    // Nothing is admitted, so even a well-formed command is refused for
    // ownership rather than for its shape.
    expect(
      await on(stub, (o) => o.sendAsStranger(JSON.stringify({ id: "1", command: "frontier" }))),
    ).toEqual({ id: "", outcome: "refused", refusal: "acquisition:not-acquired" });
  });
});

describe("reading a runner command", () => {
  it("refuses what it cannot read as one", async () => {
    const stub = executor();
    await on(stub, (o) => o.admitConnection({}));
    const refuse = async (raw: string) =>
      (await on(stub, (o) => o.send(1, raw))) as { refusal: string };
    expect((await refuse("not json")).refusal).toBe("command:not-an-object");
    expect((await refuse(JSON.stringify([1, 2]))).refusal).toBe("command:not-an-object");
    expect((await refuse(JSON.stringify({ id: "1", command: "explode" }))).refusal).toBe(
      "command:unknown-command",
    );
    expect((await refuse(JSON.stringify({ id: "1", command: "frontier", extra: 1 }))).refusal).toBe(
      "command:unknown-member",
    );
    expect((await refuse(JSON.stringify({ command: "frontier" }))).refusal).toBe(
      "command:malformed-member",
    );
    expect((await refuse(JSON.stringify({ id: "1", command: "materialize" }))).refusal).toBe(
      "command:malformed-member",
    );
  });

  it("reads a commit intent whole", async () => {
    const stub = executor();
    await on(stub, (o) => o.admitConnection({}));
    const raw = JSON.stringify({
      id: "7",
      command: "commit",
      expectedWorkspaceRootId: "root-a",
      expectedJournalEventId: null,
      content: [{ digest: "d1", bytes: "AAAA" }],
      proposedWorkspaceRootId: "root-b",
      events: ["event-1"],
    });
    expect(await on(stub, (o) => o.send(1, raw))).toEqual({
      id: "7",
      outcome: "performed",
      value: { performed: "commit" },
    });
  });
});

describe("routing a run to its owner", () => {
  it("reaches one object for one run id, without a registry", () => {
    const first = env.EXECUTOR.idFromName(RUN_ID).toString();
    expect(env.EXECUTOR.idFromName(RUN_ID).toString()).toBe(first);
    expect(env.EXECUTOR.idFromName(`${RUN_ID}x`).toString()).not.toBe(first);
  });
});
