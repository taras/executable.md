/**
 * Cross-platform BDD shim for Effection test integration.
 *
 * Provides { describe, it, beforeAll, beforeEach } that work on
 * Deno, Node (`node:test`), and Bun (`bun:test`).
 *
 * Uses @effectionx/test-adapter for Effection scope lifecycle
 * management across all runtimes.
 */

import { createTestAdapter } from "@effectionx/test-adapter";
import type { TestAdapter } from "@effectionx/test-adapter";
import type { Operation } from "effection";

// ---------------------------------------------------------------------------
// Runtime detection + dynamic primitives
// ---------------------------------------------------------------------------

interface TestPrimitives {
  // deno-lint-ignore no-explicit-any
  describe: (name: string, options: any, fn: () => void) => void;
  describeSkip: (name: string, fn: () => void) => void;
  describeOnly: (name: string, fn: () => void) => void;
  it: (desc: string, fn: () => Promise<void>) => void;
  itSkip: (desc: string, fn: () => void) => void;
  itOnly: (desc: string, fn: () => Promise<void>) => void;
  afterAll: (fn: () => void | Promise<void>) => void;
}

let _primitives: TestPrimitives | undefined;

async function getPrimitives(): Promise<TestPrimitives> {
  if (_primitives) return _primitives;

  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;

  if (typeof g.Deno !== "undefined" && g.Deno.test) {
    // Deno runtime — use @std/testing/bdd
    // @ts-ignore: Deno-only module, unreachable on Node/Bun
    const bdd = await import("@std/testing/bdd");
    _primitives = {
      describe: (name, options, fn) => bdd.describe(name, options, fn),
      describeSkip: bdd.describe.skip,
      describeOnly: (name, fn) => bdd.describe.only(name, fn),
      it: (desc, fn) => bdd.it(desc, fn),
      itSkip: (desc, fn) => bdd.it.skip(desc, fn),
      itOnly: (desc, fn) => bdd.it.only(desc, fn),
      afterAll: (fn) => bdd.afterAll(fn),
    };
  } else if (typeof g.Bun !== "undefined") {
    // Bun runtime — use bun:test
    // @ts-ignore: Bun-only module, unreachable on Node/Deno
    const bunTest = await import("bun:test");
    _primitives = {
      describe: (name, _options, fn) => bunTest.describe(name, fn),
      describeSkip: (name, fn) => bunTest.describe.skip(name, fn),
      describeOnly: (name, fn) => bunTest.describe.only(name, fn),
      it: (desc, fn) => bunTest.it(desc, fn),
      itSkip: (desc, fn) => bunTest.it.skip(desc, fn),
      itOnly: (desc, fn) => bunTest.it.only(desc, fn),
      afterAll: (fn) => bunTest.afterAll(fn),
    };
  } else {
    // Node runtime — use node:test
    const nodeTest = await import("node:test");
    _primitives = {
      describe: (name, _options, fn) => nodeTest.describe(name, fn),
      describeSkip: (name, fn) => nodeTest.describe.skip(name, fn),
      describeOnly: (name, fn) => nodeTest.describe.only(name, fn),
      it: (desc, fn) => nodeTest.it(desc, fn),
      itSkip: (desc, fn) => nodeTest.it.skip(desc, fn),
      itOnly: (desc, fn) => nodeTest.it.only(desc, fn),
      afterAll: (fn) => nodeTest.after(fn),
    };
  }

  return _primitives;
}

// Eagerly resolve primitives at module load time.
// On Deno this import is synchronous (already cached); on Node/Bun
// the dynamic import resolves before any test registration.
const primitivesPromise = getPrimitives();
let p: TestPrimitives | undefined;
primitivesPromise.then((v) => {
  p = v;
});

function prims(): TestPrimitives {
  if (!p) {
    throw new Error("Test primitives not yet loaded. This should not happen.");
  }
  return p;
}

// Block until primitives are loaded (covers the async gap on first import).
// deno-lint-ignore no-explicit-any
if (typeof (globalThis as any).Deno !== "undefined") {
  // Deno: synchronous import resolution, p is already set
  p = await primitivesPromise;
} else {
  // Node/Bun: top-level await
  p = await primitivesPromise;
}

// ---------------------------------------------------------------------------
// Effection-aware BDD interface
// ---------------------------------------------------------------------------

let current: TestAdapter | undefined;

export interface DescribeOptions {
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
}

export function describe(name: string, body: () => void): void;
export function describe(name: string, options: DescribeOptions, body: () => void): void;
export function describe(
  name: string,
  optionsOrBody: DescribeOptions | (() => void),
  maybeBody?: () => void,
): void {
  const options = typeof optionsOrBody === "function" ? {} : optionsOrBody;
  const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody!;
  const parent = current;
  const child = createTestAdapter({ name, parent });
  prims().describe(name, options, () => {
    const saved = current;
    current = child;
    try {
      prims().afterAll(() => child.destroy());
      body();
    } finally {
      current = saved;
    }
  });
}

describe.skip = (name: string, fn: () => void): void => {
  prims().describeSkip(name, fn);
};

describe.only = (name: string, fn: () => void): void => {
  const parent = current;
  const child = createTestAdapter({ name, parent });
  prims().describeOnly(name, () => {
    const saved = current;
    current = child;
    try {
      prims().afterAll(() => child.destroy());
      fn();
    } finally {
      current = saved;
    }
  });
};

export function beforeAll(body: () => Operation<void>): void {
  current?.addOnetimeSetup(body);
}

export function beforeEach(body: () => Operation<void>): void {
  current?.addSetup(body);
}

export function it(desc: string, body?: () => Operation<void>): void {
  if (!current) {
    throw new Error("it() must be called within a describe() block");
  }
  const adapter = current;
  if (!body) {
    prims().itSkip(desc, () => {});
    return;
  }
  prims().it(desc, async () => {
    const result = await adapter.runTest(body);
    if (!result.ok) {
      throw result.error;
    }
  });
}

it.skip = (...args: Parameters<typeof it>): ReturnType<typeof it> => {
  const [desc] = args;
  prims().itSkip(desc, () => {});
};

it.only = (desc: string, body: () => Operation<void>): void => {
  if (!current) {
    throw new Error("it.only() must be called within a describe() block");
  }
  const adapter = current;
  prims().itOnly(desc, async () => {
    const result = await adapter.runTest(body);
    if (!result.ok) {
      throw result.error;
    }
  });
};
