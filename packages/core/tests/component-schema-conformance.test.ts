import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import matter from "gray-matter";
import { readTextFile, walk } from "@effectionx/fs";
import { forEach } from "@effectionx/stream-helpers";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { compilePropsSchema } from "../src/validate.ts";

const ROOT = new URL("../../../", import.meta.url);
const COMPONENT_DIRS = [
  "packages/core/components",
  "smoke-test",
  ".reviews/components",
  ".reviews/policies",
];

describe("component schema conformance", () => {
  it("every markdown component's props schema parses and compiles", function* () {
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
          if (Object.keys(parsed.data).length === 0) {
            return;
          }
          checked++;
          try {
            const { props } = parseFrontmatter(parsed.data);
            yield* compilePropsSchema(props);
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
