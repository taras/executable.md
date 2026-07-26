/**
 * Tier AG — provider registry, permission policies, and the components
 * that scope them (specs/acp-client-spec.md §Components, §Permissions).
 *
 * Everything is driven through Context Api middleware and recording
 * provider factories — no subprocess, no real provider. CLI precedence is
 * not established here; it is asserted at the CLI boundary.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { Component } from "../src/component-api.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { PermissionOutcome, PermissionRequest } from "../src/agent/agent-api.ts";
import { AgentProviders, registerAgentProvider } from "../src/agent/provider-api.ts";
import type { AgentProviderFactory, AgentProviderOptions } from "../src/agent/provider-api.ts";
import {
  installApproveAll,
  installApproveReads,
  installAskPermission,
} from "../src/agent/permission.ts";
import { installAgentComponents } from "../src/agent/components.ts";

/** A provider factory that records the options it is handed. */
function recordingFactory(seen: AgentProviderOptions[]): AgentProviderFactory {
  return function* (options) {
    seen.push(options);
    yield* Agent.around(
      {
        *agent([name]) {
          return name ?? options.defaultAgent;
        },
        *session([name]) {
          return { sessionKey: `rec:${name ?? "default"}`, cwd: "/rec" };
        },
        *prompt([content]) {
          return {
            *[Symbol.iterator]() {
              return {
                *next() {
                  return { done: true, value: `[${content}]` };
                },
              };
            },
          };
        },
      },
      { at: "min" },
    );
  };
}

function* runDoc(
  doc: string,
  install: () => Operation<void>,
): Operation<{ output: string; result: Result<string> }> {
  const dir = path.join(os.tmpdir(), `xmd-ag-${randomUUID()}`);
  yield* ensureDir(dir);
  try {
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    yield* install();
    const execution = yield* execute({ docPath, stream: new InMemoryStream() });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { output: next.value, result };
  } finally {
    yield* rm(dir, { recursive: true, force: true });
  }
}

const OPTIONS: PermissionRequest["options"] = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

function permissionRequest(kind?: string): PermissionRequest {
  const toolCall: PermissionRequest["toolCall"] = { toolCallId: "call-1" };
  if (kind !== undefined) {
    toolCall.kind = kind;
  }
  return {
    session: { sessionKey: "s", cwd: "/w" },
    toolCall,
    options: [...OPTIONS],
  };
}

function* decide(kind?: string): Operation<PermissionOutcome> {
  return yield* Agent.operations.requestPermission(permissionRequest(kind));
}

/**
 * An `<Ask />` component that requests permission where it appears and
 * records the decision, so a policy's reach can be observed inside and
 * outside a component body.
 */
function* installAskComponent(outcomes: string[]): Operation<void> {
  yield* Component.around({
    *expand([element], next) {
      if (element.name === "Ask") {
        const outcome = yield* decide();
        outcomes.push(outcome.outcome === "selected" ? outcome.optionId : "cancelled");
        return { segments: [] };
      }
      return yield* next(element);
    },
  });
}

describe("Tier AG — provider registry and permission policies", () => {
  it("AG1: a registered name resolves to its factory; an unknown name throws", function* () {
    const seen: AgentProviderOptions[] = [];
    yield* registerAgentProvider("stub", recordingFactory(seen));
    expect(typeof (yield* AgentProviders.operations.resolve("stub"))).toBe("function");

    let message = "";
    try {
      yield* AgentProviders.operations.resolve("bogus");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Unknown agent provider "bogus"');
  });

  it("AG2: a nested registration shadows the same name only; siblings resolve outward", function* () {
    const outer: AgentProviderOptions[] = [];
    const inner: AgentProviderOptions[] = [];
    const outerFactory = recordingFactory(outer);
    yield* registerAgentProvider("shared", outerFactory);
    yield* registerAgentProvider("outer-only", outerFactory);

    yield* scoped(function* () {
      const innerFactory = recordingFactory(inner);
      yield* registerAgentProvider("shared", innerFactory);
      expect(yield* AgentProviders.operations.resolve("shared")).toBe(innerFactory);
      expect(yield* AgentProviders.operations.resolve("outer-only")).toBe(outerFactory);
    });

    expect(yield* AgentProviders.operations.resolve("shared")).toBe(outerFactory);
  });

  it("AG3: deny-all denies through the base; approve-all selects an allow option", function* () {
    expect(yield* decide()).toEqual({ outcome: "selected", optionId: "reject-once" });

    yield* scoped(function* () {
      yield* installApproveAll();
      expect(yield* decide()).toEqual({ outcome: "selected", optionId: "allow-once" });
    });
  });

  it("AG4: approve-reads approves reads and searches, and denies other kinds without a TTY", function* () {
    yield* installApproveReads();
    expect(yield* decide("read")).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(yield* decide("search")).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(yield* decide("edit")).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("AG5: a policy with no allow option available denies", function* () {
    yield* installApproveAll();
    const rejectOnly: PermissionRequest = {
      session: { sessionKey: "s", cwd: "/w" },
      toolCall: { toolCallId: "call-1" },
      options: [{ optionId: "reject-always", name: "Never", kind: "reject_always" }],
    };
    expect(yield* Agent.operations.requestPermission(rejectOnly)).toEqual({
      outcome: "selected",
      optionId: "reject-always",
    });
  });

  it("AG6: an undecided policy denies rather than deferring to an enclosing policy", function* () {
    // The nested ask policy cannot select without a TTY. Delegating through
    // next() would reach the enclosing approve-all and wrongly approve.
    yield* installApproveAll();
    yield* scoped(function* () {
      yield* installAskPermission();
      expect(yield* decide()).toEqual({ outcome: "selected", optionId: "reject-once" });
    });
    expect(yield* decide()).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("AG7: <ApproveAll> approves inside its body under an enclosing deny", function* () {
    const outcomes: string[] = [];
    const { result } = yield* runDoc(
      ["<Ask />", "", "<ApproveAll>", "<Ask />", "</ApproveAll>", "", "<Ask />", ""].join("\n"),
      function* () {
        yield* installAskComponent(outcomes);
        yield* installAgentComponents();
      },
    );
    expect(result.ok).toBe(true);
    expect(outcomes).toEqual(["reject-once", "allow-once", "reject-once"]);
  });

  it("AG8: <AskPermission> denies inside its body under an enclosing approve-all", function* () {
    const outcomes: string[] = [];
    const { result } = yield* runDoc(
      ["<Ask />", "", "<AskPermission>", "<Ask />", "</AskPermission>", "", "<Ask />", ""].join(
        "\n",
      ),
      function* () {
        yield* installAskComponent(outcomes);
        yield* installApproveAll();
        yield* installAgentComponents();
      },
    );
    expect(result.ok).toBe(true);
    expect(outcomes).toEqual(["allow-once", "reject-once", "allow-once"]);
  });

  it("AG9: installAgentComponents seeds the default agent and permission mode", function* () {
    const seen: AgentProviderOptions[] = [];
    const { result } = yield* runDoc('<AgentProvider name="rec" />\n', function* () {
      yield* registerAgentProvider("rec", recordingFactory(seen));
      yield* installAgentComponents({
        defaultAgent: "seeded-agent",
        permissionMode: "approve-reads",
      });
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ defaultAgent: "seeded-agent", permissionMode: "approve-reads" }]);
  });

  it("AG10: <AgentProvider defaultAgent> overrides inside its body and restores after", function* () {
    const seen: AgentProviderOptions[] = [];
    const { result } = yield* runDoc(
      [
        '<AgentProvider name="rec" defaultAgent="scoped-agent">',
        "inside",
        "</AgentProvider>",
        '<AgentProvider name="rec" />',
        "",
      ].join("\n"),
      function* () {
        yield* registerAgentProvider("rec", recordingFactory(seen));
        yield* installAgentComponents({
          defaultAgent: "seeded-agent",
          permissionMode: "deny-all",
        });
      },
    );
    expect(result.ok).toBe(true);
    expect(seen.map((options) => options.defaultAgent)).toEqual(["scoped-agent", "seeded-agent"]);
    // permissionMode is inherited, never overridden by a prop.
    expect(seen.every((options) => options.permissionMode === "deny-all")).toBe(true);
  });

  it("AG11: an unknown <AgentProvider> fails the execution; no body or later content renders", function* () {
    const seen: AgentProviderOptions[] = [];
    const { output, result } = yield* runDoc(
      [
        '<AgentProvider name="bogus">',
        "INSIDE_MARKER",
        "</AgentProvider>",
        "AFTER_MARKER",
        "",
      ].join("\n"),
      function* () {
        yield* registerAgentProvider("rec", recordingFactory(seen));
        yield* installAgentComponents({ defaultAgent: "seeded-agent" });
      },
    );
    expect(result.ok).toBe(false);
    expect(output).not.toContain("INSIDE_MARKER");
    expect(output).not.toContain("AFTER_MARKER");
    expect(seen.length).toBe(0);
  });

  it("AG12: <AgentProvider> without any default agent fails before its body expands", function* () {
    const seen: AgentProviderOptions[] = [];
    const { output, result } = yield* runDoc(
      ['<AgentProvider name="rec">', "INSIDE_MARKER", "</AgentProvider>", ""].join("\n"),
      function* () {
        yield* registerAgentProvider("rec", recordingFactory(seen));
        yield* installAgentComponents();
      },
    );
    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("no default agent");
    expect(output).not.toContain("INSIDE_MARKER");
    expect(seen.length).toBe(0);
  });
});
