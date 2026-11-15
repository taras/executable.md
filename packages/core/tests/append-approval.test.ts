import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, withResolvers } from "effection";
import type { Operation } from "effection";
import {
  createDurableOperation,
  durablePosition,
  InMemoryStream,
} from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { executeInstalledWithApprovals } from "../host.ts";
import type { AppendApproval, ExecutionApprovals, ExecutionInstallation } from "../host.ts";
import { retainedSource } from "../mod.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import { createScannerWith } from "../src/secrets/scanner.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { elicitationEffectName, questionFingerprint } from "../src/elicit-journal.ts";
import { getExpansion } from "../src/expansion.ts";
import { selecting } from "./support/generated-selection.ts";

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

function* openNote(
  stream: InMemoryStream,
  body: (approvals: ExecutionApprovals) => Operation<void>,
  extra: readonly ExecutionInstallation[] = [],
) {
  const bridge = withResolvers<ExecutionApprovals>();
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
    [installation, ...extra],
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

describe("a trusted host's generated-source approval", () => {
  it("clears selected Output and returns acknowledged Elicit value and source ranges", function* () {
    yield* useMarkerDetector();
    const stream = new InMemoryStream();
    const choice = `${marker} and ${marker}`;
    const schema = { type: "object", properties: { choice: { type: "string", enum: [choice] } } };
    const source =
      `<Elicit schema={${JSON.stringify(schema)}} as="answer">Choose one</Elicit>\n\n` +
      `<Output>\n${marker}\n</Output>\n`;
    const matches = Array.from(source.matchAll(/synthetic-marker/g), ({ index }) => ({
      ...match,
      bytes: marker,
      start: index,
      end: index + marker.length,
    }));
    const request = { id: "note", source, allow: ["write"] } as const;
    let selectingChoice: ExecutionApprovals | undefined;
    yield* Elicitation.around({
      *elicit([request]) {
        selectingChoice?.selectElicitation({
          ...(yield* durablePosition()),
          name: elicitationEffectName((yield* getExpansion()).position),
          fingerprint: questionFingerprint(request),
          field: "choice",
          option: 0,
        });
        return { choice };
      },
    });
    const completion = yield* openNote(
      stream,
      function* (approvals) {
        selectingChoice = approvals;
        const changed = yield* approvals.evaluateGeneratedXmdRoot(
          { ...request, source: request.source + "\n" },
          { source, matches },
        );
        expect(changed.result.ok).toBe(false);
        expect(changed.answers).toEqual([]);

        const ran = yield* approvals.evaluateGeneratedXmdRoot(request, { source, matches });
        if (!ran.result.ok) {
          throw ran.result.error;
        }
        expect(ran.result.value.output).toContain(marker);
        const events = stream.snapshot();
        const acknowledged = events.find(
          (event) => event.type === "yield" && event.description.type === "elicit",
        );
        const index = events
          .filter(
            (event) => event.type === "yield" && event.coroutineId === acknowledged?.coroutineId,
          )
          .indexOf(acknowledged!);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(ran.answers).toEqual([
          {
            coroutineId: acknowledged?.coroutineId,
            index,
            value: { choice },
            copies: matches.slice(0, 2).map(({ start, end, ...copy }, index) => ({
              field: "choice",
              source: { start, end },
              match: {
                ...copy,
                start: index * (marker.length + 5),
                end: index * (marker.length + 5) + marker.length,
              },
            })),
          },
        ]);
      },
      [selecting({ Elicit: ["paired"] })],
    );
    if (!completion.ok) {
      throw completion.error;
    }
  });
});
