import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { readTextFile } from "@effectionx/fs";
import { collect, execute, registerComponents, useTempFileCompiler } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTesting } from "@executablemd/testing";
import { fileURLToPath } from "node:url";

import { FormAssets } from "../src/assets.ts";
import { FormOpener } from "../src/opener.ts";
import { FormResponder, submitForm } from "../src/responder.ts";
import { WEB_FORM_PROPS, WEB_FORM_RETURNS, WebForm } from "../src/WebForm.ts";
import { useStubFs } from "@executablemd/runtime/test";

const DOCUMENT = fileURLToPath(new URL("../src/WebForm.test.md", import.meta.url));

/**
 * `WebForm.test.md` runs here rather than through `xmd test`.
 *
 * The document needs a responder to answer it, and a responder is installed by a
 * host — never by the document, which is the whole point of the seam. Discovered
 * by `xmd test` with no responder installed, the form would wait for a person who
 * is not coming.
 */
describe("WebForm.test.md", () => {
  it("passes with an installed responder answering its forms", function* () {
    const source = yield* readTextFile(DOCUMENT);

    const outcome = yield* scoped(function* () {
      yield* useTempFileCompiler();
      yield* useStubFs({ "WebForm.test.md": source });

      yield* FormAssets.around({
        // deno-lint-ignore require-yield
        *assets() {
          return { clientJs: "/* fixture */", themeCss: "/* fixture */" };
        },
      });
      yield* FormOpener.around({
        // deno-lint-ignore require-yield
        *open() {},
      });
      yield* FormResponder.around({
        *respond([url]) {
          yield* submitForm(url, { decision: "approve", note: "looks right" });
        },
      });

      yield* useTesting();
      yield* registerComponents([
        {
          name: "WebForm",
          origin: "@executablemd/web",
          fn: WebForm,
          props: WEB_FORM_PROPS,
          returns: WEB_FORM_RETURNS,
        },
      ]);

      const execution = yield* execute({
        path: "WebForm.test.md",
        stream: new InMemoryStream(),
      });

      try {
        yield* collect(execution);
        return { ok: true, message: "" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    });

    expect(outcome).toEqual({ ok: true, message: "" });
  });
});
