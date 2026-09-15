/**
 * Tier PM — what a `--plugin` specifier names.
 *
 * Classification is decided before anything is resolved, loaded or refused, and
 * it is the half of module loading that has one answer everywhere. Resolution
 * is the host's and depends on the filesystem it is standing on; *what a
 * specifier is* does not.
 *
 * That separation is why these rows exist. `C:\plugins\review.mjs` is a
 * filesystem path and also matches the grammar of a URI scheme, and a
 * classifier that asked about schemes first refused an operator's own disk as a
 * remote URL. The defect only ever bites a Windows caller, and these rows see
 * it from any host — which is the whole point, because no shard runs the CLI on
 * Windows.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { classifyPluginSpecifier, resolvePluginSpecifier } from "../src/host-plugin-modules.ts";

describe("PM1 — a Windows path is a path, on every host", () => {
  // deno-lint-ignore require-yield
  it("reads a drive prefix as a filesystem path rather than a scheme", function* () {
    for (const specifier of [
      "C:\\plugins\\review.mjs",
      "c:\\plugins\\review.mjs",
      "D:/plugins/review.mjs",
      "Z:\\a\\b\\c.mjs",
    ]) {
      expect(`${specifier}: ${classifyPluginSpecifier(specifier)}`).toBe(`${specifier}: path`);
    }
  });

  // deno-lint-ignore require-yield
  it("does not refuse one as remote", function* () {
    // The defect, stated as the thing that must not happen: a classifier that
    // read `C:` as a scheme answered `remote`, and the loader then refused a
    // path the operator had typed.
    expect(classifyPluginSpecifier("C:\\plugins\\review.mjs")).not.toBe("remote");
  });

  // deno-lint-ignore require-yield
  it("still reads a bare drive letter with no separator as a scheme", function* () {
    // `C:review.mjs` is a drive-relative path on Windows and a scheme-shaped
    // token everywhere else. The prefix rule requires the separator, so this is
    // left to the scheme reading rather than quietly widened.
    expect(classifyPluginSpecifier("C:review.mjs")).toBe("remote");
  });
});

describe("PM2 — every other specifier keeps the answer it had", () => {
  // deno-lint-ignore require-yield
  it("classifies relative paths", function* () {
    for (const specifier of ["./review.mjs", "../plugins/review.mjs", ".\\review.mjs"]) {
      expect(`${specifier}: ${classifyPluginSpecifier(specifier)}`).toBe(`${specifier}: path`);
    }
  });

  // deno-lint-ignore require-yield
  it("classifies POSIX absolute paths and UNC shares", function* () {
    expect(classifyPluginSpecifier("/opt/plugins/review.mjs")).toBe("path");
    expect(classifyPluginSpecifier("\\\\share\\plugins\\review.mjs")).toBe("path");
  });

  // deno-lint-ignore require-yield
  it("classifies file URLs apart from paths, because they resolve differently", function* () {
    expect(classifyPluginSpecifier("file:///opt/plugins/review.mjs")).toBe("file-url");
  });

  // deno-lint-ignore require-yield
  it("classifies bare package specifiers", function* () {
    for (const specifier of ["@acme/reviews", "reviews", "@acme/reviews/plugin"]) {
      expect(`${specifier}: ${classifyPluginSpecifier(specifier)}`).toBe(`${specifier}: package`);
    }
  });

  // deno-lint-ignore require-yield
  it("classifies real remote schemes as remote", function* () {
    for (const specifier of [
      "https://example.invalid/plugin.mjs",
      "http://example.invalid/plugin.mjs",
      "npm:@acme/reviews",
      "jsr:@acme/reviews",
      "data:text/javascript,export default {}",
    ]) {
      expect(`${specifier}: ${classifyPluginSpecifier(specifier)}`).toBe(`${specifier}: remote`);
    }
  });
});

describe("PM3 — resolution follows the classification", () => {
  // deno-lint-ignore require-yield
  it("resolves a relative path from the invocation directory", function* () {
    const resolved = resolvePluginSpecifier("./review.mjs", "/opt/work");
    expect(resolved.protocol).toBe("file:");
    expect(decodeURIComponent(resolved.pathname).endsWith("/opt/work/review.mjs")).toBe(true);
  });

  // deno-lint-ignore require-yield
  it("keeps a file URL as it was written", function* () {
    expect(resolvePluginSpecifier("file:///opt/plugins/review.mjs", "/elsewhere").href).toBe(
      "file:///opt/plugins/review.mjs",
    );
  });

  // deno-lint-ignore require-yield
  it("refuses a remote specifier, naming the remedy", function* () {
    let refused = "";
    try {
      resolvePluginSpecifier("https://example.invalid/plugin.mjs", "/opt/work");
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain("xmd loads no code over the network");
    expect(refused).toContain("a path to a module on this filesystem");
  });

  // deno-lint-ignore require-yield
  it("refuses nothing that classified as a path", function* () {
    // Resolution of a Windows path on a POSIX host produces a POSIX-rooted URL,
    // which is meaningless there and is not what this asserts. What it asserts
    // is that the specifier reached path resolution at all rather than the
    // remote refusal — the defect was a refusal, not a wrong directory.
    expect(resolvePluginSpecifier("C:\\plugins\\review.mjs", "/opt/work").protocol).toBe("file:");
  });
});
