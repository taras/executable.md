/**
 * Deno-native BDD shim for @effectionx/bdd.
 *
 * Provides the same { describe, it, beforeAll, beforeEach } interface
 * using @std/testing/bdd as the test primitive backend, and the
 * compiled @effectionx/test-adapter for Effection integration.
 *
 * This exists because @effectionx/bdd's Deno entrypoint (mod.deno.ts)
 * is a TypeScript source file inside node_modules, which Deno refuses
 * to type-strip. This shim uses the compiled dist of test-adapter
 * and Deno-native @std/testing/bdd.
 */

import {
  afterAll as $afterAll,
  describe as $describe,
  it as $it,
} from "@std/testing/bdd";
import { createTestAdapter } from "@effectionx/test-adapter";
import type { TestAdapter } from "@effectionx/test-adapter";
import type { Operation } from "effection";

let current: TestAdapter | undefined;

export function describe(name: string, body: () => void): void {
  const original = current;
  try {
    const child = createTestAdapter({ name, parent: original });
    current = child;
    $describe(name, () => {
      $afterAll(() => child.destroy());
      body();
    });
  } finally {
    current = original;
  }
}

describe.skip = $describe.skip;
describe.only = (name: string, fn: () => void): void => {
  const original = current;
  try {
    const child = createTestAdapter({ name, parent: original });
    current = child;
    $describe.only(name, () => {
      $afterAll(() => child.destroy());
      fn();
    });
  } finally {
    current = original;
  }
};

export function beforeAll(body: () => Operation<void>): void {
  current?.addOnetimeSetup(body);
}

export function beforeEach(body: () => Operation<void>): void {
  current?.addSetup(body);
}

export function it(
  desc: string,
  body?: () => Operation<void>,
): void {
  if (!current) {
    throw new Error("it() must be called within a describe() block");
  }
  const adapter = current;
  if (!body) {
    $it.skip(desc, () => {});
    return;
  }
  $it(desc, async () => {
    const result = await adapter.runTest(body);
    if (!result.ok) {
      throw result.error;
    }
  });
}

it.skip = (...args: Parameters<typeof it>): ReturnType<typeof it> => {
  const [desc] = args;
  return $it.skip(desc, () => {});
};

it.only = (
  desc: string,
  body: () => Operation<void>,
): void => {
  if (!current) {
    throw new Error("it.only() must be called within a describe() block");
  }
  const adapter = current;
  $it.only(desc, async () => {
    const result = await adapter.runTest(body);
    if (!result.ok) {
      throw result.error;
    }
  });
};
