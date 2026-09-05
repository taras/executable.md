/**
 * What a Durable Object's SQLite actually permits.
 *
 * The Cloudflare owner is built on these answers: the schema marker exists
 * because the pragmas are refused, and the owner opens exactly one real
 * transaction and enlists DOFS directly inside it because a reentrant
 * transaction is refused. Both are properties of the runtime rather than of any
 * model of it, so they are asserted here against real workerd — a platform
 * change that moved either one should fail this suite rather than be discovered
 * as a corrupted run.
 *
 * The assertions match categories, not the platform's wording: the exact
 * sentence a runtime uses to refuse is not a contract, and pinning it would
 * make this fail for a rephrasing.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StorageProbeObject } from "./support/probe-object.ts";

function capabilities() {
  const stub = env.STORAGE_PROBE.get(env.STORAGE_PROBE.idFromName("capabilities"));
  return runInDurableObject(stub, (instance: StorageProbeObject) => instance.capabilities());
}

/** A refusal, whatever the runtime called it. */
function refused(answer: string): boolean {
  return answer.startsWith("refused:");
}

/** A refusal the runtime attributed to its authorization layer. */
function unauthorized(answer: string): boolean {
  return refused(answer) && answer.includes("SQLITE_AUTH");
}

/** A refusal directing the caller to the storage transaction API. */
function transactionApiRequired(answer: string): boolean {
  return refused(answer) && answer.includes("transactionSync");
}

describe("Durable Object SQLite storage", () => {
  it("refuses the pragmas the Deno host carries its schema identity in", async () => {
    const found = await capabilities();
    expect(unauthorized(found.applicationIdRead)).toBe(true);
    expect(unauthorized(found.applicationIdWrite)).toBe(true);
    expect(unauthorized(found.userVersionRead)).toBe(true);
    expect(unauthorized(found.userVersionWrite)).toBe(true);
  });

  it("refuses SQL transaction statements, directly and through a nested wrapper", async () => {
    const found = await capabilities();
    expect(transactionApiRequired(found.savepointDirect)).toBe(true);
    expect(transactionApiRequired(found.nestedTransaction)).toBe(true);
    // The one that decides the owner's commit shape: the vendored DOFS opens a
    // transaction of its own for a filesystem write, so calling it inside an
    // owner transaction is a reentrant call and is refused.
    expect(transactionApiRequired(found.filesystemInsideTransaction)).toBe(true);
  });

  it("accepts what the owner is built on instead", async () => {
    const found = await capabilities();
    expect(refused(found.schemaObjects)).toBe(false);
    expect(refused(found.outerTransaction)).toBe(false);
    expect(refused(found.xmdTableDdl)).toBe(false);
    expect(refused(found.dofsSchema)).toBe(false);
    expect(refused(found.dofsFilesystem)).toBe(false);
    // A strict metadata table is what carries the identity the pragmas cannot.
    expect(found.metadataTable).toContain("application_id");
  });
});
