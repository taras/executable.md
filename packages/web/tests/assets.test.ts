import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { until } from "effection";
import type { Operation } from "effection";

import { readAssets } from "../src/assets.ts";
import { generatedModule } from "../../../scripts/lib/web-client-module.ts";

/**
 * The two halves of the browser bundle agree on names.
 *
 * The generator writes the module and this package reads it, and nothing else
 * connects them: every other test substitutes `FormAssets`, so a disagreement
 * about what the exports are called is invisible until a real form tries to
 * serve a real page. It was — the reader looked for `CLIENT_JS`/`THEME_CSS`
 * while the generator emitted `clientJs`/`themeCss`, and `<WebForm>` could not
 * have served a page at all.
 *
 * Real generator output is evaluated rather than a fixture of what it is assumed
 * to look like, so renaming either side fails here.
 */
describe("browser assets: generator and reader agree", () => {
  it("reads what the generator writes", function* () {
    const source = generatedModule("/* client */", "/* theme */");
    const module = yield* evaluate(source);

    expect(readAssets(module)).toEqual({
      clientJs: "/* client */",
      themeCss: "/* theme */",
    });
  });

  it("names the build when the module has the wrong shape", function* () {
    for (const wrong of [{}, { clientJs: "x" }, { themeCss: "y" }, { clientJs: 1, themeCss: 2 }]) {
      let message = "";
      try {
        readAssets(wrong);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("deno task build:web");
    }
  });

  it("refuses something that is not a module at all", function* () {
    for (const wrong of [null, "text", 7]) {
      let failed = false;
      try {
        readAssets(wrong);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    }
  });
});

/** Evaluate generated module text, the way the runtime would load it. */
function* evaluate(source: string): Operation<unknown> {
  const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  return yield* until(import(url));
}
