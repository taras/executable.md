/**
 * Tier WRH — the host assembly boundary a second host has to satisfy.
 *
 * `WorkflowHost` is four methods, and a remote host is one more implementation
 * of them rather than a wider surface. That is the settled contract, and the
 * way it fails quietly is by growing: a fifth method, or a transitions type only
 * one adapter can name, and the "same four questions" claim stops being true
 * while every existing test still passes.
 *
 * So both halves are pinned here. The key set is compared exactly, and the
 * provider-neutral lifecycle types are imported from the package root — which
 * is where they mean what they mean — so this stops compiling if they retreat
 * behind a runtime-named entrypoint.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import type {
  WorkflowBeginRequest,
  WorkflowExecutionBegun,
  WorkflowExecutionTransitions,
  WorkflowForkRequest,
  WorkflowForkSelection,
  WorkflowRunCreation,
} from "@executablemd/workflow";
import type { WorkflowHost } from "../src/workflow.ts";

/**
 * Compile-time proofs. `Assert<true>` is the only instantiation that checks, so
 * each of these stops compiling the moment its claim becomes false.
 */
type Assert<T extends true> = T;

/** The host boundary is exactly these four methods. */
type FourMethods = Assert<
  keyof WorkflowHost extends "useRunHost" | "useLifecycle" | "useDelivery" | "attach" ? true : false
>;
const FOUR_METHODS: FourMethods = true;

/** Every provider-neutral lifecycle type resolves through the package root. */
type NeutralTypes = Assert<
  [
    WorkflowExecutionTransitions,
    WorkflowBeginRequest,
    WorkflowExecutionBegun,
    WorkflowForkRequest,
    WorkflowForkSelection,
    WorkflowRunCreation,
  ] extends [unknown, unknown, unknown, unknown, unknown, unknown]
    ? true
    : false
>;
const NEUTRAL_TYPES: NeutralTypes = true;

/**
 * A host built only from the four methods and only from root-exported types.
 *
 * It answers nothing — the point is that it type-checks, which is the claim a
 * second adapter depends on.
 */
function neutralHost(): WorkflowHost {
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      throw new Error("not this test's question");
    },
    useLifecycle(): Operation<void> {
      throw new Error("not this test's question");
    },
    useDelivery(): Operation<void> {
      throw new Error("not this test's question");
    },
    attach<T>(_database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return operation;
    },
  };
}

describe("the workflow host boundary", () => {
  it("is exactly four methods", function* () {
    expect(FOUR_METHODS).toEqual(true);
    expect(Object.keys(neutralHost()).toSorted()).toEqual([
      "attach",
      "useDelivery",
      "useLifecycle",
      "useRunHost",
    ]);
  });

  it("is satisfiable from the package root alone", function* () {
    expect(NEUTRAL_TYPES).toEqual(true);
    expect(typeof neutralHost().attach).toEqual("function");
  });
});
