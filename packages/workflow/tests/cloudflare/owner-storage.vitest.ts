/**
 * The owner's storage, on real workerd.
 *
 * Initialization, recognition and the one transaction an owner commit runs
 * inside are all properties of the runtime rather than of a model of it: the
 * marker exists because the pragmas are refused, and the direct DOFS enlistment
 * exists because a reentrant transaction is refused. Each object below gets a
 * fresh name so its storage starts pristine.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OwnerObject } from "./support/owner-object.ts";

let unique = 0;

function owner() {
  unique += 1;
  const name = `owner-${unique}-${Math.random().toString(36).slice(2)}`;
  return env.OWNER.get(env.OWNER.idFromName(name));
}

function on<T>(
  stub: ReturnType<typeof owner>,
  body: (instance: OwnerObject) => T,
): Promise<Awaited<T>> {
  return runInDurableObject(stub, body) as Promise<Awaited<T>>;
}

describe("initializing an owner object", () => {
  it("creates the schema, the DOFS schema, the run row and the marker together", async () => {
    const stub = owner();
    expect(await on(stub, (o) => o.initialize())).toBe("initialized");
    expect(await on(stub, (o) => o.marker())).toEqual([
      { application_id: 0x584d4431, schema_version: 1 },
    ]);
    expect(await on(stub, (o) => o.recognize())).toBe("recognized");
  });

  it("refuses storage that already holds something", async () => {
    const stub = owner();
    await on(stub, (o) => o.addForeignObject());
    expect(await on(stub, (o) => o.initialize())).toBe("refused:foreign");
  });
});

describe("recognizing an owner object", () => {
  it("refuses storage that holds nothing at all", async () => {
    expect(await on(owner(), (o) => o.recognize())).toBe("refused:foreign");
  });

  it("refuses storage carrying objects but no marker", async () => {
    const stub = owner();
    await on(stub, (o) => o.addForeignObject());
    expect(await on(stub, (o) => o.recognize())).toBe("refused:foreign");
  });

  it("refuses another application's identity", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    await on(stub, (o) => o.rewriteMarker(0x11111111, 1));
    expect(await on(stub, (o) => o.recognize())).toBe("refused:foreign");
  });

  it("refuses a version this build does not implement", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    await on(stub, (o) => o.rewriteMarker(0x584d4431, 2));
    expect(await on(stub, (o) => o.recognize())).toBe("refused:unsupported-version");
  });

  it("refuses version zero the same way", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    await on(stub, (o) => o.rewriteMarker(0x584d4431, 0));
    expect(await on(stub, (o) => o.recognize())).toBe("refused:unsupported-version");
  });

  it("refuses a shape that disagrees with what version 1 declares", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    await on(stub, (o) => o.damage("workflow_suspension_answers"));
    expect(await on(stub, (o) => o.recognize())).toBe("refused:corrupt");
  });
});

describe("an owner commit", () => {
  it("publishes DOFS content and WorkflowRun rows together", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    expect(await on(stub, (o) => o.frontier())).toEqual({ status: "running", publishedPaths: 0 });

    expect(await on(stub, (o) => o.commitMixedChange(false))).toBe("committed");
    expect(await on(stub, (o) => o.frontier())).toEqual({
      status: "suspended",
      publishedPaths: 1,
    });
  });

  it("rolls both categories back when the body fails after changing each", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    expect(await on(stub, (o) => o.commitMixedChange(true))).toContain("threw:");

    // Neither the filesystem write nor the row update may survive, and the next
    // operation must not read either of them out of a cache the failed
    // transaction populated.
    expect(await on(stub, (o) => o.frontier())).toEqual({ status: "running", publishedPaths: 0 });
    expect(await on(stub, (o) => o.recognize())).toBe("recognized");
  });

  it("commits after a failed attempt, from the frontier the failure left", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    await on(stub, (o) => o.commitMixedChange(true));
    expect(await on(stub, (o) => o.commitMixedChange(false))).toBe("committed");
    expect(await on(stub, (o) => o.frontier())).toEqual({
      status: "suspended",
      publishedPaths: 1,
    });
  });
});

describe("owner transaction ownership", () => {
  it("refuses a nested transaction on the same storage", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    expect(await on(stub, (o) => o.nestOnSameStorage())).toBe("refused:nested");
  });

  it("does not couple a transaction on one storage to another storage", async () => {
    // A module-level flag would refuse the second transaction because the first
    // was open. Every Durable Object in an isolate shares this module and
    // shares nothing else, so the guard is keyed by the storage it governs.
    const stub = owner();
    await on(stub, (o) => o.initialize());
    expect(await on(stub, (o) => o.transactOnADifferentStorage())).toBe(
      "committed while another storage transacted",
    );
  });

  it("releases the storage however its transaction ended", async () => {
    const stub = owner();
    await on(stub, (o) => o.initialize());
    // A throwing transaction must leave the storage free for the next one.
    await on(stub, (o) => o.commitMixedChange(true));
    expect(await on(stub, (o) => o.commitMixedChange(false))).toBe("committed");
    expect(await on(stub, (o) => o.nestOnSameStorage())).toBe("refused:nested");
  });
});
