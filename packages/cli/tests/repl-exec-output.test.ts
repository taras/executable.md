import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { join } from "node:path";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import { useTempFileCompiler, Elicitation } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { openReplSession } from "../src/repl/session.ts";
import { useMountedHost } from "./support/mounted-repl.ts";

import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage } from "./support/repl-page.ts";
import { awaitedFact, mountedReading } from "./support/mounted-repl.ts";
import { intoComposer, pasteDraft, sidekickIdle } from "./support/screen-journeys.ts";

describe("E3 associated command Output", () => {
  it("shows captured controls as readable escapes in both entry readings", function* () {
    const received = "PROBE\x1b[2JTAIL\rEND";
    const displayed = "PROBE\\x1b[2JTAIL\\x0dEND";
    yield* API.Process.around({
      *exec() {
        yield* Stdio.operations.stdout(new TextEncoder().encode(received));
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    });
    const page = yield* useReplPage({ size: { columns: 160, rows: 44 } });
    const program = '```sh exec as="result"\ncontrolled-bound\n```\n{result.stdout}';
    page.repl.fake.script({
      reply:
        '<Let as="code" select="code">\n````xmd\n' +
        program +
        "\n````\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />",
    });
    page.repl.fake.script({ reply: "<Output>Probe completed.</Output>" });
    yield* intoComposer(page);
    yield* page.type("Run the probe");
    yield* page.key("Enter");
    const shown = yield* page.until(
      "the completed associated entry",
      (one) => one.shows("1 ✓") && sidekickIdle(one) && one.shows("Probe completed."),
    );
    const centerColumn = shown.locate("Entries").column;
    const sidekickColumn = shown.locate("BINDINGS").column;
    const center = shown.rows.map((row) => row.slice(centerColumn, sidekickColumn)).join("\n");
    const associated = shown.rows.map((row) => row.slice(sidekickColumn)).join("\n");
    expect(center).toContain(displayed);
    expect(associated).toContain(displayed);
    expect(center).not.toContain("�");
    expect(associated).not.toContain("�");
    expect(shown.occurrences(displayed)).toBe(2);
    const saved = yield* mountedReading(page.repl);
    const entry = saved.model.entries[0];
    expect(entry.terminal?.output).toContain(received);
    expect(entry.bindings.find((one) => one.name === "result")?.value).toEqual({
      stdout: received,
      stderr: "",
      exitCode: 0,
    });
    expect(entry.records.flatMap((one) => (one.exec === undefined ? [] : [one.exec]))).toEqual([
      { stdout: received, stderr: "", exitCode: 0 },
    ]);
  });
});

function* submit(page: ReplPage, source: string, order = 1): Operation<void> {
  yield* pasteDraft(page, source);
  yield* page.press("[send]", { onRow: " DRAFT" });
  yield* page.until(`entry ${order} admitted`, (one) =>
    ["●", "✓", "×"].some((status) => one.shows(`${order} ${status}`)),
  );
}

describe("REPL foreground command presentation E1", () => {
  it("E1: contains both real child streams in the producing entry before exit", function* () {
    const directory = yield* useTempDirectory("repl-output-");
    const release = join(directory, "release");
    const ready = join(directory, "ready");
    const leaks: { channel: string; text: string }[] = [];
    yield* ensure(() => {
      if (leaks.length > 0) {
        console.error(`foreground bypass evidence: ${JSON.stringify(leaks)}`);
      }
    });
    yield* Stdio.around(
      {
        *stdout([bytes]) {
          leaks.push({ channel: "stdout", text: new TextDecoder().decode(bytes) });
        },
        *stderr([bytes]) {
          leaks.push({ channel: "stderr", text: new TextDecoder().decode(bytes) });
        },
      },
      { at: "min" },
    );
    const page = yield* useReplPage({ size: { columns: 160, rows: 44 } });
    yield* submit(
      page,
      [
        "```sh exec",
        "printf 'live-%s\\n' stdout",
        "printf 'live-%s\\n' stderr >&2",
        `touch '${ready}'`,
        `while [ ! -f '${release}' ]; do sleep 0.02; done`,
        "```",
      ].join("\n"),
    );
    yield* awaitedFact("the child holding after both writes", () => exists(ready));
    expect(yield* exists(release)).toBe(false);
    yield* page.type("unsent entry draft");
    yield* page.until("the unsent draft", (one) => one.shows("unsent entry draft"));
    const during = yield* page.until(
      "both command channels inside the owning reading",
      (one) =>
        one.shows("live-stdout") &&
        one.shows("live-stderr") &&
        one.shows("Command stdout") &&
        one.shows("Command stderr"),
    );
    expect(leaks).toEqual([]);
    expect(during.shows("unsent entry draft")).toBe(true);
    expect(during.shows("No messages yet")).toBe(true);
    yield* page.type(" still focused");
    yield* page.until("the draft retaining focus", (one) => one.shows("still focused"));
    yield* writeTextFile(release, "release");
    yield* page.until("entry 1 settling", (one) => one.shows("1 ✓"));
    expect(page.screen().shows("live-stdout")).toBe(true);
    expect(page.screen().shows("live-stderr")).toBe(true);
    const saved = yield* mountedReading(page.repl);
    expect(saved.model.entries[0].terminal?.output.trim()).toBe("");
    expect(
      saved.model.entries[0].records.flatMap((one) => (one.exec === undefined ? [] : [one.exec])),
    ).toEqual([{ stdout: "live-stdout\n", stderr: "live-stderr\n", exitCode: 0 }]);
  });
});

describe("REPL command routing, containment and history E2–E5", () => {
  it("E2: keeps routing separate from document output, bindings and retained streams", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 52 } });
    yield* submit(
      page,
      [
        '```sh exec as="result"',
        "printf 'bound-%s\\n' stdout",
        "printf 'bound-%s\\n' stderr >&2",
        "exit 7",
        "```",
        "{result.stdout}",
        '<Let as="captured">',
        "```sh exec",
        "printf 'capture-%s\\n' stdout",
        "printf 'capture-%s\\n' stderr >&2",
        "```",
        "</Let>",
        "```sh silent exec",
        "printf 'hidden-%s\\n' stdout",
        "printf 'hidden-%s\\n' stderr >&2",
        "```",
      ].join("\n"),
    );
    const shown = yield* page.until("the routing comparison settling", (one) => one.shows("1 ✓"));
    expect(shown.occurrences("bound-stdout")).toBe(1);
    expect(shown.shows("bound-stderr")).toBe(false);
    expect(shown.shows("capture-stdout")).toBe(false);
    expect(shown.shows("capture-stderr")).toBe(true);
    expect(shown.shows("hidden-stdout")).toBe(false);
    expect(shown.shows("hidden-stderr")).toBe(false);
    const saved = yield* mountedReading(page.repl);
    const entry = saved.model.entries[0];
    expect(entry.terminal?.output.trim()).toBe("bound-stdout");
    expect(entry.bindings.find((one) => one.name === "result")?.value).toEqual({
      stdout: "bound-stdout\n",
      stderr: "bound-stderr\n",
      exitCode: 7,
    });
    expect(String(entry.bindings.find((one) => one.name === "captured")?.value)).toContain(
      "capture-stdout",
    );
    expect(entry.records.flatMap((one) => (one.exec === undefined ? [] : [one.exec]))).toEqual([
      { stdout: "bound-stdout\n", stderr: "bound-stderr\n", exitCode: 7 },
      { stdout: "capture-stdout\n", stderr: "capture-stderr\n", exitCode: 0 },
      { stdout: "hidden-stdout\n", stderr: "hidden-stderr\n", exitCode: 0 },
    ]);
  });

  it("E3: fits inert controls and independently decoded Unicode across resize", function* () {
    let emitted = false;
    const release = withResolvers<void>();
    const start = withResolvers<void>();
    const encoder = new TextEncoder();
    const controls = "\r\t\x1b[2J\x1b[H\x1b]0;owned\x07\x1b[?1049l\x9b";
    const long = "LONG".repeat(90) + "LONG-END";
    let calls = 0;
    yield* API.Process.around({
      *exec() {
        calls += 1;
        if (calls === 2) {
          yield* Stdio.operations.stdout(encoder.encode("captured\x1b[2J\r\tEND"));
          return { exitCode: 0, stdout: undefined, stderr: undefined };
        }
        yield* start.operation;
        const wide = encoder.encode("unicode-🦊-end\n");
        yield* Stdio.operations.stdout(wide.subarray(0, 10));
        yield* Stdio.operations.stderr(encoder.encode("interleaved-stderr\n"));
        yield* Stdio.operations.stdout(wide.subarray(10));
        for (const text of [controls.slice(0, 3), controls.slice(3), "\n", long, "\n"]) {
          yield* Stdio.operations.stdout(encoder.encode(text));
        }
        emitted = true;
        yield* release.operation;
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    });
    const page = yield* useReplPage({ size: { columns: 160, rows: 44 } });
    yield* ensure(() => {
      start.resolve();
      release.resolve();
    });
    yield* submit(
      page,
      '```sh exec\ncontrolled-output\n```\n\n```sh exec as="captured"\ncontrolled-bound\n```\n{captured.stdout}',
    );
    yield* page.until(
      "the admitted draft clearing",
      (one) => one.found("{captured.stdout}", { after: " DRAFT" }) === 0,
    );
    yield* page.type("draft stays");
    yield* page.until("the preserved draft", (one) => one.shows("draft stays"));
    yield* intoComposer(page);
    yield* page.type("message stays");
    yield* page.until("the preserved message", (one) => one.shows("message stays"));
    const paneColumn = page.screen().locate("BINDINGS").column;
    const neighbor = page.screen().rows.map((row) => row.slice(paneColumn));
    start.resolve();
    yield* page.until("the controlled process emitting its chunks", () => emitted);
    const shown = yield* page.until(
      "inert controls and split Unicode",
      (one) => one.shows("🦊-end") && one.shows("interleaved-stderr") && one.shows("\\x1b[2J"),
    );
    expect(shown.shows("�")).toBe(false);
    expect(shown.shows("\\x0d\\x09")).toBe(true);
    expect(shown.shows("\\x07")).toBe(true);
    expect(shown.shows("\\x9b")).toBe(true);
    expect(shown.shows("draft stays")).toBe(true);
    expect(shown.rows.map((row) => row.slice(paneColumn))).toEqual(neighbor);
    yield* page.type(" focused");
    yield* page.until("the message retaining focus", (one) => one.shows("message stays focused"));
    yield* page.resize({ columns: 72, rows: 24 });
    yield* page.resize({ columns: 160, rows: 44 });
    yield* page.until(
      "the restored drafts",
      (one) => one.shows("draft stays") && one.shows("message stays focused"),
    );
    // Wheel movement reads the whole fitted line without moving the composer.
    const at = page.screen().locate("interleaved-stderr");
    let tail = false;
    for (let step = 0; step < 24 && !tail; step += 1) {
      const before = page.screen().index;
      yield* page.wheel("down", at);
      const scrolled = yield* page.until("the reading scrolling", (one) => one.index > before);
      tail = scrolled.shows("LONG-END");
    }
    expect(tail).toBe(true);
    release.resolve();
    yield* page.until("the controlled entry settling", (one) => one.shows("1 ✓"));
    const saved = yield* mountedReading(page.repl);
    const entry = saved.model.entries[0];
    const execs = entry.records.flatMap((one) => (one.exec === undefined ? [] : [one.exec]));
    expect(execs[0]).toEqual({
      stdout: `unicode-🦊-end\n${controls}\n${long}\n`,
      stderr: "interleaved-stderr\n",
      exitCode: 0,
    });
    expect(entry.terminal?.output).toContain("captured\x1b[2J\r\tEND");
    // The output reading starts above the command sections and escapes the copy.
    for (
      let step = 0;
      step < 24 && !page.screen().shows("captured\\x1b[2J\\x0d\\x09END");
      step += 1
    ) {
      const before = page.screen().index;
      yield* page.wheel("up", at);
      yield* page.until("returning to rendered output", (one) => one.index > before);
    }
    expect(page.screen().shows("captured\\x1b[2J\\x0d\\x09END")).toBe(true);
  });

  for (const cancel of [false, true]) {
    it(`E4: owns diagnostics through held ${cancel ? "cancelled" : "failed"} cleanup and join`, function* () {
      yield* useTempFileCompiler();
      const release = withResolvers<void>();
      let cleaning = false;
      let working = false;
      let installs = 0;
      let secret = "";
      let retained = "";
      const encoder = new TextEncoder();
      const opened = yield* openReplSession({
        execution: { id: "cleanup-output", stream: new InMemoryStream() },
        installations: [
          {
            *install() {
              installs += 1;
              const first = installs === 1;
              yield* Elicitation.around({
                *elicit() {
                  secret = String(Math.floor(100000 + Math.random() * 900000));
                  return { code: secret };
                },
              });
              if (first) {
                yield* ensure(function* () {
                  yield* Stdio.operations.stderr(
                    encoder.encode("cleanup-diagnostic " + retained.slice(0, 3)),
                  );
                  cleaning = true;
                  yield* release.operation;
                  yield* Stdio.operations.stderr(
                    encoder.encode(retained.slice(3) + "\ncleanup-joined\n"),
                  );
                });
              }
              yield* API.Process.around({
                *exec([options]) {
                  if (first) {
                    retained = options.command[2].trim().slice("controlled-cleanup ".length);
                    expect(retained === secret).toBe(true);
                  }
                  yield* Stdio.operations.stdout(
                    encoder.encode(first ? "producer-output\n" : "successor-output\n"),
                  );
                  working = true;
                  if (first && cancel) {
                    yield* suspend();
                  }
                  return { exitCode: first ? 3 : 0, stdout: undefined, stderr: undefined };
                },
              });
            },
          },
        ],
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const session = opened.value;
      yield* ensure(() => {
        release.resolve();
      });
      const admitted = yield* session.submit(
        [
          "```ts eval",
          'const schema = {type:"object",properties:{code:{type:"string",writeOnly:true}},required:["code"],additionalProperties:false};',
          "```",
          '<Elicit schema={schema} as="answer">Code</Elicit>',
          "```sh exec",
          "controlled-cleanup {answer.code}",
          "```",
        ].join("\n\n"),
      );
      expect(admitted.ok).toBe(true);
      yield* awaitedFact("the process starting", function* () {
        return working;
      });
      const finished = yield* spawn(() => (cancel ? session.stopEntry("entry-1") : session.join()));
      yield* awaitedFact("cleanup holding after emitting diagnostics", function* () {
        return cleaning;
      });
      const during = session.commandOutput;
      expect(during[0].entry).toBe("entry-1");
      expect(during[0].chunks).toEqual([
        { channel: "stdout", text: "producer-output\n" },
        { channel: "stderr", text: "cleanup-diagnostic " },
      ]);
      expect(JSON.stringify(session.commandOutput).includes(secret)).toBe(false);
      expect(session.live).toBe(true);
      const refused = yield* session.submit("must not start");
      expect(refused.ok).toBe(false);
      expect(session.model.entries).toHaveLength(1);
      release.resolve();
      const outcome = yield* finished;
      expect(JSON.stringify(session.commandOutput).includes(secret)).toBe(false);
      expect(outcome.ok).toBe(cancel);
      expect(session.model.entries[0].terminal?.status).toBe(cancel ? "cancelled" : "err");
      expect(session.commandOutput[0].chunks[1].text).toBe(
        "cleanup-diagnostic [redacted]\ncleanup-joined\n",
      );
      expect(during[0].chunks[1].text).toBe("cleanup-diagnostic ");
      expect(Object.isFrozen(during[0].chunks)).toBe(true);
      expect((yield* session.submit("```sh exec\nsuccessor\n```")).ok).toBe(true);
      expect((yield* session.join()).ok).toBe(true);
      expect(session.commandOutput.map((one) => [one.entry, one.chunks])).toEqual([
        [
          "entry-1",
          [
            { channel: "stdout", text: "producer-output\n" },
            { channel: "stderr", text: "cleanup-diagnostic [redacted]\ncleanup-joined\n" },
          ],
        ],
        ["entry-2", [{ channel: "stdout", text: "successor-output\n" }]],
      ]);
    });
  }

  it("E4: keeps late output with its producer while history and Sidekick are selected", function* () {
    const more = withResolvers<void>();
    const release = withResolvers<void>();
    let entries = 0;
    let cleaning = false;
    let laterWritten = false;
    const page = yield* useReplPage({
      size: { columns: 160, rows: 44 },
      entryInstallation: function* () {
        entries += 1;
        if (entries === 2) {
          yield* ensure(function* () {
            yield* Stdio.operations.stderr(new TextEncoder().encode("cleanup-before-history\n"));
            cleaning = true;
            yield* more.operation;
            yield* Stdio.operations.stderr(new TextEncoder().encode("cleanup-after-history\n"));
            laterWritten = true;
            yield* release.operation;
          });
        }
        return {};
      },
    });
    yield* ensure(() => {
      more.resolve();
      release.resolve();
    });
    yield* submit(page, "older answer");
    yield* page.until("the earlier entry settling", (one) => one.shows("1 ✓"));
    yield* submit(page, "```sh exec\nprintf 'producer-%s\\n' diagnostic >&2\nexit 3\n```", 2);
    yield* awaitedFact("the provider holding cleanup", function* () {
      return cleaning;
    });
    yield* page.until("cleanup displayed after root Close", (one) =>
      one.shows("cleanup-before-history"),
    );
    yield* page.type("entry draft remains");
    yield* page.until("the entry draft", (one) => one.shows("entry draft remains"));
    yield* page.press("[history]");
    yield* page.until("the history checkpoints", (one) => one.shows("Entry 1 admitted"));
    yield* page.press("Entry 1 admitted", { rightOf: "[close]" });
    yield* page.until("the frozen earlier entry", (one) => one.shows("[live]"));
    yield* page.press("[close]");
    yield* page.until("the checkpoint drawer closing", (one) => !one.shows("[close]"));
    page.repl.fake.script({ reply: "<Output>background-answer</Output>" });
    yield* intoComposer(page);
    yield* page.type("background-request");
    yield* page.until("the background request", (one) => one.shows("background-request"));
    yield* page.key("Enter");
    yield* page.until(
      "the scripted Sidekick exchange",
      (one) => one.shows("background-answer") && sidekickIdle(one),
    );
    yield* page.type("message draft");
    yield* page.until("the message draft", (one) => one.shows("message draft"));
    more.resolve();
    yield* awaitedFact("late diagnostics arriving at the earlier selection", function* () {
      return laterWritten;
    });
    yield* page.type(" focused");
    const frozen = yield* page.until("focus and selection surviving late output", (one) =>
      one.shows("message draft focused"),
    );
    expect(frozen.shows("[live]")).toBe(true);
    expect(frozen.shows("Entry 1")).toBe(true);
    expect(frozen.shows("entry draft remains")).toBe(true);
    expect(frozen.shows("cleanup-after-history")).toBe(false);
    expect(frozen.shows("Command stderr")).toBe(false);
    yield* page.press("[live]");
    yield* page.until(
      "the producer reading",
      (one) => !one.shows("[live]") && one.shows("cleanup-after-history"),
    );
    release.resolve();
    yield* page.until(
      "the failed entry finishing cleanup",
      (one) => one.shows("2 ×") && !one.shows("[stop]"),
    );
    const saved = yield* mountedReading(page.repl);
    expect(saved.model.entries).toHaveLength(2);
    expect(saved.model.entries[1].terminal?.status).toBe("err");
  });

  it("E5: cold inspection retains exact per-entry diagnostics without starting commands", function* () {
    let starts = 0;
    let asks = 0;
    let secret = "";
    yield* Elicitation.around({
      *elicit() {
        asks++;
        secret = String(Math.floor(100000 + Math.random() * 900000));
        return { code: secret };
      },
    });
    yield* API.Process.around({
      *exec([options], next) {
        starts += 1;
        return yield* next(options);
      },
    });
    const host = yield* useMountedHost();
    const before = yield* scoped(function* () {
      const page = yield* useReplPage({ host, size: { columns: 160, rows: 44 } });
      yield* submit(
        page,
        '<Elicit schema={{type:"object",properties:{code:{type:"string",writeOnly:true}},required:["code"],additionalProperties:false}} as="answer">Code</Elicit>\n\n' +
          "```sh exec\nprintf 'first-%s\\n' output\nprintf 'first-%s\\n' diagnostic >&2\n# {answer.code}\n```",
      );
      yield* page.until("the first retained entry", (one) => one.shows("1 ✓"));
      yield* submit(
        page,
        "```ts eval\nconst priorSafe = String(answer.code);\n```\n<Json value={priorSafe} />\n```sh silent exec\nprintf 'hidden-%s\\n' output\n```\n```sh exec as=\"result\"\nprintf 'bound-%s\\n' output\nprintf 'bound-%s\\n' diagnostic >&2\nexit 7\n```",
        2,
      );
      yield* page.until("the second retained entry", (one) => one.shows("2 ✓"));
      const saved = yield* mountedReading(page.repl);
      const opened = yield* host.repository.open(saved.execution);
      return { ...saved, events: yield* opened.stream.readAll() };
    });
    expect(starts).toBe(3);
    expect(asks).toBe(1);
    expect(JSON.stringify(before.events).includes(secret)).toBe(false);
    const at = before.model.entries[0].checkpoints.at(-1)?.marker;
    if (at === undefined) {
      throw new Error("the first entry retained no completed position");
    }
    yield* scoped(function* () {
      const page = yield* useReplPage({
        host,
        location: `xmd://repl/${before.execution}/entries/entry-1?at=${encodeURIComponent(at)}`,
      });
      expect(page.screen().shows("Command stdout")).toBe(false);
      expect(page.screen().shows("hidden-output")).toBe(false);
      expect(page.screen().shows("bound-output")).toBe(false);
      yield* page.press("[live]");
      yield* page.until("the live head of saved history", (one) => !one.shows("[live]"));
      const after = yield* mountedReading(page.repl);
      expect(after.model.entries.map((entry) => entry.records)).toEqual(
        before.model.entries.map((entry) => entry.records),
      );
      expect(
        after.model.entries[0].records.flatMap((one) => (one.exec === undefined ? [] : [one.exec])),
      ).toEqual([{ stdout: "first-output\n", stderr: "first-diagnostic\n", exitCode: 0 }]);
      expect(
        after.model.entries[1].records.flatMap((one) => (one.exec === undefined ? [] : [one.exec])),
      ).toEqual([
        { stdout: "hidden-output\n", stderr: "", exitCode: 0 },
        { stdout: "bound-output\n", stderr: "bound-diagnostic\n", exitCode: 7 },
      ]);
      const opened = yield* host.repository.open(before.execution);
      expect(yield* opened.stream.readAll()).toEqual(before.events);
      expect(starts).toBe(3);
      expect(asks).toBe(1);
      expect(JSON.stringify(after.model).includes(secret)).toBe(false);
      expect(host.fake.prompts).toEqual([]);
    });
  });
});
