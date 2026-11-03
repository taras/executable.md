import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, withResolvers } from "effection";
import type { Operation, Stream } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { settleStage } from "../../../examples/agent-certification/stage-runner.ts";
import { randomUUID } from "node:crypto";
import {
  Agent,
  agentIdentityComponents,
  installAgentComponents,
  useNormalizedOutput,
} from "@executablemd/core";
import type { AgentPromptEvent } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { createAcpxProvider, createAcpxSessionStore } from "../mod.ts";
import { withCertificationFixture } from "./certification-fixture.ts";
import type { CertificationFixture } from "./certification-fixture.ts";
import {
  initialReport,
  recordMarker,
  recordCancellation,
  configurationFailure,
} from "../../../examples/agent-certification/report.ts";
import type { Report } from "../../../examples/agent-certification/report.ts";
import { observeQualification } from "../../../examples/agent-certification/observe.ts";

function reportFor(command: string): Report {
  return initialReport({
    command,
    scenarios: [
      "acceptance",
      "identity",
      "authentication",
      "streaming",
      "completion",
      "continuity",
      "separation",
      "reconnect",
      "model",
      "effort",
      "cleanup",
    ],
    expected: [],
  });
}
function* document(
  f: CertificationFixture,
  mode: string,
  documentSource: string,
  report: Report,
  failures: unknown[] = [],
  journal = new InMemoryStream(),
): Operation<{ ok: boolean; output: string }> {
  return yield* scoped(function* () {
    const command = mode === "strong" ? "codex" : f.command(mode);
    yield* installAgentComponents({
      defaultAgent: command,
      rootProvider: {
        options: { defaultAgent: command, permissionMode: "deny-all" },
        factory: createAcpxProvider({
          sessionStore: createAcpxSessionStore(join(f.dir, "store")),
          advertiseNativeLaunch: [],
          advertiseClientNativeAttachment: [],
          agentRegistry:
            mode === "strong" ? { list: () => ["codex"], resolve: () => f.command() } : undefined,
          nativeAdapters:
            mode === "no-acceptance" || mode === "strong"
              ? {
                  [command]: {
                    launcher: "fake",
                    identity: "provider-returned",
                    acceptance: "first-turn-acceptance",
                    resume: () => [],
                  },
                }
              : {},
          *agentCwd() {
            return f.dir;
          },
        }),
      },
    });
    yield* observeQualification(report);
    yield* Agent.around({
      *session(args, next) {
        try {
          return yield* next(...args);
        } catch (error) {
          failures.push(configurationFailure(error));
          throw error;
        }
      },
      *prompt(args, next) {
        const source = yield* next(...args);
        const observed: Stream<AgentPromptEvent, string> = {
          *[Symbol.iterator]() {
            try {
              return yield* source;
            } catch (error) {
              failures.push(configurationFailure(error));
              throw error;
            }
          },
        };
        return observed;
      },
    });
    yield* useNormalizedOutput();
    const path = join(f.dir, "document.md");
    yield* writeTextFile(path, documentSource);
    const execution = yield* executeInstalled({ path, stream: journal }, [
      { components: agentIdentityComponents() },
    ]);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { ok: result.ok, output: next.value.trim() };
  });
}

describe(
  "production local-agent qualification controls",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("recovers a private marker in sequential Prompts and keeps another Session independent", function* () {
      yield* withCertificationFixture(function* (f) {
        const marker = randomUUID();
        const report = reportFor(f.command());
        const result = yield* document(
          f,
          "standard",
          `<Session name="a"><Prompt text="seed:${marker}" as="ack" /><Prompt text="recall" /></Session>\nSEPARATION\n<Session name="b"><Prompt text="recall" /></Session>`,
          report,
        );
        expect(result.ok).toBe(true);
        const [recall, independent] = result.output.split("SEPARATION").map((text) => text.trim());
        recordMarker(report, "continuity", marker, recall, true);
        recordMarker(report, "separation", marker, independent, true);
        expect(report.capabilities.continuity.outcome).toBe("pass");
        expect(report.capabilities.separation.outcome).toBe("pass");
        expect(report.capabilities.streaming.outcome).toBe("pass");
        expect(report.capabilities.acceptance).toMatchObject({
          outcome: "unsupported",
          reason: "acceptance-unavailable",
        });
        expect(report.capabilities.identity.outcome).toBe("unsupported");
        expect(report.capabilities.model.outcome).toBe("not_run");
        expect(report.capabilities.effort.outcome).toBe("not_run");
        expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(3);
      });
    });
    for (const mode of ["lost", "shared"]) {
      it(`detects ${mode} marker history`, function* () {
        yield* withCertificationFixture(function* (f) {
          const marker = randomUUID();
          const report = reportFor(f.command(mode));
          const result = yield* document(
            f,
            mode,
            `<Session name="a"><Prompt text="seed:${marker}" as="ack" /><Prompt text="recall" /></Session>\nSEPARATION\n<Session name="b"><Prompt text="recall" /></Session>`,
            report,
          );
          expect(result.ok).toBe(true);
          const [recall, independent] = result.output
            .split("SEPARATION")
            .map((text) => text.trim());
          recordMarker(report, "continuity", marker, recall, true);
          recordMarker(report, "separation", marker, independent, true);
          expect(
            mode === "lost"
              ? report.capabilities.continuity.outcome
              : report.capabilities.separation.outcome,
          ).toBe("failure");
        });
      });
    }
    it("reconnects the accepted conversation and reapplies exact settings", function* () {
      yield* withCertificationFixture(function* (f) {
        const marker = randomUUID();
        const report = reportFor(f.command());
        const first = yield* document(
          f,
          "normal",
          `<Session name="a" model="selected" effort="high"><Prompt text="seed:${marker}" /></Session>`,
          report,
        );
        expect(first.ok).toBe(true);
        expect(report.capabilities.model.outcome).toBe("pass");
        expect(report.capabilities.effort.outcome).toBe("pass");
        const next = yield* document(
          f,
          "normal",
          '<Session name="a" model="selected" effort="high"><Prompt text="recall" /></Session>',
          report,
        );
        expect(next.ok).toBe(true);
        expect(report.capabilities.model.outcome).toBe("pass");
        expect(report.capabilities.effort.outcome).toBe("pass");
        expect(next.output).toBe(marker);
        recordMarker(report, "reconnect", marker, next.output, true);
        expect(report.capabilities.reconnect.outcome).toBe("pass");
        expect((yield* f.methods()).filter((method) => method === "session/new").length).toBe(1);
        expect((yield* f.methods()).includes("session/load")).toBe(true);
      });
    });
    for (const setting of ["model", "effort"]) {
      for (const kind of ["absent", "mismatch"]) {
        it(`reports exact ${setting} ${kind} evidence before any Prompt`, function* () {
          yield* withCertificationFixture(function* (f) {
            const mode = kind + "-" + setting;
            const report = reportFor(f.command(mode));
            const failures: unknown[] = [];
            const value = setting === "model" ? "selected" : "high";
            const result = yield* document(
              f,
              mode,
              `<Session name="target" ${setting}="${value}"><Prompt text="must not send" /></Session>`,
              report,
              failures,
            );
            expect(result.ok).toBe(false);
            expect(failures).toEqual([
              {
                reason: kind === "absent" ? "selector-unavailable" : "configuration-mismatch",
                setting,
              },
            ]);
            const row =
              setting === "model" ? report.capabilities.model : report.capabilities.effort;
            expect(row.outcome).toBe(kind === "absent" ? "unsupported" : "failure");
            expect((yield* f.methods()).includes("session/prompt")).toBe(false);
            expect(JSON.stringify(report)).not.toContain("must not send");
          });
        });
      }
    }
    it("does not disclose a turn whose backend never accepted creation", function* () {
      yield* withCertificationFixture(function* (f) {
        const report = reportFor(f.command("no-acceptance"));
        const marker = randomUUID();
        const result = yield* document(
          f,
          "no-acceptance",
          `<Session name="a"><Prompt text="seed:${marker}" /></Session>`,
          report,
        );
        expect(result.ok).toBe(false);
        expect(result.output).not.toContain(marker);
        expect(report.capabilities.completion.outcome).not.toBe("pass");
        expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(1);
      });
    });
    it("attributes the owned still-active turn to HostExecution.stop without certifying native cleanup", function* () {
      yield* withCertificationFixture(function* (f) {
        const command = f.command("standard-wait");
        const report = reportFor(command);
        report.capabilities.cancellation.selected = true;
        yield* scoped(function* () {
          yield* installAgentComponents({
            defaultAgent: command,
            rootProvider: {
              options: { defaultAgent: command, permissionMode: "deny-all" },
              factory: createAcpxProvider({
                sessionStore: createAcpxSessionStore(join(f.dir, "store")),
                *agentCwd() {
                  return f.dir;
                },
              }),
            },
          });
          const started = withResolvers<void>();
          let terminal = false;
          yield* Agent.around({
            *prompt(args, next) {
              const source = yield* next(...args);
              const observed: Stream<AgentPromptEvent, string> = {
                *[Symbol.iterator]() {
                  const subscription = yield* source;
                  return {
                    *next() {
                      const event = yield* subscription.next();
                      if (!event.done && event.value.type === "started") {
                        started.resolve();
                      }
                      if (!event.done && event.value.type === "terminal") {
                        terminal = true;
                      }
                      return event;
                    },
                  };
                },
              };
              return observed;
            },
          });
          const path = join(f.dir, "cancel.md");
          yield* writeTextFile(
            path,
            '<Session name="owned-test-turn"><Prompt text="wait for suite cancellation" /></Session>',
          );
          const journal = new InMemoryStream();
          const execution = yield* executeInstalled({ path, stream: journal }, [
            { components: agentIdentityComponents() },
          ]);
          const subscription = yield* execution.output;
          const draining = yield* spawn(function* () {
            while (!(yield* subscription.next()).done) {}
          });
          yield* started.operation;
          const activeAtStop = !terminal;
          const stop = yield* execution.stop();
          const completion = yield* execution;
          yield* draining;
          expect(stop.ok).toBe(true);
          expect(completion.ok).toBe(false);
          const events = journal.snapshot();
          const interrupted = events.some(
            (event) => event.type === "close" && event.result.status === "cancelled",
          );
          expect(interrupted).toBe(true);
          recordCancellation(report, {
            requestedStop: true,
            activeAtStop,
            attributed: stop.ok && interrupted,
            completed: terminal,
            ownerJoined: true,
            nativeCleanupVerified: false,
          });
          expect(report.capabilities.cancellation.observations.attributed).toBe(true);
          expect(report.capabilities.cancellation.reason).toBe("cleanup-unverified");
          const methods = yield* f.methods();
          expect(methods.filter((method) => method === "session/prompt").length).toBe(1);
          expect(methods.includes("session/cancel")).toBe(true);
        });
      });
    });
    it("observes eager configuration refusal on the established Session", function* () {
      yield* withCertificationFixture(function* (f) {
        const report = reportFor(f.command("absent-effort"));
        const failures: unknown[] = [];
        const result = yield* document(
          f,
          "absent-effort",
          '<Session name="target"><Prompt text="seed:private" as="ack" /></Session><Session name="target" effort="high"><Prompt text="must not send" /></Session>',
          report,
          failures,
        );
        expect(result.ok).toBe(false);
        expect(failures).toEqual([{ reason: "selector-unavailable", setting: "effort" }]);
        expect(report.capabilities.effort.outcome).toBe("unsupported");
        expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(1);
      });
    });
    it("joins a held finalizer before publication and preserves a cleanup failure", function* () {
      const report = reportFor("controlled");
      const entered = withResolvers<void>();
      const release = withResolvers<void>();
      let finalized = false;
      let laterAdmissions = 0;
      const admission = { open: true };
      yield* ensure(() => {
        release.resolve();
      });
      const task = yield* spawn(function* () {
        yield* settleStage(report, admission, function* () {
          yield* ensure(function* () {
            entered.resolve();
            yield* release.operation;
          });
        });
        finalized = true;
        if (admission.open) {
          laterAdmissions++;
        }
      });
      yield* entered.operation;
      expect(finalized).toBe(false);
      expect(laterAdmissions).toBe(0);
      expect(report.capabilities.cleanup.observations.ownerJoined).toBe(false);
      release.resolve();
      yield* task;
      expect(finalized).toBe(true);
      expect(laterAdmissions).toBe(1);
      expect(report.capabilities.cleanup.reason).toBe("cleanup-unverified");
      const original = new Error("private-cleanup-failure");
      const failed = yield* settleStage(report, admission, function* () {
        yield* ensure(() => {
          throw original;
        });
      });
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error).toBe(original);
      }
      if (admission.open) {
        laterAdmissions++;
      }
      expect(admission.open).toBe(false);
      expect(laterAdmissions).toBe(1);
      expect(report.capabilities.cleanup.outcome).toBe("failure");
    });
  },
);

describe("standard completed replay", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("completed standard output replays without provider requests", function* () {
    yield* withCertificationFixture(function* (f) {
      const journal = new InMemoryStream();
      const source = '<Session name="replay"><Prompt text="seed:retained" /></Session>';
      const first = yield* document(
        f,
        "standard",
        source,
        reportFor(f.command("standard")),
        [],
        journal,
      );
      expect(first.ok).toBe(true);
      const calls = yield* f.calls();
      const replay = yield* document(
        f,
        "standard",
        source,
        reportFor(f.command("standard")),
        [],
        journal,
      );
      expect(replay).toEqual(first);
      expect(yield* f.calls()).toEqual(calls);
    });
  });
});

describe("strong qualification evidence", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("reports declared acceptance and asserted identity independently", function* () {
    yield* withCertificationFixture(function* (f) {
      const report = reportFor("codex");
      expect(
        (yield* document(
          f,
          "strong",
          '<Session name="strong"><Prompt text="seed:private" /></Session>',
          report,
        )).ok,
      ).toBe(true);
      expect(report.capabilities.acceptance.outcome).toBe("pass");
      expect(report.capabilities.identity.outcome).toBe("pass");
    });
  });
});
