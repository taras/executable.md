/**
 * Migration/schema conformance: every real Markdown component's `inputs`
 * frontmatter must parse and compile as a canonical draft-07 schema under the
 * project contract. This covers the `.reviews` component/policy directories the
 * smoke run never loads, and fails with the offending source path.
 */

import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import matter from "gray-matter";
import { readTextFile, walk } from "@effectionx/fs";
import { forEach } from "@effectionx/stream-helpers";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { compileInputSchema } from "../src/validate.ts";

const ROOT = new URL("../../", import.meta.url);
const COMPONENT_DIRS = [
  "core/components",
  "smoke-test",
  ".reviews/components",
  ".reviews/policies",
];

describe("component schema conformance", () => {
  it("every markdown component's inputs schema parses and compiles", function* () {
    const failures: string[] = [];
    let checked = 0;

    for (const dir of COMPONENT_DIRS) {
      yield* forEach(
        function* (entry) {
          if (!entry.isFile || !entry.path.endsWith(".md")) {
            return;
          }
          const source = yield* readTextFile(entry.path);
          const parsed = matter(source);
          // Only files that actually carry frontmatter declare inputs.
          if (Object.keys(parsed.data).length === 0) {
            return;
          }
          checked++;
          try {
            const { inputs } = parseFrontmatter(parsed.data);
            compileInputSchema(inputs);
          } catch (error) {
            failures.push(
              `${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        walk(new URL(`${dir}/`, ROOT)),
      );
    }

    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
