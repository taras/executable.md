/**
 * The Worker the workerd suite runs against.
 *
 * It exists to publish the Durable Object classes under test and nothing else:
 * the tests reach those objects through `runInDurableObject()` and their own
 * stubs, so this handler answers no request a test depends on.
 */

export { StorageProbeObject } from "./support/probe-object.ts";
export { OwnerObject } from "./support/owner-object.ts";

export default {
  fetch(): Response {
    return new Response("workflow owner test worker", { status: 200 });
  },
};
