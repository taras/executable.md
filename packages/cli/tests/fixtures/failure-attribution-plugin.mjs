import { Component, Plugin } from "@executablemd/core/api";
import { ensure } from "effection";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import process from "node:process";

function data(value, key) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function text(value) {
  return typeof value === "string"
    ? value.length <= 8192
      ? value
      : { availability: "truncated", prefix: value.slice(0, 8192), length: value.length }
    : { availability: "not-own-string-data" };
}
export default Plugin({
  name: "fixture-failure-attribution",
  *install() {
    const candidates = [];
    let observed = 0;
    let overflow = 0;
    yield* ensure(function* () {
      const destination = process.env.XMD_TEST_ARTIFACTS;
      if (!observed || !destination) {
        return;
      }
      const directory = join(destination, "failure-attribution");
      const identity = `${process.pid}-${crypto.randomUUID()}`;
      try {
        yield* ensureDir(directory);
        for (const candidate of candidates) {
          const record = candidate.record;
          if (typeof record.position.path !== "string") {
            record.source = { availability: "missing-path" };
            continue;
          }
          try {
            const path = record.position.path.startsWith("file:")
              ? fileURLToPath(record.position.path)
              : resolve(process.cwd(), record.position.path);
            const source = yield* readTextFile(path);
            record.source = {
              path: record.position.path,
              sha256: createHash("sha256").update(source).digest("hex"),
              elementAtOffset: source.slice(record.position.offset).startsWith(`<${record.name}`),
            };
          } catch {
            record.source = { availability: "source-unreadable" };
          }
        }
        function serialized() {
          return JSON.stringify(
            {
              schema: "fixture-failure-attribution.v1",
              pid: process.pid,
              classification: "observed; not proof of terminal attribution",
              observed,
              overflow,
              limits: { candidates: 16, stringCharacters: 8192, metadataBytes: 1048576 },
              candidates: candidates.map(({ record }) => record),
            },
            undefined,
            2,
          );
        }
        let metadata = serialized();
        while (new TextEncoder().encode(metadata).length > 1048576 && candidates.length) {
          const lowest = Math.min(...candidates.map((candidate) => candidate.priority));
          const remove = candidates.findLastIndex((candidate) => candidate.priority === lowest);
          candidates.splice(remove, 1);
          overflow++;
          metadata = serialized();
        }
        yield* writeTextFile(join(directory, identity + ".json"), metadata);
      } catch (error) {
        // Diagnostics cannot replace the command's selected outcome.
        try {
          yield* writeTextFile(
            join(directory, identity + "-capture-error.json"),
            JSON.stringify({ incomplete: true, error: text(data(error, "message")) }),
          );
        } catch {
          // The unavailable destination cannot carry an auxiliary fault either.
        }
      }
    });
    yield* Component.around({
      *handleFailure([failure], next) {
        observed++;
        const environment = yield* Component.operations.env;
        const position = failure.position;
        const record = {
          observation: observed,
          classification: "observed",
          name: text(failure.name),
          origin: failure.origin ?? null,
          position:
            position === undefined
              ? { availability: "missing" }
              : {
                  path: text(data(position, "path")),
                  offset: data(position, "offset"),
                  line: data(position, "line"),
                  column: data(position, "column"),
                },
          scenario: text(data(data(environment, "values"), "scenario")),
          errorName: text(data(failure.error, "name")),
          message: text(data(failure.error, "message")),
          report: text(data(failure.error, "report")),
          detail: {
            actual: text(data(data(failure.error, "detail"), "actual")),
            expected: text(data(data(failure.error, "detail"), "expected")),
          },
        };
        const repeated = candidates.find((candidate) => candidate.error === failure.error);
        if (repeated) {
          repeated.record.repeatedCount = (repeated.record.repeatedCount ?? 0) + 1;
          repeated.record.lastRepeatedObservation = observed;
          overflow++;
        } else {
          const path = data(position, "path");
          const priority =
            typeof path === "string" &&
            /(?:^|\/)examples\/adversarial-implementation\/tests\/components\/Fixture\/Fallback\.md$/.test(
              path.replaceAll("\\", "/"),
            ) &&
            /^Assert\w*$/.test(failure.name)
              ? 2
              : 1;
          const candidate = { error: failure.error, priority, record };
          if (candidates.length < 16) {
            candidates.push(candidate);
          } else {
            const replace = candidates.findIndex(
              (entry) =>
                entry.priority < priority || (priority === 2 && entry.priority === priority),
            );
            if (replace !== -1) {
              candidates.splice(replace, 1, candidate);
            }
            overflow++;
          }
        }
        return yield* next(failure);
      },
    });
  },
});
