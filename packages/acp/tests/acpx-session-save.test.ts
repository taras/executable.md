import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { allSettled, ensure, spawn, until, useScope, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpxSessionStore, retainedSession } from "../src/session-store.ts";
import type { AcpSessionRecord } from "../src/acpx-runtime.ts";
import { makeRecord } from "./helpers.ts";

function* directory() {
  const dir = join(tmpdir(), `xmd-save-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The 0.12.0 writer chooses this path after mkdir and before its first write.
function* oldSave(dir: string, record: AcpSessionRecord): Operation<void> {
  yield* ensureDir(dir);
  const file = join(dir, "session.json");
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  yield* writeTextFile(tempFile, JSON.stringify(record));
  yield* until(fs.rename(tempFile, file));
}

describe("ACPX session-save collision", { sanitizeOps: false, sanitizeResources: false }, () => {
  for (const old of [true, false]) {
    it(
      old
        ? "the previous writer loses one same-millisecond temporary file"
        : "released staging preserves both saves and the second update",
      function* () {
        const dir = yield* directory();
        const store = createAcpxSessionStore(dir);
        const scope = yield* useScope();
        const firstArrived = withResolvers<void>();
        const bothArrived = withResolvers<void>();
        const firstPublished = withResolvers<void>();
        const rename = fs.rename;
        const now = Date.now;
        const sources: string[] = [];
        let ordinal = 0;
        fs.rename = (from, to) =>
          scope
            .run(() =>
              allSettled([
                (function* () {
                  const mine = ++ordinal;
                  sources.push(String(from));
                  if (mine === 1) {
                    firstArrived.resolve();
                    yield* bothArrived.operation;
                    try {
                      yield* until(rename(from, to));
                    } finally {
                      firstPublished.resolve();
                    }
                  } else {
                    bothArrived.resolve();
                    yield* firstPublished.operation;
                    yield* until(rename(from, to));
                  }
                })(),
              ]),
            )
            .then(([result]) => {
              if (!result.ok) {
                throw result.error;
              }
            });
        Date.now = () => 1234567890;
        const first = {
          ...makeRecord("deterministic", dir),
          acpxRecordId: "collision",
          title: "first",
        };
        const second = { ...first, title: "second" };
        const save = (record: AcpSessionRecord) =>
          old ? oldSave(dir, record) : until(store.save(record));
        try {
          const a = yield* spawn(() => allSettled([save(first)]));
          yield* firstArrived.operation;
          const b = yield* allSettled([save(second)]);
          const [initial] = yield* a;
          expect(initial.ok).toBe(true);
          expect(sources).toHaveLength(2);
          expect(sources[0] === sources[1]).toBe(old);
          expect(b[0].ok).toBe(!old);
          if (!b[0].ok) {
            expect(b[0].error).toMatchObject({ code: "ENOENT" });
          }
        } finally {
          fs.rename = rename;
          Date.now = now;
        }
        if (!old) {
          expect((yield* until(store.load("collision")))?.title).toBe("second");
          const loaded = yield* retainedSession(store, "collision");
          expect(loaded?.agentCommand).toBe("deterministic");
        }
      },
    );
  }

  it("a real rename error remains visible and leaves the prior committed record readable", function* () {
    const dir = yield* directory();
    const store = createAcpxSessionStore(dir);
    const record = {
      ...makeRecord("deterministic", dir),
      acpxRecordId: "failure",
      title: "committed",
    };
    yield* until(store.save(record));
    const path = join(dir, "sessions", "failure.json");
    const before = yield* readTextFile(path);
    const failure = Object.assign(new Error("injected rename failure"), { code: "EIO" });
    const rename = fs.rename;
    fs.rename = () => Promise.reject(failure);
    try {
      const [outcome] = yield* allSettled([until(store.save({ ...record, title: "uncommitted" }))]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({ code: "EIO" });
      }
    } finally {
      fs.rename = rename;
    }
    expect(yield* readTextFile(path)).toBe(before);
    expect((yield* until(store.load("failure")))?.title).toBe("committed");
  });
});
