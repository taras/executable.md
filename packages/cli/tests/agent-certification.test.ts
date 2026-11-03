import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withCertificationFixture } from "../../acp/tests/certification-fixture.ts";
import { reportSchema } from "../../../examples/agent-certification/report.ts";

const example = fileURLToPath(new URL("../../../examples/agent-certification/", import.meta.url));
describe(
  "local agent certification CLI journey",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("reuses two local configurations in certification and ordinary separate OS invocations", function* () {
      for (const mode of ["normal", "second-local-agent"]) {
        yield* withCertificationFixture(function* (f) {
          const config = join(f.dir, "local.json");
          const reportPath = join(f.dir, "report.json");
          yield* writeTextFile(
            config,
            JSON.stringify({
              command: f.command(mode),
              model: "selected",
              effort: "high",
              scenarios: [
                "authentication",
                "streaming",
                "separation",
                "model",
                "effort",
                "completion",
                "continuity",
                "cleanup",
                "reconnect",
                "cancellation",
                "resume",
              ],
              expected: ["completion"],
            }),
          );
          const result = yield* runCli(
            [
              "run",
              join(example, "certify.md"),
              "--include",
              join(example, "components"),
              "--props-config",
              config,
              "--props-report",
              reportPath,
              "--deny-all",
              "--raw",
            ],
            { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
          ).join();
          expect([result.code, result.stderr]).toEqual([0, ""]);
          for (const name of [
            "authentication",
            "streaming",
            "completion",
            "continuity",
            "separation",
            "model",
            "effort",
            "reconnect",
            "cancellation",
            "cleanup",
            "resume",
          ]) {
            expect(result.stdout).toContain(`${name} |`);
          }
          expect(result.stdout).not.toContain(f.dir);
          const report = reportSchema.parse(JSON.parse(yield* readTextFile(reportPath)));
          expect(report.complete).toBe(false);
          expect(report.durableSessionCertified).toBe(false);
          expect(report.counts.prompts).toBe(6);
          expect(report.capabilities.cleanup.reason).toBe("cleanup-unverified");
          const methods = yield* f.methods();
          expect(methods.filter((method) => method === "session/prompt").length).toBe(6);
          expect(methods.filter((method) => method === "session/cancel").length).toBe(1);
          expect(
            methods.filter((method) => method === "session/load").length,
          ).toBeGreaterThanOrEqual(2);
          for (const name of [
            "authentication",
            "streaming",
            "completion",
            "continuity",
            "separation",
            "model",
            "effort",
            "reconnect",
            "resume",
          ] satisfies (keyof typeof report.capabilities)[]) {
            expect(report.capabilities[name].outcome).toBe("pass");
          }
          expect(report.capabilities.cancellation.observations.attributed).toBe(true);
          const turns = (yield* f.calls()).filter((call) => call.method === "session/prompt");
          expect(turns.map((turn) => turn.kind)).toEqual([
            "seed",
            "recall",
            "recall",
            "recall",
            "cancel",
            "recall",
          ]);
          expect(turns[0].sessionId).toBe(turns[1].sessionId);
          expect(turns[0].sessionId).not.toBe(turns[2].sessionId);
          expect(turns[0].sessionId).toBe(turns[3].sessionId);
          expect(turns[0].sessionId).toBe(turns[5].sessionId);
          expect(turns[0].sessionId).not.toBe(turns[4].sessionId);

          const marker = randomUUID();
          for (const prompt of ["seed:" + marker, "recall"]) {
            const ordinary = yield* runCli(
              [
                "run",
                join(example, "orchestrate.md"),
                "--include",
                join(example, "components"),
                "--props-config",
                config,
                "--props-prompt",
                prompt,
                "--deny-all",
                "--raw",
              ],
              { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
            ).join();
            expect(ordinary.code).toBe(0);
            expect(ordinary.stdout.trim()).toBe(prompt === "recall" ? marker : "READY");
          }
          expect((yield* f.methods()).filter((method) => method === "session/prompt").length).toBe(
            8,
          );
        });
      }
    });

    for (const mode of ["no-acceptance", "lost"]) {
      it(`runs the actual document with ${mode} without fabricating capability evidence`, function* () {
        yield* withCertificationFixture(function* (f) {
          const config = join(f.dir, "negative.json");
          const target = join(f.dir, "negative-report.json");
          yield* writeTextFile(
            config,
            JSON.stringify({
              command: f.command(mode),
              scenarios: [
                "authentication",
                "streaming",
                "completion",
                "continuity",
                "separation",
                "reconnect",
                "cancellation",
                "cleanup",
                "resume",
              ],
              expected: ["completion"],
            }),
          );
          const result = yield* runCli(
            [
              "run",
              join(example, "certify.md"),
              "--include",
              join(example, "components"),
              "--props-config",
              config,
              "--props-report",
              target,
              "--deny-all",
              "--raw",
            ],
            { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
          ).join();
          expect(result.code).toBe(1);
          const report = reportSchema.parse(JSON.parse(yield* readTextFile(target)));
          expect(report.selectedCapabilitiesPassed).toBe(false);
          expect(report.durableSessionCertified).toBe(false);
          const calls = yield* f.calls();
          const turns = calls.filter((call) => call.method === "session/prompt");
          if (mode === "no-acceptance") {
            expect(turns.length).toBe(1);
            expect(calls.filter((call) => call.method === "session/load").length).toBe(0);
            expect(report.capabilities.authentication.outcome).not.toBe("pass");
            expect(report.capabilities.resume.outcome).toBe("not_run");
          } else {
            expect(turns.map((turn) => turn.kind)).toEqual([
              "seed",
              "recall",
              "recall",
              "recall",
              "cancel",
              "recall",
            ]);
            expect(report.capabilities.completion.outcome).toBe("pass");
            expect(report.capabilities.continuity.outcome).toBe("failure");
            expect(report.capabilities.cancellation.observations.attributed).toBe(true);
            expect(calls.filter((call) => call.method === "session/cancel").length).toBe(1);
          }
          for (const [name] of Object.entries(report.capabilities)) {
            expect(result.stderr).toContain(`${name} |`);
          }
          expect(result.stderr).not.toContain(f.dir);
        });
      });
    }
    it("writes a precise non-pass for a bad local command", function* () {
      yield* withCertificationFixture(function* (f) {
        const config = join(f.dir, "bad.json");
        const report = join(f.dir, "bad-report.json");
        yield* writeTextFile(
          config,
          JSON.stringify({
            command: "xmd-certainly-missing-certification-agent",
            scenarios: ["authentication", "cleanup"],
            expected: ["authentication"],
          }),
        );
        const result = yield* runCli(
          [
            "run",
            join(example, "certify.md"),
            "--include",
            join(example, "components"),
            "--props-config",
            config,
            "--props-report",
            report,
            "--deny-all",
            "--raw",
          ],
          { cwd: f.dir, env: { HOME: f.home }, timeout: 120_000 },
        ).join();
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("authentication |");
        const outcome = reportSchema.parse(JSON.parse(yield* readTextFile(report)));
        expect(outcome.capabilities.authentication.outcome).toBe("failure");
        expect(outcome.capabilities.authentication.reason).toBe("agent-unavailable");
        expect(JSON.stringify(outcome)).not.toContain("xmd-certainly-missing");
        expect(yield* f.methods()).toEqual([]);
      });
    });
  },
);

describe("nested qualification teardown", { sanitizeOps: false, sanitizeResources: false }, () => {
  for (const stage of ["initial", "resume"]) {
    for (const fault of stage === "initial"
      ? ["throw", "delay", "body-delay"]
      : ["throw", "delay"]) {
      it(`${stage} ${fault} preserves nested cleanup evidence and admission`, function* () {
        yield* withCertificationFixture(function* (f) {
          const faultSource = `
import {AgentProviders,content} from "@executablemd/core";
import {ensure,sleep} from "effection";
import {writeTextFile} from "@effectionx/fs";
export function* install() {
 let admitted=false;
 yield* AgentProviders.around({*install(args,next) {
   const call=args[0];
   if(call.intent === "install" && call.name === "acpx" && !admitted) {
     admitted=true;
     ${fault === "body-delay" ? "yield* sleep(31_000);" : ""}
     yield* ensure(function* () {
       ${fault === "delay" ? "yield* sleep(31_000);" : ""}
       yield* writeTextFile(${JSON.stringify(join(f.dir, "joined.txt"))},"joined");
       ${fault === "throw" ? 'throw new Error("controlled nested provider teardown");' : ""}
     });
   }
   return yield* next(...args);
 }});
}
export default function* CleanupFault(){yield* install();return yield* content();}
`;
          yield* writeTextFile(join(f.dir, "CleanupFault.ts"), faultSource);
          const resume = yield* readTextFile(join(example, "stages/resume.md"));
          const end = resume.indexOf("\n---\n") + 5;
          yield* writeTextFile(
            join(f.dir, "child.md"),
            resume.slice(0, end) + "<CleanupFault>\n" + resume.slice(end) + "\n</CleanupFault>",
          );
          yield* writeTextFile(
            join(f.dir, "Probe.ts"),
            `
import {Qualification} from ${JSON.stringify(join(example, "state.ts"))};
import {initialReport} from ${JSON.stringify(join(example, "report.ts"))};
import {runSequence} from ${JSON.stringify(join(example, "stage-runner.ts"))};
import {writeTextFile,readTextFile} from "@effectionx/fs";
import {API} from "@executablemd/runtime";
import {randomUUID} from "node:crypto";
import {install} from "./CleanupFault.ts";
export const props={type:"object",properties:{command:{type:"string"},report:{type:"string"}},required:["command","report"]};
export default function* Probe(input) {
 const configuration={command:input.command,scenarios:["authentication","completion","cleanup","resume"],expected:[]};
 const id=randomUUID();
 const state={configuration,report:initialReport(configuration),marker:randomUUID(),names:{a:"a-"+id,b:"b-"+id,c:"c-"+id},seedAccepted:false,turn:{accepted:false,completed:false}};
 yield* Qualification.set(state);
 ${stage === "initial" ? "yield* install();" : `yield* API.Env.around({*command(args,next){const argv=yield* next(...args);const index=argv.findIndex(value=>value.endsWith("/stages/resume.md"));if(index>=0){argv[index]=${JSON.stringify(join(f.dir, "child.md"))};argv.push("--include",${JSON.stringify(f.dir)});}return argv;}});`}
 yield* runSequence(state,${JSON.stringify(f.dir)});
 yield* writeTextFile(input.report,JSON.stringify({report:state.report,expired:Reflect.get(state,"teardownExpired") === true}));
 return "";
}
`,
          );
          yield* writeTextFile(
            join(f.dir, "outer.md"),
            `---
props:
  command: { type: string }
  report: { type: string }
---
<Probe command={props.command} report={props.report} />`,
          );
          const target = join(f.dir, "snapshot.json");
          const result = yield* runCli(
            [
              "run",
              join(f.dir, "outer.md"),
              "--include",
              f.dir,
              "--props-command",
              f.command(),
              "--props-report",
              target,
              "--deny-all",
              "--raw",
            ],
            { cwd: f.dir, env: { HOME: f.home }, timeout: 150_000 },
          ).join();
          expect([result.code, result.stderr]).toEqual([0, ""]);
          expect(yield* readTextFile(join(f.dir, "joined.txt"))).toBe("joined");
          const snapshot = JSON.parse(yield* readTextFile(target));
          if (fault === "throw") {
            expect(snapshot.report.capabilities.cleanup.outcome).toBe("failure");
            expect(snapshot.report.capabilities.cleanup.reason).toBe("cleanup-failed");
          } else if (fault === "delay") {
            expect(snapshot.expired).toBe(true);
            if (stage === "initial") {
              expect(
                (yield* f.methods()).filter((method) => method === "session/prompt").length,
              ).toBe(1);
              expect(snapshot.report.capabilities.resume.outcome).toBe("not_run");
            }
          } else {
            expect(snapshot.expired).toBe(false);
            expect(snapshot.report.capabilities.resume.outcome).toBe("pass");
            expect(
              (yield* f.methods()).filter((method) => method === "session/prompt").length,
            ).toBe(2);
          }
        });
      });
    }
  }
});
