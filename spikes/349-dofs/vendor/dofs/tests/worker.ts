// Minimal worker + DO shim used by the workerd-backed test runner.
// The DO exists solely so vitest-pool-workers can hand a real
// DurableObjectStorage instance to test callbacks via
// runInDurableObject(). The DO doesn't expose any externally useful
// surface; it lives under tests/ so it stays outside the package's
// public exports.

import { DurableObject } from "cloudflare:workers";

export interface TestBindings {
  TestStorage: DurableObjectNamespace;
}

export class TestStorage extends DurableObject<TestBindings> {
  // No methods of our own; tests reach in via runInDurableObject() and
  // use this.ctx.storage directly.
}

// The pool requires a default export so it can spin up a worker.
// We don't route any traffic through it.
export default {
  async fetch(): Promise<Response> {
    return new Response("dofs test worker", { status: 200 });
  },
} satisfies ExportedHandler<TestBindings>;
