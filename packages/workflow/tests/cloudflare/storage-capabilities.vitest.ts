import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { StorageProbeObject } from "../../src/cloudflare/probe-object.ts";

it("reports what real Durable Object SQLite storage accepts", async () => {
  const id = env.STORAGE_PROBE.idFromName("capabilities");
  const stub = env.STORAGE_PROBE.get(id);
  const capabilities = await runInDurableObject(stub, (instance: StorageProbeObject) =>
    instance.capabilities(),
  );
  // Printed rather than asserted: this test exists to establish the contract
  // the owner is written against, and a hard assertion here would encode a
  // guess about an answer nobody has yet.
  console.log(JSON.stringify(capabilities, null, 2));
  expect(capabilities).toBeTruthy();
});
