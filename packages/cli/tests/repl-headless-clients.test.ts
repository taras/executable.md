import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, scoped, sleep, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation } from "effection";
import { XmdResponse, xmdPromptEvent } from "@executablemd/acp";
import { useHeadlessFixture, promptChild } from "./support/headless-repl.ts";
import { requestAttachment } from "../src/sidekick-acp/client.ts";
import { z } from "zod";
import { exec } from "@effectionx/process";
import { cliShellCommand } from "@executablemd/test-support/launch";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createPermissionBridge } from "../../acp/src/permission-bridge.ts";
import { responseNotification } from "../src/headless/presentations.ts";
import { Elicitation } from "@executablemd/core";
import type { Scope } from "effection";
import type { AgentPromptEvent } from "@executablemd/core";

const conditional = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    reason: { type: "string" },
  },
  required: ["decision"],
  if: { properties: { decision: { type: "string", const: "approve" } }, required: ["decision"] },
  then: { required: ["reason"], properties: { reason: { type: "string", minLength: 8 } } },
};

function entryResponse(source: string): string {
  return `<Let as="code" select="code">\n\x60\x60\x60xmd\n${source}\n\x60\x60\x60\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`;
}

describe("headless child ACP clients", () => {
  it("H5: every closed response variant closes only its correlated presentation and retirement proves no answer", function* () {
    const issue = {
      instancePath: "/reason",
      schemaPath: "#/then/required",
      keyword: "required",
      params: { missingProperty: "reason" },
      message: "must have required property 'reason'",
    };
    const cases = [
      { kind: "question", event: "response", outcome: "accepted", status: "completed" },
      { kind: "permission", event: "response", outcome: "accepted", status: "completed" },
      { kind: "question", event: "response", outcome: "stale", status: "failed" },
      { kind: "permission", event: "response", outcome: "stale", status: "failed" },
      { kind: "question", event: "response", outcome: "not-submitted", status: "failed" },
      { kind: "permission", event: "response", outcome: "not-submitted", status: "failed" },
      {
        kind: "question",
        event: "response",
        outcome: "invalid",
        reason: "schema",
        issues: [issue],
        status: "failed",
      },
      {
        kind: "permission",
        event: "response",
        outcome: "invalid",
        reason: "option-not-offered",
        status: "failed",
      },
      {
        kind: "question",
        event: "response",
        outcome: "invalid",
        reason: "response-format",
        status: "failed",
      },
      {
        kind: "permission",
        event: "response",
        outcome: "invalid",
        reason: "response-format",
        status: "failed",
      },
      { kind: "question", event: "retired", reason: "request-ended", status: "completed" },
      { kind: "permission", event: "retired", reason: "request-ended", status: "completed" },
    ];
    for (const { status, ...payload } of cases) {
      const response = XmdResponse.parse({
        ...payload,
        requestId: "original-request",
        presentationId: "single-offer",
      });
      const notification = responseNotification("outer-mapping", response);
      expect(notification.sessionId).toBe("outer-mapping");
      expect(notification.update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "single-offer",
        kind: "other",
        status,
        rawOutput: { "executablemd.xmd-response/v1": response },
      });
      expect(JSON.stringify(notification.update)).toContain("XMD");
      expect(XmdResponse.safeParse({ ...response, answer: "not a receipt member" }).success).toBe(
        false,
      );
      const event = xmdPromptEvent(response);
      if (response.event === "retired") {
        expect(event).toBeUndefined();
      } else {
        expect(event).toMatchObject({
          type:
            response.kind === "question" ? "question_answer_result" : "permission_decision_result",
          inputId: "single-offer",
          result: { status: response.outcome },
        });
      }
    }
    expect(
      XmdResponse.safeParse({
        kind: "question",
        requestId: "q",
        presentationId: "p",
        event: "response",
        outcome: "invalid",
        reason: "schema",
        issues: [],
      }).success,
    ).toBe(false);
  });
  it("H5/J4: the actual embedded ACP client continues two ordinary prompts in the exact child", function* () {
    const handles: string[] = [];
    const held = yield* useHeadlessFixture((input) => {
      handles.push(input.handle.sessionKey);
      return input;
    });
    const token = "retained-through-embedded-two-prompts";
    held.host.fake.script({
      reply: entryResponse(
        `<Let as="embeddedToken" value="${token}" /><Output>{embeddedToken}</Output>`,
      ),
    });
    held.host.fake.script({ reply: "<Output>Embedded first prompt finished.</Output>" });
    held.host.fake.script({ reply: "<REPL.Bindings />" });
    held.host.fake.script({ reply: `<Output>${token}</Output>` });
    const replies: string[] = [];
    for (const text of ["Save the embedded token.", "Read the saved embedded token."]) {
      const submitted = yield* held.root.session.submit(promptChild(text));
      if (!submitted.ok) {
        throw submitted.error;
      }
      const joined = yield* submitted.value.join();
      if (!joined.ok) {
        throw joined.error;
      }
      const output = yield* submitted.value.output();
      if (!output.ok) {
        throw output.error;
      }
      replies.push(output.value.output);
      expect(yield* requestAttachment(held.path, { method: "status" })).toMatchObject({
        owner: held.reference.sessionId,
        execution: held.descriptor.execution,
        conversation: held.descriptor.conversation,
        busy: false,
      });
    }
    expect(replies[0]).toContain("Embedded first prompt finished.");
    expect(replies[1]).toContain(token);
    expect(held.host.fake.prompts.at(-1)).toContain(token);
    expect(handles).toEqual([held.reference.sessionId, held.reference.sessionId]);
    console.log(
      JSON.stringify({
        journey: "J4",
        client: "embedded ACPX vendored runtime",
        sessionId: held.reference.sessionId,
        execution: held.descriptor.execution,
        conversation: held.descriptor.conversation,
        nativeHandleKeys: handles,
        token,
        replies,
        joinedExchanges: 2,
      }),
    );
    yield* held.task.halt();
  });
  it("H6/J4: stock ACPX displays the complete conditional question and capability refusal while the child stays pending", function* () {
    const held = yield* useHeadlessFixture();
    const home = yield* useTemporary("xmd-headless-stock-form-home-");
    const stock = fileURLToPath(
      new URL(
        "../../../node_modules/.deno/acpx@0.21.1/node_modules/acpx/dist/cli.js",
        import.meta.url,
      ),
    );
    held.host.fake.script({
      reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Stock actual conditional question.</Elicit>`,
    });
    held.host.fake.script({ reply: "<Output>Answered by another supported input.</Output>" });
    const child = yield* exec("node", {
      arguments: [
        stock,
        "--cwd",
        held.descriptor.cwd,
        "--format",
        "json",
        "--agent",
        cliShellCommand(["sidekick", "child-acp", "--session-id", held.reference.sessionId]),
        "exec",
        "Ask the conditional question.",
      ],
      cwd: held.descriptor.cwd,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        DENO_DIR: process.env.DENO_DIR ?? "",
        XMD_HEADLESS_ENDPOINT: held.path,
      },
    });
    let stdout = "";
    const refused = withResolvers<void>();
    yield* child.around({
      *stdout([bytes], next) {
        stdout += new TextDecoder().decode(bytes);
        if (stdout.includes("does not advertise form elicitation")) {
          refused.resolve();
        }
        yield* next(bytes);
      },
    });
    yield* refused.operation;
    expect(stdout).toContain("Stock actual conditional question.");
    expect(stdout).toContain("at least 8 characters");
    const status = z
      .object({ questionPending: z.boolean() })
      .passthrough()
      .parse(yield* requestAttachment(held.path, { method: "status" }));
    expect(status.questionPending).toBe(true);
    const notices = stdout
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({
            params: z
              .object({
                update: z
                  .object({
                    rawOutput: z.object({ "executablemd.xmd-response/v1": XmdResponse }).strict(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough()
          .safeParse(JSON.parse(line)),
      );
    const refusal = notices.find(
      (one) =>
        one.success &&
        one.data.params.update.rawOutput["executablemd.xmd-response/v1"].event === "response",
    );
    if (refusal === undefined || !refusal.success) {
      throw new Error("Stock output omitted its readable response/refusal.");
    }
    const response = refusal.data.params.update.rawOutput["executablemd.xmd-response/v1"];
    expect(response).toMatchObject({ event: "response", outcome: "not-submitted" });
    const offer = z
      .object({ presentationId: z.string() })
      .passthrough()
      .parse(
        yield* requestAttachment(held.path, {
          method: "child-offer",
          requestId: response.requestId,
        }),
      );
    yield* requestAttachment(held.path, {
      method: "child-response",
      kind: "question",
      requestId: response.requestId,
      presentationId: offer.presentationId,
      value: { action: "accept", content: { decision: "approve", reason: "reviewed" } },
    });
    expect((yield* child.join()).code).toBe(0);
    expect(stdout).toContain("Answered by another supported input.");
    yield* held.task.halt();
  });
  it("H5: actual permission choices use the original owner, invalid options remain pending and stale ACP cannot settle again", function* () {
    const offered = withResolvers<{ requestId: string; presentationId: string }>();
    const settled = withResolvers<void>();
    const held = yield* useHeadlessFixture(undefined, undefined, undefined, {
      permission(request) {
        offered.resolve(
          z
            .object({ requestId: z.string(), presentationId: z.string() })
            .strict()
            .parse(request.raw._meta?.["executablemd.xmd-permission/v1"]),
        );
      },
      event(event) {
        if (event.type === "tool_call") {
          const parsed = z
            .object({ "executablemd.xmd-response/v1": XmdResponse })
            .safeParse(event.rawOutput);
          const response = parsed.success ? parsed.data["executablemd.xmd-response/v1"] : undefined;
          if (
            response?.kind === "permission" &&
            response.event === "response" &&
            response.outcome === "accepted"
          ) {
            settled.resolve();
          }
        }
      },
    });
    held.host.fake.script({
      reply: entryResponse(
        '<Agent name="scribe"><Session name="native"><Prompt>Use the requested tool.</Prompt></Session></Agent>',
      ),
    });
    held.host.fake.script({
      requestsTool: "write the synthetic file",
      permissionChoices: [
        { optionId: "allow-this-one", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-this-one", name: "Reject once", kind: "reject_once" },
      ],
      reply: "Tool completed.",
    });
    held.host.fake.script({ reply: "<Output>Permission exchange finished.</Output>" });
    const notices: AgentPromptEvent[] = [];
    const observing = yield* spawn(function* () {
      const updates = yield* held.root.session.agentChanges;
      while (true) {
        yield* updates.next();
        for (const turn of held.root.session.agent.turns) {
          notices.push(...(turn.inputResults ?? []));
        }
      }
    });
    const entry = yield* held.root.session.submit(promptChild("Run the tool entry."));
    if (!entry.ok) {
      throw entry.error;
    }
    const address = yield* offered.operation;
    const offer = z
      .object({
        input: z
          .object({ options: z.array(z.object({ optionId: z.string() }).passthrough()) })
          .passthrough(),
        presentationId: z.string(),
      })
      .strict();
    const first = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId: address.requestId }),
    );
    expect(first.input.options.map((one) => one.optionId)).toEqual([
      "allow-this-one",
      "reject-this-one",
    ]);
    const badFormat = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "permission",
        requestId: address.requestId,
        presentationId: first.presentationId,
        value: { approve: true },
      }),
    );
    expect(badFormat).toMatchObject({
      event: "response",
      outcome: "invalid",
      reason: "response-format",
    });
    const another = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId: address.requestId }),
    );
    const unoffered = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "permission",
        requestId: address.requestId,
        presentationId: another.presentationId,
        value: { outcome: { outcome: "selected", optionId: "approve-all" } },
      }),
    );
    expect(unoffered).toMatchObject({
      event: "response",
      outcome: "invalid",
      reason: "option-not-offered",
    });
    const chosen = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId: address.requestId }),
    );
    const inputChanges = yield* held.root.session.agentChanges;
    let parentInput = held.root.session.agent.requests[0];
    while (parentInput === undefined) {
      yield* inputChanges.next();
      parentInput = held.root.session.agent.requests[0];
    }
    expect(held.root.session.permissions.choose(parentInput.key, "allow-this-one")).toBe(true);
    yield* settled.operation;
    const stale = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "permission",
        requestId: address.requestId,
        presentationId: chosen.presentationId,
        value: { outcome: { outcome: "selected", optionId: "reject-this-one" } },
      }),
    );
    expect(stale).toMatchObject({ event: "response", outcome: "stale" });
    const result = yield* entry.value.join();
    if (!result.ok) {
      throw result.error;
    }
    yield* observing.halt();
    expect(held.host.fake.decisions).toEqual(["allow_once"]);
    expect(held.root.session.agent.requests).toHaveLength(0);
    expect(notices.some((one) => one.type === "permission_decision_result")).toBe(true);
    yield* held.task.halt();
  });
  it("H6: subscriber-scope input is absent for pre-abort and retirement joins its original callback", function* () {
    const bridge = createPermissionBridge();
    const ready = withResolvers<Scope>();
    const started = withResolvers<void>();
    const finishing = withResolvers<void>();
    const release = withResolvers<void>();
    let asked = 0;
    let removed = false;
    const subscriber = yield* spawn(function* () {
      yield* Elicitation.around(
        {
          *elicit() {
            asked += 1;
            yield* ensure(function* () {
              finishing.resolve();
              yield* release.operation;
              removed = true;
            });
            started.resolve();
            yield* suspend();
            return {};
          },
        },
        { at: "min" },
      );
      ready.resolve(yield* useScope());
      yield* suspend();
    });
    const scope = yield* ready.operation;
    const registration = bridge.register(
      "outer",
      scope,
      { sessionKey: "original", cwd: "/work" },
      function* () {
        return { acpSessionId: "outer" };
      },
    );
    const request = {
      sessionId: "outer",
      mode: "form",
      message: "Actual conditional question",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        "executablemd.xmd-question/v1": {
          requestId: "original-question",
          presentationId: "original-presentation",
          schema: conditional,
        },
      },
    };
    const aborted = new AbortController();
    aborted.abort();
    expect(yield* registration.elicitation(request, aborted.signal)).toEqual({ action: "cancel" });
    expect(asked).toBe(0);
    const callback = yield* spawn(() =>
      registration.elicitation(request, new AbortController().signal),
    );
    yield* started.operation;
    let joined = false;
    const retiring = yield* spawn(function* () {
      yield* registration.retire("original-presentation");
      joined = true;
    });
    yield* finishing.operation;
    expect(joined).toBe(false);
    expect(removed).toBe(false);
    release.resolve();
    yield* retiring;
    expect(removed).toBe(true);
    expect(asked).toBe(1);
    yield* callback.halt();
    expect(yield* registration.elicitation(request, new AbortController().signal)).toEqual({
      action: "cancel",
    });
    expect(asked).toBe(1);
    registration.unregister();
    yield* subscriber.halt();
  });

  it("H6: Prompt teardown withdraws actual question and permission callbacks without fabricating decisions", function* () {
    for (const kind of ["question", "permission"]) {
      yield* scoped(function* () {
        const offered = withResolvers<string>();
        const held = yield* useHeadlessFixture(
          (input) => {
            const original = input.onElicitation;
            if (original === undefined) {
              throw new Error("The capable callback is absent.");
            }
            return {
              ...input,
              onElicitation(request, context) {
                offered.resolve(
                  z
                    .object({ requestId: z.string() })
                    .passthrough()
                    .parse(request._meta?.["executablemd.xmd-question/v1"]).requestId,
                );
                return original(request, context);
              },
            };
          },
          undefined,
          undefined,
          {
            permission(request) {
              offered.resolve(
                z
                  .object({ requestId: z.string() })
                  .passthrough()
                  .parse(request.raw._meta?.["executablemd.xmd-permission/v1"]).requestId,
              );
            },
          },
        );
        if (kind === "question") {
          held.host.fake.script({
            reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Keep the original child question pending.</Elicit>`,
          });
        } else {
          held.host.fake.script({
            reply: entryResponse(
              '<Agent name="scribe"><Session name="tool"><Prompt>Use the native tool.</Prompt></Session></Agent>',
            ),
          });
          held.host.fake.script({ requestsTool: "Write", reply: "Completed native work." });
        }
        const questions = yield* held.root.session.elicitation.changes;
        const permissions = yield* held.root.session.agentChanges;
        const entry = yield* held.root.session.submit(
          promptChild("Offer input without answering it."),
        );
        if (!entry.ok) {
          throw entry.error;
        }
        if (kind === "question") {
          while (held.root.session.elicitation.pending === undefined) {
            yield* questions.next();
          }
        } else {
          while (held.root.session.agent.requests.length === 0) {
            yield* permissions.next();
          }
        }
        const requestId = yield* offered.operation;
        const original = z
          .object({ presentationId: z.string() })
          .passthrough()
          .parse(yield* requestAttachment(held.path, { method: "child-offer", requestId }));
        const stopped = yield* held.root.session.stopEntry(entry.value.entry);
        if (!stopped.ok) {
          throw stopped.error;
        }
        expect(held.root.session.elicitation.pending).toBeUndefined();
        expect(held.root.session.agent.requests).toHaveLength(0);
        expect(held.host.fake.decisions).toEqual([]);
        expect(yield* requestAttachment(held.path, { method: "status" })).toMatchObject({
          owner: held.reference.sessionId,
        });
        if (kind === "permission") {
          const stillPending = z
            .object({ input: z.object({ kind: z.string() }).passthrough() })
            .passthrough()
            .parse(yield* requestAttachment(held.path, { method: "child-offer", requestId }));
          expect(stillPending.input.kind).toBe(kind);
        } else {
          const stale = yield* requestAttachment(held.path, {
            method: "child-response",
            kind: "question",
            requestId,
            presentationId: original.presentationId,
            value: { action: "accept", content: { decision: "reject" } },
          });
          expect(stale).toMatchObject({ event: "response", outcome: "stale" });
        }
        yield* held.task.halt();
      });
    }
  });

  it("H6: parent termination joins a pending native permission callback without a decision", function* () {
    const held = yield* useHeadlessFixture();
    held.host.fake.script({
      reply: entryResponse(
        '<Agent name="scribe"><Session name="tool"><Prompt>Use the native tool.</Prompt></Session></Agent>',
      ),
    });
    held.host.fake.script({ requestsTool: "Write", reply: "Completed native work." });
    const changes = yield* held.root.session.agentChanges;
    const entry = yield* held.root.session.submit(promptChild("Wait for permission."));
    if (!entry.ok) {
      throw entry.error;
    }
    while (held.root.session.agent.requests.length === 0) {
      yield* changes.next();
    }
    yield* held.task.halt();
    expect(held.host.fake.decisions).toEqual([]);
  });

  it("H6: malformed callback metadata fails and joins the actual local runtime while the parent-owned child survives", function* () {
    const closing = withResolvers<void>();
    const release = withResolvers<void>();
    const held = yield* useHeadlessFixture(
      (input) => {
        const original = input.onElicitation;
        if (original === undefined) {
          throw new Error("The embedded XMD callback was not installed.");
        }
        return {
          ...input,
          onElicitation: (request, context) => original({ ...request, _meta: {} }, context),
        };
      },
      undefined,
      undefined,
      {
        *beforeClose() {
          closing.resolve();
          yield* release.operation;
        },
      },
    );
    held.host.fake.script({
      reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Actual failing callback.</Elicit>`,
    });
    const sent = yield* held.root.session.submit(promptChild("Ask through the failing callback."));
    if (!sent.ok) {
      throw sent.error;
    }
    let finished = false;
    const joining = yield* spawn(function* () {
      const result = yield* sent.value.join();
      finished = true;
      return result;
    });
    yield* closing.operation;
    expect(finished).toBe(false);
    release.resolve();
    const result = yield* joining;
    expect(result.ok).toBe(false);
    expect(held.root.session.elicitation.pending).toBeUndefined();
    const status = z
      .object({ busy: z.boolean() })
      .passthrough()
      .parse(yield* requestAttachment(held.path, { method: "status" }));
    expect(status.busy).toBe(false);
    expect(held.host.fake.prompts).toHaveLength(1);
    yield* held.task.halt();
  });
  it("H5/J4: stock ACPX 0.21.1 sends two actual prompts to the exact live child", function* () {
    const held = yield* useHeadlessFixture();
    const home = yield* useTemporary("xmd-headless-stock-home-");
    const stock = fileURLToPath(
      new URL(
        "../../../node_modules/.deno/acpx@0.21.1/node_modules/acpx/dist/cli.js",
        import.meta.url,
      ),
    );
    const version = yield* exec("node", { arguments: [stock, "--version"] }).join();
    expect(version.stdout.trim()).toBe("0.21.1");
    const token = "retained-through-stock-two-prompts";
    const source = `<Let as="savedToken" value="${token}" /><Output>{savedToken}</Output>`;
    held.host.fake.script({
      reply: `<Let as="code" select="code">\n\x60\x60\x60xmd\n${source}\n\x60\x60\x60\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
    });
    held.host.fake.script({ reply: "<Output>First prompt finished.</Output>" });
    held.host.fake.script({ reply: "<REPL.Bindings />" });
    held.host.fake.script({ reply: `<Output>${token}</Output>` });
    for (const prompt of ["Save the token in a binding.", "Read the saved token."]) {
      const result = yield* exec("node", {
        arguments: [
          stock,
          "--cwd",
          held.descriptor.cwd,
          "--format",
          "json",
          "--agent",
          cliShellCommand(["sidekick", "child-acp", "--session-id", held.reference.sessionId]),
          "exec",
          prompt,
        ],
        cwd: held.descriptor.cwd,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "",
          DENO_DIR: process.env.DENO_DIR ?? "",
          XMD_HEADLESS_ENDPOINT: held.path,
        },
      }).join();
      if (result.code !== 0) {
        throw new Error(`Stock ACPX failed: ${result.stderr}\n${result.stdout}`);
      }
      for (const line of result.stdout.trim().split("\n")) {
        JSON.parse(line);
      }
      expect(result.stdout).toContain(prompt.startsWith("Save") ? "First prompt finished." : token);
    }
    expect(held.host.fake.prompts.at(-1)).toContain(token);
    console.log(
      JSON.stringify({
        client: "stock acpx",
        version: version.stdout.trim(),
        sessionId: held.reference.sessionId,
        execution: held.descriptor.execution,
        conversation: held.descriptor.conversation,
        token,
        prompts: held.host.fake.prompts.length,
      }),
    );
    held.host.fake.script({ reply: "partial native failure", stopReason: "max_tokens" });
    const failed = yield* exec("node", {
      arguments: [
        stock,
        "--cwd",
        held.descriptor.cwd,
        "--format",
        "json",
        "--agent",
        cliShellCommand(["sidekick", "child-acp", "--session-id", held.reference.sessionId]),
        "exec",
        "Exercise the actual failure channel.",
      ],
      cwd: held.descriptor.cwd,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        DENO_DIR: process.env.DENO_DIR ?? "",
        XMD_HEADLESS_ENDPOINT: held.path,
      },
    }).join();
    expect(failed.code).not.toBe(0);
    const failureTraffic = failed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(failureTraffic.length).toBeGreaterThan(0);
    expect(JSON.stringify(failureTraffic)).toContain("max_tokens");
    expect(failed.stdout).not.toContain("\x1b[");
    yield* held.task.halt();
  });
  it("H5/H6: the actual embedded client presents the full question in its subscriber scope", function* () {
    const offers: unknown[] = [];
    const wireResults: { response: XmdResponse; status: string | undefined }[] = [];
    const held = yield* useHeadlessFixture(
      (input) => {
        const original = input.onElicitation;
        if (original === undefined) {
          throw new Error("The embedded callback is absent.");
        }
        return {
          ...input,
          onElicitation: (request, context) => {
            offers.push(request);
            return offers.length === 1
              ? Promise.resolve({ action: "accept", content: { decision: "approve" } })
              : original(request, context);
          },
        };
      },
      undefined,
      undefined,
      {
        event(event) {
          if (event.type === "tool_call") {
            const result = z
              .object({ "executablemd.xmd-response/v1": XmdResponse })
              .strict()
              .safeParse(event.rawOutput);
            if (result.success) {
              wireResults.push({
                response: result.data["executablemd.xmd-response/v1"],
                status: event.status,
              });
            }
          }
        },
      },
    );
    held.host.fake.script({
      reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Continue with deployment?</Elicit><Output>Answer accepted.</Output>`,
    });
    held.host.fake.script({ reply: "<Output>Completed requested work.</Output>" });
    const changes = yield* held.root.session.elicitation.changes;
    const notices: AgentPromptEvent[] = [];
    const observing = yield* spawn(function* () {
      const updates = yield* held.root.session.agentChanges;
      while (true) {
        yield* updates.next();
        for (const turn of held.root.session.agent.turns) {
          notices.push(...(turn.inputResults ?? []));
        }
      }
    });
    const entry = yield* held.root.session.submit(promptChild("Ask the conditional question."));
    if (!entry.ok) {
      throw entry.error;
    }
    const question = yield* race([
      (function* () {
        let pending = held.root.session.elicitation.pending;
        while (pending === undefined) {
          pending = (yield* changes.next()).value;
        }
        return pending;
      })(),
      (function* (): Operation<never> {
        const result = yield* entry.value.join();
        if (!result.ok) {
          throw result.error;
        }
        throw new Error("The entry ended without presenting its child question.");
      })(),
    ]);
    expect(question.message).toContain("Continue with deployment?");
    expect(question.schema).toEqual(conditional);
    const offered = z
      .array(
        z.object({
          requestedSchema: z.object({
            required: z.array(z.string()),
            properties: z.record(z.string(), z.unknown()),
          }),
          message: z.string(),
          _meta: z.object({
            "executablemd.xmd-question/v1": z
              .object({ requestId: z.string(), presentationId: z.string(), schema: z.unknown() })
              .strict(),
          }),
        }),
      )
      .parse(offers);
    expect(offered).toHaveLength(2);
    expect(offered[0]?.requestedSchema.required).toEqual(["decision"]);
    expect(offered[0]?.message).toContain("at least 8 characters");
    expect(offered[0]?._meta["executablemd.xmd-question/v1"].schema).toEqual(conditional);
    expect(offered[0]?._meta["executablemd.xmd-question/v1"].requestId).toBe(
      offered[1]?._meta["executablemd.xmd-question/v1"].requestId,
    );
    expect(offered[0]?._meta["executablemd.xmd-question/v1"].presentationId).not.toBe(
      offered[1]?._meta["executablemd.xmd-question/v1"].presentationId,
    );
    const invalid = question.submit({ decision: "approve" });
    expect(invalid.kind).toBe("invalid");
    expect(held.root.session.elicitation.pending).toBe(question);
    const accepted = question.submit({ decision: "approve", reason: "reviewed" });
    expect(accepted.kind).toBe("answered");
    const completed = yield* entry.value.join();
    if (!completed.ok) {
      throw completed.error;
    }
    const output = yield* entry.value.output();
    if (!output.ok) {
      throw output.error;
    }
    expect(output.value.output).toContain("Completed requested work.");
    expect(output.value.output).not.toContain("question_answer_result");
    expect(held.root.session.elicitation.pending).toBeUndefined();
    yield* observing.halt();
    expect(
      wireResults.some(
        (one) =>
          one.response.event === "response" &&
          one.response.outcome === "invalid" &&
          one.status === "failed",
      ),
    ).toBe(true);
    expect(
      wireResults.some(
        (one) =>
          one.response.event === "response" &&
          one.response.outcome === "accepted" &&
          one.status === "completed",
      ),
    ).toBe(true);
    expect(
      notices.some(
        (one) => one.type === "question_answer_result" && one.result.status === "invalid",
      ),
    ).toBe(true);
    expect(
      notices.some(
        (one) => one.type === "question_answer_result" && one.result.status === "accepted",
      ),
    ).toBe(true);
    yield* held.task.halt();
  });

  it("H5: the original validator rejects an invalid answer and a stale presentation reaches no successor", function* () {
    const held = yield* useHeadlessFixture();
    held.host.fake.script({
      reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Continue with deployment?</Elicit><Output>Answered.</Output>`,
    });
    held.host.fake.script({ reply: "<Output>Done.</Output>" });
    const mapping = z
      .object({ attachment: z.string() })
      .strict()
      .parse(yield* requestAttachment(held.path, { method: "attach", cwd: held.descriptor.cwd }));
    const received = withResolvers<string>();
    const sent = yield* spawn(() =>
      requestAttachment(
        held.path,
        { method: "prompt", attachment: mapping.attachment, text: "Ask the question." },
        function* (raw) {
          const data = z
            .object({
              inputs: z
                .array(z.object({ kind: z.string(), requestId: z.string() }).passthrough())
                .optional(),
            })
            .passthrough()
            .parse(raw);
          const pending = data.inputs?.find((one) => one.kind === "question");
          if (pending !== undefined) {
            received.resolve(pending.requestId);
          }
        },
      ),
    );
    const requestId = yield* race([
      received.operation,
      (function* (): Operation<never> {
        const result = yield* sent;
        throw new Error(
          "The exchange ended without a question: " +
            JSON.stringify({ result, feedback: held.host.fake.prompts.slice(1) }),
        );
      })(),
      (function* (): Operation<never> {
        yield* sleep(10000);
        throw new Error("The child did not publish a question before the diagnostic deadline.");
      })(),
    ]);
    const offer = z.object({ presentationId: z.string() }).passthrough();
    const old = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId }),
    );
    const first = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId }),
    );
    const invalid = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "question",
        requestId,
        presentationId: first.presentationId,
        value: { action: "accept", content: { decision: "approve" } },
      }),
    );
    expect(invalid).toMatchObject({ event: "response", outcome: "invalid", reason: "schema" });
    if (
      invalid.event === "response" &&
      invalid.outcome === "invalid" &&
      invalid.reason === "schema"
    ) {
      expect(invalid.issues.length).toBeGreaterThan(0);
    }
    const corrected = offer.parse(
      yield* requestAttachment(held.path, { method: "child-offer", requestId }),
    );
    expect(corrected.presentationId).not.toBe(first.presentationId);
    const accepted = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "question",
        requestId,
        presentationId: corrected.presentationId,
        value: { action: "accept", content: { decision: "approve", reason: "reviewed" } },
      }),
    );
    expect(accepted).toMatchObject({ event: "response", outcome: "accepted", requestId });
    const stale = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "question",
        requestId,
        presentationId: old.presentationId,
        value: { action: "accept", content: { decision: "reject" } },
      }),
    );
    expect(stale).toMatchObject({ event: "response", outcome: "stale" });
    yield* race([
      sent,
      (function* (): Operation<never> {
        yield* sleep(10000);
        throw new Error("The answered child exchange did not join before the diagnostic deadline.");
      })(),
    ]);
    yield* held.task.halt();
  });
});
