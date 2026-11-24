/**
 * Tier SIN — Structural indentation and standalone lines (spec §2.2).
 *
 * SIN1–SIN11 are the accepted formatter examples; SIN12 covers a standalone
 * element whose indentation remains after the prefix. Each runs through
 * `execute()` against the host Files provider in a scratch workspace. Where
 * whitespace is the subject, the assertion is the exact file bytes, rendered
 * text or shell output.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { join } from "node:path";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { scanSegments } from "../src/scanner.ts";
import { asText } from "./helpers.ts";

interface Run {
  /** The document's rendered text. */
  output: string;
  /** What executable blocks wrote to the display's stdout. */
  stdout: string;
  /** Read a file the document left in the workspace. */
  read(name: string): Operation<string>;
}

/** Run `source` as `doc.md` in a fresh workspace holding `files`. */
function run(source: string, files: Record<string, string> = {}): Operation<Run> {
  return scoped(function* () {
    const workspace = yield* useTempDirectory("xmd-sin-");
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(join(workspace, name), content);
    }
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return workspace;
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    let stdout = "";
    const decoder = new TextDecoder();
    yield* Stdio.around(
      {
        // deno-lint-ignore require-yield
        *stdout([bytes]) {
          stdout += decoder.decode(bytes);
        },
      },
      { at: "min" },
    );
    const output = asText(
      yield* collect(yield* execute({ path, stream: new InMemoryStream(), includes: [workspace] })),
    );
    const contents: Record<string, string> = {};
    for (const name of ["message.txt", "status.txt", "tabs.txt", "blank.txt"]) {
      try {
        contents[name] = yield* readTextFile(join(workspace, name));
      } catch {
        // Not every document writes every file.
      }
    }
    return {
      output,
      stdout,
      // deno-lint-ignore require-yield
      *read(name: string) {
        const content = contents[name];
        if (content === undefined) {
          throw new Error(`the document wrote no ${name}`);
        }
        return content;
      },
    };
  });
}

/** An inline `<If>` standing alone in a loose list item. */
function pairedInListItem(condition: boolean): string {
  return [
    "<Output>",
    "  - First",
    "",
    `    <If condition={${condition}}>Ready</If>`,
    "  - Last",
    "</Output>",
    "",
  ].join("\n");
}

describe("Tier SIN — structural indentation", () => {
  it("SIN1: a block's body loses one structural prefix per enclosing block", function* () {
    const result = yield* run(
      [
        '<File path="message.txt">',
        "  <If condition={true}>",
        "    Hello",
        "",
        "      Keep two leading spaces.",
        "  </If>",
        "</File>",
        "",
      ].join("\n"),
    );
    expect(yield* result.read("message.txt")).toBe("Hello\n\n  Keep two leading spaces.\n");
  });

  it("SIN2: a line without the full prefix keeps all of its spaces", function* () {
    const unformatted = yield* run(
      [
        '<File path="message.txt">',
        "  <If condition={true}>",
        "    Four source spaces.",
        "  Two source spaces.",
        "No source spaces.",
        "  </If>",
        "</File>",
        "",
      ].join("\n"),
    );
    const formatted = yield* run(
      [
        '<File path="message.txt">',
        "  <If condition={true}>",
        "    Four source spaces.",
        "      Two source spaces.",
        "    No source spaces.",
        "  </If>",
        "</File>",
        "",
      ].join("\n"),
    );
    const expected = "Four source spaces.\n  Two source spaces.\nNo source spaces.\n";
    expect(yield* unformatted.read("message.txt")).toBe(expected);
    expect(yield* formatted.read("message.txt")).toBe(expected);
  });

  it("SIN3: an inline element adds no level and keeps its surrounding spaces", function* () {
    const result = yield* run(
      [
        '<File path="status.txt">',
        "  Status: <If condition={true}>ready</If> now.",
        "</File>",
        "",
      ].join("\n"),
    );
    expect(yield* result.read("status.txt")).toBe("Status: ready now.\n");
  });

  it("SIN4: a standalone invocation supplies its newline only when its text needs one", function* () {
    const source = [
      "<Output>",
      "  Before",
      '  <File path="name.txt" />',
      "  After",
      "</Output>",
      "",
    ].join("\n");
    const cases: [string, string][] = [
      ["", "Before\nAfter\n"],
      ["Ada", "Before\nAda\nAfter\n"],
      ["Ada\n", "Before\nAda\nAfter\n"],
      ["Ada\n\n", "Before\nAda\n\nAfter\n"],
    ];
    for (const [contents, expected] of cases) {
      const result = yield* run(source, { "name.txt": contents });
      expect({ contents, output: result.output }).toEqual({ contents, output: expected });
    }
  });

  it("SIN5: an opening tag split across lines is one delimiter", function* () {
    const result = yield* run(
      [
        "<Output>",
        "  <If",
        "    condition={true}",
        "  >",
        "    Hello",
        "  </If>",
        "</Output>",
        "",
      ].join("\n"),
    );
    expect(result.output).toBe("Hello\n");
  });

  it("SIN6: Markdown indentation beyond the structural prefix reaches Markdown", function* () {
    const list = yield* run(
      ["<Output>", "  - First item", "    - Nested item", "  - Last item", "</Output>", ""].join(
        "\n",
      ),
    );
    expect(list.output).toBe("- First item\n  - Nested item\n- Last item\n");

    const item = yield* run(
      [
        "<Output>",
        "  - Status",
        "    <If condition={true}>",
        "      Ready",
        "    </If>",
        "  - Next",
        "</Output>",
        "",
      ].join("\n"),
    );
    expect(item.output).toBe("- Status\n  Ready\n- Next\n");
  });

  it("SIN7: a fence moves with its enclosing block, and its content keeps its own indentation", function* () {
    const source = [
      "<If condition={true}>",
      "  ```bash exec",
      "  cat <<'TEXT'",
      "    Keep two leading spaces.",
      "  TEXT",
      "  ```",
      "</If>",
      "",
    ].join("\n");
    const [block] = scanSegments(source);
    expect(block?.type === "component" ? block.children : []).toEqual([
      expect.objectContaining({
        type: "codeBlock",
        content: "cat <<'TEXT'\n  Keep two leading spaces.\nTEXT\n",
      }),
    ]);
    const result = yield* run(source);
    expect(result.stdout).toBe("  Keep two leading spaces.\n");
  });

  it("SIN8: a tag indented four columns past its prefix after a blank line is Markdown code", function* () {
    const result = yield* run(
      [
        "<Output>",
        "  <If condition={true}>",
        "    <If condition={true}>",
        "      Ready",
        "    </If>",
        "  </If>",
        "",
        "      <If condition={true}>Show this as code.</If>",
        "</Output>",
        "",
      ].join("\n"),
    );
    expect(result.output).toBe("Ready\n\n    <If condition={true}>Show this as code.</If>\n");
  });

  it("SIN9: the structural prefix is spaces, and a content tab is kept", function* () {
    for (const line of ["  \tIndented with a tab\n", "\tIndented with a tab\n"]) {
      const result = yield* run(`<File path="tabs.txt">\n${line}</File>\n`);
      expect({ line, written: yield* result.read("tabs.txt") }).toEqual({
        line,
        written: "\tIndented with a tab\n",
      });
    }
  });

  it("SIN10: a blank line keeps the spaces beyond its prefix", function* () {
    const cases: [string, string][] = [
      ["\n", "\n"],
      ["  \n", "\n"],
      ["    \n", "  \n"],
    ];
    for (const [line, written] of cases) {
      const result = yield* run(`<File path="blank.txt">\n${line}</File>\n`);
      expect({ line, written: yield* result.read("blank.txt") }).toEqual({ line, written });
    }
  });

  it("SIN12: a standalone element in a loose list item keeps its content indentation", function* () {
    const selfClosing = [
      "<Output>",
      "  - First",
      "",
      '    <File path="name.txt" />',
      "  - Last",
      "</Output>",
      "",
    ].join("\n");
    const cases: [string, string][] = [
      ["Ada", "- First\n\n  Ada\n- Last\n"],
      ["Ada\n", "- First\n\n  Ada\n- Last\n"],
      ["", "- First\n\n- Last\n"],
    ];
    for (const [contents, expected] of cases) {
      const result = yield* run(selfClosing, { "name.txt": contents });
      expect({ contents, output: result.output }).toEqual({ contents, output: expected });
    }

    expect((yield* run(pairedInListItem(true))).output).toBe("- First\n\n  Ready\n- Last\n");
    expect((yield* run(pairedInListItem(false))).output).toBe("- First\n\n- Last\n");
  });

  it("SIN11: a standalone invocation at the end of the source has no newline to supply", function* () {
    for (const contents of ["Ada", "Ada\n"]) {
      const result = yield* run('<File path="name.txt" />', { "name.txt": contents });
      expect({ contents, output: result.output }).toEqual({ contents, output: contents });
    }
  });
});

describe("Markdown boundary execution", () => {
  it("preserves quoted passive bytes and executes a root tag after a list fence", function* () {
    const quote = '> ~~~bash exec\n> <File path="absent.txt" />  \n> {source} **\t\n> ~~~\n';
    const list = '- item\n\n  ~~~\n  <File path="absent.txt" />\n';
    const result = yield* run(quote + "\n" + list + '<File path="name.txt" />\n', {
      "name.txt": "Ada",
    });
    expect(result.output).toBe(quote + "\n" + list + "Ada\n");
  });

  it("retains loose nested list indentation with tabs and keeps code inert", function* () {
    const source =
      '<Output>\n  10.\tOuter\n\n  \t-\tInner\n\n  \t\t<File path="name.txt" />\n\n  \t\t\t<File path="absent.txt" />\n</Output>\n';
    const result = yield* run(source, { "name.txt": "Ada" });
    expect(result.output).toBe(
      '10.\tOuter\n\n\t-\tInner\n\n\t\tAda\n\n\t\t\t<File path="absent.txt" />\n',
    );
  });

  it("keeps HTML tags eligible and physical executable fences active inside HTML", function* () {
    const source =
      '<pre>\n    <File path="name.txt" />\n~~~bash exec\nprintf shell\n~~~\n    <File path="name.txt" />\n</pre>\n';
    const result = yield* run(source, { "name.txt": "Ada" });
    expect(result.output).toBe("<pre>\n    Ada\n    Ada\n</pre>\n");
    expect(result.stdout).toBe("shell");
  });

  it("refuses both multiline header violations before an earlier file effect", function* () {
    const workspace = yield* useTempDirectory("xmd-header-refusal-");
    const file = join(workspace, "early.txt");
    const path = join(workspace, "doc.md");
    yield* useHostFiles();
    for (const [malformed, message] of [
      ["Before <If\n  condition={true}\n>Ready</If>\n", "starts after prose"],
      [
        "10. First\n\n    <If condition={true /*\n\n1. Phantom\n    */}>\n      Ready\n    </If>\n",
        "crosses its Markdown list item",
      ],
    ]) {
      yield* writeTextFile(path, `<File path=${JSON.stringify(file)}>early</File>\n\n` + malformed);
      let failure: unknown;
      try {
        yield* collect(yield* execute({ path, stream: new InMemoryStream() }));
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain(message);
      expect(yield* exists(file)).toBe(false);
    }
  });
});
