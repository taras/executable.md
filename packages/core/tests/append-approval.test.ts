import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, withResolvers } from "effection";
import type { Operation } from "effection";
import { createDurableOperation, InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { executeInstalledWithApprovals } from "../host.ts";
import type { AppendApproval, AppendApprovals, ExecutionInstallation } from "../host.ts";
import { retainedSource } from "../mod.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import { createScannerWith } from "../src/secrets/scanner.ts";

const marker = "synthetic-marker";
const text = `private note\n${marker}`;
const description = { type: "host_note", name: "keep" };
const match = {
  ruleId: "test-word",
  messageId: "marker",
  start: text.indexOf(marker),
  end: text.length,
};
const approval: AppendApproval = {
  coroutineId: "root",
  ...description,
  fields: [{ path: ["result", "value", "note"], text, matches: [match] }],
};

function* useMarkerDetector(): Operation<void> {
  yield* useSecretScannerFactory(() =>
    createScannerWith((input) => {
      const messages = Array.from(input.matchAll(/synthetic-marker/g), ({ index }) => {
        const range: [number, number] = [index, index + marker.length];
        return { ruleId: match.ruleId, messageId: match.messageId, range };
      });
      return Promise.resolve({ messages });
    }),
  );
}

function* openNote(stream: InMemoryStream, body: (approvals: AppendApprovals) => Operation<void>) {
  const bridge = withResolvers<AppendApprovals>();
  const installation: ExecutionInstallation = {
    components: [
      {
        name: "NoteHost",
        origin: "@test/note",
        props: { type: "object", properties: {}, additionalProperties: false },
        description: "Publish the note this host owns.",
        factory: () =>
          function* (): Operation<Json> {
            const approvals = yield* bridge.operation;
            yield* body(approvals);
            return "";
          },
      },
    ],
  };
  const { execution, approvals } = yield* executeInstalledWithApprovals(
    { ...retainedSource("host-note.md", "<NoteHost />\n"), stream },
    [installation],
  );
  expect(execution).not.toHaveProperty("approvals");
  bridge.resolve(approvals);
  return yield* execution;
}

function* publish(record: Json, onLive?: () => void): Operation<unknown> {
  return yield createDurableOperation<Json>(
    description,
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      onLive?.();
      return record;
    },
  );
}

function notes(stream: InMemoryStream) {
  return stream
    .snapshot()
    .flatMap((event) =>
      event.type === "yield" && event.description.type === description.type ? [event.result] : [],
    );
}

describe("a trusted host's append approval", () => {
  it("commits an exact note and replays it without granting or executing again", function* () {
    yield* useMarkerDetector();
    const stream = new InMemoryStream();
    let wrote = 0;
    const result = yield* openNote(stream, (approvals) =>
      scoped(function* () {
        yield* approvals.approveAppend(approval);
        yield* publish({ note: text }, () => {
          wrote++;
        });
      }),
    );
    expect(result.ok).toBe(true);
    expect(notes(stream)).toEqual([{ status: "ok", value: { note: text } }]);

    const replayed = yield* openNote(stream, function* () {
      expect(
        yield* publish({ note: "" }, () => {
          wrote++;
        }),
      ).toEqual({ note: text });
    });
    expect(replayed.ok).toBe(true);
    expect(wrote).toBe(1);
  });

  it("retires the approval with its scope and leaves other fields subject to the scanner", function* () {
    yield* useMarkerDetector();
    const expired = new InMemoryStream();
    const afterScope = yield* openNote(expired, function* (approvals) {
      yield* scoped(() => approvals.approveAppend(approval));
      yield* publish({ note: text });
    });
    expect(afterScope.ok).toBe(false);
    expect(notes(expired)).toEqual([]);

    const unexpected = new InMemoryStream();
    const extraField = yield* openNote(unexpected, function* (approvals) {
      yield* approvals.approveAppend(approval);
      yield* publish({ note: text, other: marker });
    });
    expect(extraField.ok).toBe(false);
    expect(notes(unexpected)).toEqual([]);

    const changed = new InMemoryStream();
    const changedText = yield* openNote(changed, function* (approvals) {
      yield* approvals.approveAppend(approval);
      yield* publish({ note: text.replace("private", "altered") });
    });
    expect(changedText.ok).toBe(false);
    expect(notes(changed)).toEqual([]);
  });

  it("consumes the approval after one append even within the same scope", function* () {
    yield* useMarkerDetector();
    const stream = new InMemoryStream();
    const result = yield* openNote(stream, function* (approvals) {
      yield* approvals.approveAppend(approval);
      yield* publish({ note: text });
      yield* publish({ note: text });
    });
    expect(result.ok).toBe(false);
    expect(notes(stream)).toEqual([{ status: "ok", value: { note: text } }]);
  });
});
