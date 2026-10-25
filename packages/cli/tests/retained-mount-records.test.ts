import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Divergence, type DivergenceDecision } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import { authoredOperation } from "@executablemd/core/host";
import { R1_WIN32 } from "../../test-support/mount-fixture.ts";
import {
  mountAuthored,
  mountFingerprint,
  mountName,
  mountRecordJson,
  parseMountRecord,
  MountRecordError,
} from "../src/repl/mount-records.ts";
import {
  parseReplLocalRecord,
  replLocalFingerprint,
  replLocalRecordJson,
} from "../src/repl/repositories/records.ts";
import { Ok } from "effection";
import { mountedRun, trace } from "./support/mount-run.ts";

describe("mount record consistency", () => {
  it("R1-WIN32 refuses a fully hashed but component-changing original binding", function* () {
    const f = R1_WIN32;
    const a = authoredOperation("dir-ensure", "r1", f.operand, {
      authoredDirectory: f.target,
      actualDirectory: f.source,
      namespace: "document",
      interpreting: true,
    });
    const request = { cwd: f.source, path: f.escaped };
    const record: MountRecord = {
      version: 1,
      operation: "dir-ensure",
      authored: mountAuthored(a),
      authoredFingerprint: yield* mountFingerprint({
        operation: "dir-ensure",
        authored: mountAuthored(a),
      }),
      binding: {
        pathStyle: "win32",
        selected: { source: f.source, target: f.target },
        enclosing: {
          authoredDirectory: f.target,
          actualDirectory: f.source,
          namespace: "document",
          pair: { source: f.source, target: f.target },
        },
        destination: { authored: a.destination, actual: f.escaped },
      },
      coverage: { kind: "existing", owner: "session", root: "C:\\work", target: f.escaped },
      physical: replLocalRecordJson({
        operation: "dir-ensure",
        request,
        outcome: Ok(undefined),
        fingerprint: yield* replLocalFingerprint({ operation: "dir-ensure", request }),
      }),
    };
    let failure: unknown;
    try {
      yield* parseMountRecord(record);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MountRecordError);
    const calls = trace();
    let admission: unknown;
    try {
      yield* mountedRun(
        '<Dir path="/reference">unreachable</Dir>',
        new InMemoryStream([
          {
            type: "yield",
            coroutineId: "root",
            description: { type: "repl_mount_file/v1", name: mountName(record) },
            result: { status: "ok", value: mountRecordJson(record) },
          },
        ]),
        [{ source: "/owned", target: "/reference" }],
        calls,
      );
    } catch (error) {
      admission = error;
    }
    expect(admission).toBeInstanceOf(MountRecordError);
    expect(calls.ensures).toEqual([]);
    expect(calls.reads).toEqual([]);
  });
  it("rejects changed authorship before any live read or ensure", function* () {
    const stream = new InMemoryStream();
    const source =
      '<Dir path="/reference"><File path="first.md" /><Elicit schema={{ type: "object" }} as="answer">wait</Elicit></Dir>';
    yield* mountedRun(
      source,
      stream,
      [{ source: "/owned/source", target: "/reference" }],
      trace(),
      { pause: true, workspace: "/owned" },
    );
    const changed = yield* stream.readAll();
    for (const event of changed) {
      if (
        event.type !== "yield" ||
        event.description.type !== "repl_mount_file/v1" ||
        event.result.status !== "ok"
      ) {
        continue;
      }
      const record = yield* parseMountRecord(event.result.value);
      if (record.operation !== "file-read") {
        continue;
      }
      record.authored.path = "changed.md";
      record.authored.destination = "/reference/changed.md";
      record.binding.destination.authored = record.authored.destination;
      record.binding.destination.actual = "/owned/source/changed.md";
      record.coverage = {
        kind: "existing",
        owner: "session",
        root: "/owned",
        target: "/owned/source/changed.md",
      };
      const request = { cwd: "/owned/source", path: "changed.md" };
      record.physical = replLocalRecordJson({
        operation: "file-read",
        request,
        outcome: Ok("retained"),
        fingerprint: yield* replLocalFingerprint({ operation: "file-read", request }),
      });
      record.authoredFingerprint = yield* mountFingerprint(record);
      event.description.name = mountName(record);
      event.result = { status: "ok", value: mountRecordJson(record) };
    }
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        source,
        new InMemoryStream(changed),
        [{ source: "/owned/new", target: "/reference" }],
        calls,
        { workspace: "/owned" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(calls.reads).toEqual([]);
    expect(calls.ensures).toEqual([]);
  });
});

import type { MountRecord } from "../src/repl/mount-records.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import { REPL_REPOSITORY_LOCAL, replLocalRecordName } from "../src/repl/repositories/records.ts";
const pausedSource =
  '<Dir path="/reference"><File path="first.md" /><Elicit schema={{ type: "object" }} as="answer">wait</Elicit></Dir>';
function* fixture() {
  const stream = new InMemoryStream();
  yield* mountedRun(
    pausedSource,
    stream,
    [{ source: "/owned/source", target: "/reference" }],
    trace(),
    { pause: true, workspace: "/owned" },
  );
  return yield* stream.readAll();
}
function* replaceEnsure(events: DurableEvent[], mutate: (record: MountRecord) => void) {
  for (const event of events) {
    if (
      event.type !== "yield" ||
      event.description.type !== "repl_mount_file/v1" ||
      event.result.status !== "ok"
    ) {
      continue;
    }
    const record = yield* parseMountRecord(event.result.value);
    if (record.operation !== "dir-ensure") {
      continue;
    }
    mutate(record);
    record.authoredFingerprint = yield* mountFingerprint(record);
    event.description.name = mountName(record);
    event.result = { status: "ok", value: mountRecordJson(record) };
  }
}
describe("closed association admission", () => {
  const changes: { name: string; mutate(record: MountRecord): void }[] = [
    {
      name: "occurrence",
      mutate(record) {
        record.authored.occurrence += "-changed";
      },
    },
    {
      name: "form",
      mutate(record) {
        record.authored.form = "self-closing";
      },
    },
    {
      name: "operand",
      mutate(record) {
        record.authored.path = "/reference/.";
      },
    },
    {
      name: "enclosing authored directory",
      mutate(record) {
        record.authored.directory = "/changed";
      },
    },
    {
      name: "namespace",
      mutate(record) {
        record.authored.namespace = "document";
        record.binding.enclosing.namespace = "document";
      },
    },
    {
      name: "absolute destination",
      mutate(record) {
        record.authored.destination = "/reference/changed";
      },
    },
    {
      name: "original binding",
      mutate(record) {
        record.binding.destination.actual = "/owned/wrong";
      },
    },
    {
      name: "ensure coverage",
      mutate(record) {
        record.coverage = { kind: "external-mapped-read" };
      },
    },
    {
      name: "version",
      mutate(record) {
        Reflect.set(record, "version", 2);
      },
    },
    {
      name: "closed shape",
      mutate(record) {
        Reflect.set(record, "extra", true);
      },
    },
  ];
  changes.push({
    name: "physical hash",
    mutate(record) {
      if (typeof record.physical === "object" && record.physical !== null) {
        Reflect.set(record.physical, "fingerprint", "0".repeat(64));
      }
    },
  });
  function* allowRunLive() {
    yield* Divergence.around({
      decide(): DivergenceDecision {
        return { type: "run-live" };
      },
    });
  }
  for (const row of changes) {
    it(`refuses changed ${row.name} before any provider effect`, function* () {
      const events = yield* fixture();
      yield* replaceEnsure(events, row.mutate);
      const calls = trace();
      let failure: unknown;
      try {
        yield* mountedRun(
          pausedSource,
          new InMemoryStream(events),
          [{ source: "/owned/new", target: "/reference" }],
          calls,
          { workspace: "/owned", before: allowRunLive },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(calls.ensures).toEqual([]);
      expect(calls.reads).toEqual([]);
    });
  }
  it("refuses a recomputed physical hash whose request disagrees with the original binding", function* () {
    const events = yield* fixture();
    for (const event of events) {
      if (
        event.type !== "yield" ||
        event.description.type !== "repl_mount_file/v1" ||
        event.result.status !== "ok"
      ) {
        continue;
      }
      const record = yield* parseMountRecord(event.result.value);
      if (record.operation !== "dir-ensure") {
        continue;
      }
      const request = { cwd: "/host", path: "/owned/wrong" };
      record.physical = replLocalRecordJson({
        operation: "dir-ensure",
        request,
        outcome: Ok(undefined),
        fingerprint: yield* replLocalFingerprint({ operation: "dir-ensure", request }),
      });
      event.result = { status: "ok", value: mountRecordJson(record) };
    }
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        pausedSource,
        new InMemoryStream(events),
        [{ source: "/owned/new", target: "/reference" }],
        calls,
        { workspace: "/owned" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MountRecordError);
    expect(calls.ensures).toEqual([]);
    expect(calls.reads).toEqual([]);
  });
  it("refuses covered-ensure omission at its own boundary", function* () {
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(pausedSource, new InMemoryStream(yield* fixture()), [], calls, {
        workspace: "/owned",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MountRecordError);
    expect(calls.ensures).toEqual([]);
    expect(calls.reads).toEqual([]);
  });
  it("keeps physical-only v1 results physical and refuses a changed request without upgrade", function* () {
    const events = yield* fixture();
    for (const event of events) {
      if (
        event.type !== "yield" ||
        event.description.type !== "repl_mount_file/v1" ||
        event.result.status !== "ok"
      ) {
        continue;
      }
      const record = yield* parseMountRecord(event.result.value);
      const physical = parseReplLocalRecord(record.physical);
      if (physical === undefined) {
        throw new Error("fixture physical record missing");
      }
      event.description = { type: REPL_REPOSITORY_LOCAL, name: replLocalRecordName(physical) };
      event.result = { status: "ok", value: replLocalRecordJson(physical) };
    }
    const same = new InMemoryStream(events);
    const calls = trace();
    yield* mountedRun(
      pausedSource,
      same,
      [{ source: "/owned/source", target: "/reference" }],
      calls,
      { workspace: "/owned" },
    );
    expect(calls.ensures).toEqual([]);
    expect(calls.reads).toEqual([]);
    expect(
      (yield* same.readAll()).some(
        (event) => event.type === "yield" && event.description.type === "repl_mount_file/v1",
      ),
    ).toBe(false);
    const changed = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        pausedSource,
        new InMemoryStream(events),
        [{ source: "/owned/new", target: "/reference" }],
        changed,
        { workspace: "/owned" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(changed.ensures).toEqual([]);
    expect(changed.reads).toEqual([]);
  });
});
