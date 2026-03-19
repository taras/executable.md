/**
 * Tier FC — Function component tests.
 *
 * Tests .ts files as components alongside .md files.
 */

import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-"));
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(files)) {
    const abs = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Tier FC — Function components", () => {
  it("FC1: basic function component returns string", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Hello.ts": [
          "export default function*() {",
          '  return "Hello from TypeScript!";',
          "}",
        ].join("\n"),
        "doc.md": "<Hello />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Hello from TypeScript!");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC2: function component with props", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Greet.ts": [
          "export const inputs = {",
          "  name: { type: 'string', required: true },",
          "};",
          "",
          "export default function*(props) {",
          "  return `Hello, ${props.name}!`;",
          "}",
        ].join("\n"),
        "doc.md": '<Greet name="world" />',
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Hello, world!");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC3: function component with useContent", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Wrapper.ts": [
          'import { useContent } from "@executablemd/core";',
          "",
          "export default function*() {",
          "  const childContent = yield* useContent();",
          "  return `BEFORE\\n${childContent}\\nAFTER`;",
          "}",
        ].join("\n"),
        "doc.md": [
          "<Wrapper>",
          "child content here",
          "</Wrapper>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("BEFORE");
      expect(output).toContain("child content here");
      expect(output).toContain("AFTER");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC4: .md wins over .ts when both exist", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Dual.md": [
          "---",
          "inputs: {}",
          "---",
          "FROM-MARKDOWN",
        ].join("\n"),
        "components/Dual.ts": [
          "export default function*() {",
          '  return "FROM-TYPESCRIPT";',
          "}",
        ].join("\n"),
        "doc.md": "<Dual />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("FROM-MARKDOWN");
      expect(output).not.toContain("FROM-TYPESCRIPT");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC5: function component error → ErrorSegment", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Broken.ts": [
          "export default function*() {",
          '  throw new Error("component error");',
          "}",
        ].join("\n"),
        "doc.md": "<Broken />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("component error");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC6: function component prop validation", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Typed.ts": [
          "export const inputs = {",
          "  count: { type: 'number', required: true },",
          "};",
          "",
          "export default function*(props) {",
          "  return `count=${props.count}`;",
          "}",
        ].join("\n"),
        "doc.md": '<Typed count={42} />',
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("count=42");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC7: function component missing required prop → error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Req.ts": [
          "export const inputs = {",
          "  name: { type: 'string', required: true },",
          "};",
          "",
          "export default function*(props) {",
          "  return `name=${props.name}`;",
          "}",
        ].join("\n"),
        "doc.md": "<Req />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Required prop");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC8: function component alongside markdown components", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/MdComp.md": [
          "---",
          "inputs: {}",
          "---",
          "FROM-MD",
        ].join("\n"),
        "components/TsComp.ts": [
          "export default function*() {",
          '  return "FROM-TS";',
          "}",
        ].join("\n"),
        "doc.md": [
          "<MdComp />",
          "",
          "<TsComp />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("FROM-MD");
      expect(output).toContain("FROM-TS");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC9: replay with function component", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Static.ts": [
          "export default function*() {",
          '  return "STATIC-OUTPUT";',
          "}",
        ].join("\n"),
        "doc.md": "<Static />",
      });
      const stream = new InMemoryStream();
      const output1 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      const output2 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output1).toContain("STATIC-OUTPUT");
      expect(output2).toBe(output1);
    } finally {
      cleanup(tmpDir);
    }
  });
});
