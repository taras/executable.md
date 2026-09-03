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
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutorObject } from "./support/executor-object.ts";
import { POLICY, VALID_CLAIMS } from "./support/executor-object.ts";
import { generateKeys, signToken, tamper, type TestKeys } from "./support/tokens.ts";

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

/** The clock the owner is configured with, so expiry is exact. */
const NOW = 1_800_000_000;

let keys: TestKeys;
let otherKeys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
  otherKeys = await generateKeys("other-key");
});

/** Claims a correctly issued token carries, plus any override. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID_CLAIMS, iat: NOW - 10, nbf: NOW - 10, exp: NOW + 600, ...overrides };
}

/** An owner configured with the real public key, ready to be connected to. */
async function admitted(
  stub: ReturnType<typeof executor>,
  request: Record<string, unknown> = {},
  signWith: TestKeys = keys,
  header: Record<string, unknown> = {},
): Promise<string> {
  await on(stub, (o) => o.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
  const token = "token" in request ? request["token"] : await signToken(signWith, claims(), header);
  return await on(stub, (o) => o.admitConnection({ ...request, token }));
}

describe("admitting an executor", () => {
  it("admits a matching build with authenticated claims", async () => {
    const stub = executor();
    expect(await admitted(stub)).toBe("admitted");
    expect(await on(stub, (o) => o.holders())).toBe(1);
  });

  it("refuses a build the owner did not agree to, before reading the token", async () => {
    const stub = executor();
    // The token is deliberately unusable. If the release were checked after it,
    // the refusal would name the token rather than the build.
    expect(await admitted(stub, { release: "other-build", token: "not a token" })).toBe(
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
      const token = await signToken(keys, claims(overrides));
      expect(await admitted(stub, { token })).toBe(expected);
      expect(await on(stub, (o) => o.holders())).toBe(0);
    }
  });

  it("accepts an audience array containing the configured one", async () => {
    const stub = executor();
    const token = await signToken(keys, claims({ aud: ["https://other", POLICY.audience] }));
    expect(await admitted(stub, { token })).toBe("admitted");
  });

  it("refuses a token whose payload was edited after signing", async () => {
    const stub = executor();
    const token = tamper(await signToken(keys, claims()), claims({ repository_id: "999" }));
    expect(await admitted(stub, { token })).toBe("token:bad-signature");
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });

  it("refuses a token naming a key the deployment does not hold", async () => {
    const stub = executor();
    // Signed by another issuer, and saying so: no configured key is even a
    // candidate, which is a different refusal from one that failed to verify.
    expect(await admitted(stub, {}, otherKeys)).toBe("token:unknown-key");
  });

  it("refuses a token signed with the wrong key under a configured key id", async () => {
    const stub = executor();
    const token = await signToken(otherKeys, claims(), { kid: keys.kid });
    expect(await admitted(stub, { token })).toBe("token:bad-signature");
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });

  it("refuses an algorithm it does not support", async () => {
    const stub = executor();
    const token = await signToken(keys, claims(), { alg: "none" });
    expect(await admitted(stub, { token })).toBe("token:unsupported-algorithm");
  });

  it("refuses a token that is absent or not a compact JWS", async () => {
    const stub = executor();
    expect(await admitted(stub, { token: undefined })).toBe("token:token-absent");
    expect(await admitted(stub, { token: "one.two" })).toBe("token:token-malformed");
  });

  it("requires every temporal claim, rather than treating an absent one as met", async () => {
    for (const missing of ["exp", "iat", "nbf"]) {
      const stub = executor();
      const without = claims();
      delete without[missing];
      expect(await admitted(stub, { token: await signToken(keys, without) })).toBe(
        "token:malformed-claims",
      );
    }
    // And a claim that is present but not a NumericDate.
    for (const wrong of [{ exp: "soon" }, { iat: 1.5 }, { nbf: null }]) {
      const stub = executor();
      expect(await admitted(stub, { token: await signToken(keys, claims(wrong)) })).toBe(
        "token:malformed-claims",
      );
    }
  });

  it("treats the expiration boundary itself as expired", async () => {
    // RFC 7519 wants the current time strictly before `exp`. With no skew, a
    // token expiring exactly now is spent.
    const exact = executor();
    await on(exact, (o) => o.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW));
    const boundary = await signToken(keys, claims({ exp: NOW }));
    expect(
      await on(exact, (o) => o.admitConnection({ token: boundary, release: POLICY.release })),
    ).toBe("token:expired");
  });

  it("requires a key id naming exactly one configured key", async () => {
    const absent = executor();
    expect(
      await admitted(absent, { token: await signToken(keys, claims(), { kid: undefined }) }),
    ).toBe("token:unknown-key");
    const empty = executor();
    expect(await admitted(empty, { token: await signToken(keys, claims(), { kid: "" }) })).toBe(
      "token:unknown-key",
    );
    const unknown = executor();
    expect(
      await admitted(unknown, { token: await signToken(keys, claims(), { kid: "nope" }) }),
    ).toBe("token:unknown-key");
  });

  it("requires the header to say it is a JWT", async () => {
    const stub = executor();
    const token = await signToken(keys, claims(), { typ: "at+jwt" });
    expect(await admitted(stub, { token })).toBe("token:unsupported-type");
  });

  it("refuses a clock configuration it cannot trust", async () => {
    const negative = executor();
    await on(negative, (o) => o.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW, -1));
    expect(
      await on(negative, (o) => o.admitConnection({ release: POLICY.release, token: "a.b.c" })),
    ).toBe("token:misconfigured-clock");

    const huge = executor();
    await on(huge, (o) => o.configure([{ kid: keys.kid, jwk: keys.publicJwk }], NOW, 86_400));
    expect(
      await on(huge, (o) => o.admitConnection({ release: POLICY.release, token: "a.b.c" })),
    ).toBe("token:misconfigured-clock");
  });

  it("refuses a token outside its validity window", async () => {
    const expired = executor();
    expect(
      await admitted(expired, { token: await signToken(keys, claims({ exp: NOW - 3600 })) }),
    ).toBe("token:expired");
    const early = executor();
    expect(
      await admitted(early, { token: await signToken(keys, claims({ nbf: NOW + 3600 })) }),
    ).toBe("token:not-yet-valid");
  });

  it("refuses a run id that could not address an owner", async () => {
    const stub = executor();
    expect(await admitted(stub, { runId: "" })).toBe("run-id:run-id-empty");
    expect(await admitted(stub, { runId: 42 })).toBe("run-id:run-id-absent");
    expect(await on(stub, (o) => o.holders())).toBe(0);
  });
});

describe("holding an acquisition", () => {
  it("refuses a second healthy executor rather than following it", async () => {
    const stub = executor();
    expect(await admitted(stub)).toBe("admitted");
    expect(await admitted(stub)).toBe("acquisition:already-running");
    expect(await on(stub, (o) => o.holders())).toBe(1);
  });

  it("mints its own correlation, which no caller can select or reuse", async () => {
    const first = executor();
    await admitted(first);
    const one = await on(first, (o) => o.acquisitionId());
    await on(first, (o) => o.closeConnection(1));
    await admitted(first);
    const two = await on(first, (o) => o.acquisitionId());

    // Bounded, unpredictable, and different for a second acquisition of the
    // same run — so private staging belonging to the first cannot be addressed
    // by the second.
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(two).toMatch(/^[0-9a-f]{32}$/);
    expect(two).not.toBe(one);
  });

  it("lets the admitted connection send, and answers what it performed", async () => {
    const stub = executor();
    await on(stub, (o) => o.initialize());
    await admitted(stub);
    const answer = await on(stub, (o) =>
      o.send(1, JSON.stringify({ id: "1", command: "frontier" })),
    );
    expect(answer).toMatchObject({ id: "1", outcome: "performed" });
  });

  it("refuses a socket it never admitted", async () => {
    const stub = executor();
    await admitted(stub);
    expect(
      await on(stub, (o) => o.sendAsStranger(JSON.stringify({ id: "1", command: "frontier" }))),
    ).toEqual({ id: "", outcome: "refused", refusal: "acquisition:foreign-connection" });
  });

  it("does not treat copied attachment bytes as an acquisition", async () => {
    const stub = executor();
    await admitted(stub);
    expect(
      await on(stub, (o) =>
        o.sendWithCopiedAttachment(JSON.stringify({ id: "1", command: "frontier" })),
      ),
    ).toEqual({ id: "", outcome: "refused", refusal: "acquisition:foreign-connection" });
  });

  it("owns nothing once the connection ends, and rolls nothing back", async () => {
    const stub = executor();
    await admitted(stub);
    await on(stub, (o) => o.closeConnection(1));
    expect(await on(stub, (o) => o.holders())).toBe(0);
    // And the next executor may take it, with no lease having expired.
    expect(await admitted(stub)).toBe("admitted");
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
    await admitted(stub);
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
    expect((await refuse(JSON.stringify({ id: "1", command: "root" }))).refusal).toBe(
      "command:malformed-member",
    );
  });

  it("reads a commit intent whole, then refuses to act on it in this release", async () => {
    const stub = executor();
    await on(stub, (o) => o.initialize());
    await admitted(stub);
    const raw = JSON.stringify({
      id: "7",
      command: "commit",
      expectedWorkspaceRootId: `a${"0".repeat(63)}`,
      expectedJournalEventId: null,
      proposedWorkspaceRootId: `b${"1".repeat(63)}`,
      events: ["event-1"],
    });
    // The shape is read — an unknown member or a malformed root would refuse
    // differently — and then declined, because applying one is a later
    // checkpoint's work and a performed placeholder would be a lie.
    expect(await on(stub, (o) => o.send(1, raw))).toEqual({
      id: "7",
      outcome: "refused",
      refusal: "command:unavailable",
    });
    expect(
      await on(stub, (o) => o.send(1, JSON.stringify({ ...JSON.parse(raw), id: "8", extra: 1 }))),
    ).toEqual({ id: "", outcome: "refused", refusal: "command:unknown-member" });
  });
});

describe("routing a run to its owner", () => {
  it("reaches one object for one run id, without a registry", () => {
    const first = env.EXECUTOR.idFromName(RUN_ID).toString();
    expect(env.EXECUTOR.idFromName(RUN_ID).toString()).toBe(first);
    expect(env.EXECUTOR.idFromName(`${RUN_ID}x`).toString()).not.toBe(first);
  });
});
