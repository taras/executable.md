import { until } from "effection";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

const ROOT = new URL("../../", import.meta.url);
const UPSTREAM =
  "https://raw.githubusercontent.com/TechNomadCode/AI-Product-Development-Toolkit/ed41972dff92cdbc94a60b2464531669900e602f/agent-configs/claude-code-desktop/claude-opus-5/CLAUDE.md";
const BEGIN = "<!-- BEGIN PINNED UPSTREAM CLAUDE.md -->\n";
const END = "\n<!-- END PINNED UPSTREAM CLAUDE.md -->";

function extractUpstream(document: string): string {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END, start + BEGIN.length);
  if (start < 0 || end < 0) {
    throw new Error("CLAUDE.md is missing its pinned upstream markers");
  }
  return document.slice(start + BEGIN.length, end);
}

function removeExcludedBullet(document: string): string {
  const label = ["Context", "7"].join(" ");
  const bullet = new RegExp(`^- \\*\\*${label} MCP Usage\\*\\*: [^\\n]*\\n`, "m");
  const result = document.replace(bullet, "");
  if (result === document) {
    throw new Error("the pinned upstream document did not contain the excluded bullet");
  }
  return result;
}

function* fetchUpstream(): Operation<string> {
  const response = yield* until(fetch(UPSTREAM));
  if (!response.ok) {
    throw new Error(`unable to fetch pinned upstream document: ${response.status}`);
  }
  return yield* until(response.text());
}

describe("Claude Code project instructions", () => {
  it("matches the pinned upstream document after the excluded bullet is removed", function* () {
    const document = yield* readTextFile(new URL("CLAUDE.md", ROOT));
    expect(extractUpstream(document)).toBe(removeExcludedBullet(yield* fetchUpstream()));
  });
});
