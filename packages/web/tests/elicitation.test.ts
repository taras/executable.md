/**
 * The WebForm elicitation provider (specs/web-form-spec.md).
 *
 * The provider is exercised through the Elicitation Api, as a host reaches it,
 * with the browser and the person substituted at the same contextual seams
 * `liveForm`'s own tests use. What is asserted here is the mapping: what the
 * request becomes on the page, and what does not cross the boundary.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { Elicitation } from "@executablemd/core";

import { FormAssets } from "../src/assets.ts";
import { installWebElicitation } from "../src/elicitation.ts";
import type { Json, JsonObject } from "../src/json.ts";
import { parseJson } from "../src/json.ts";
import { FormOpener } from "../src/opener.ts";
import { FormResponder, submitForm } from "../src/responder.ts";
import { REVIEW_SCHEMA } from "./server-support.ts";

/**
 * What the form actually served.
 *
 * The page shell is static: the body arrives through `config.json` and the UI
 * schema, when there is one, through the precompiled `validator.js`. Reading
 * those is the only way to see either from outside the server.
 */
interface Served {
  config: string;
  validator: string;
}

function fixtureAssets(): Operation<void> {
  return FormAssets.around({
    // deno-lint-ignore require-yield
    *assets() {
      return { clientJs: "/* fixture */", themeCss: "/* fixture */" };
    },
  });
}

function silentOpener(): Operation<void> {
  return FormOpener.around({
    // deno-lint-ignore require-yield
    *open() {},
  });
}

/**
 * Ask through the installed provider, answering with `answer`.
 *
 * `served` collects what the page was actually built from, which is the only
 * way to see the sanitized message from outside the server.
 */
function* ask(
  request: { message: string; schema: JsonObject },
  answer: Json,
  served: Served,
): Operation<Json> {
  return yield* scoped(function* () {
    yield* fixtureAssets();
    yield* silentOpener();
    yield* FormResponder.around({
      *respond([url]) {
        served.config = yield* fetchText(`${url}config.json`);
        served.validator = yield* fetchText(`${url}validator.js`);
        yield* submitForm(url, answer);
      },
    });
    yield* installWebElicitation();
    // Parsed rather than asserted: the Api answers `unknown`, as it does for
    // any provider, and this is the boundary that reads it.
    return parseJson(yield* Elicitation.operations.elicit(request));
  });
}

function* fetchText(url: string): Operation<string> {
  const response = yield* until(fetch(url));
  return yield* until(response.text());
}

describe("the WebForm elicitation provider", () => {
  it("answers an elicitation with a real form", function* () {
    const served: Served = { config: "", validator: "" };

    const answer = yield* ask(
      { message: "Decide.", schema: REVIEW_SCHEMA },
      { decision: "approve" },
      served,
    );

    expect(answer).toEqual({ decision: "approve" });
  });

  /**
   * The message is a document's markdown, which a document may have generated.
   * It reaches the page through the same boundary `<WebForm>` uses, so what a
   * form serves does not depend on which component asked.
   */
  it("renders the message through the sanitizing pipeline", function* () {
    const served: Served = { config: "", validator: "" };

    yield* ask(
      { message: "# Decide\n\nRead <script>alert(1)</script> and choose.", schema: REVIEW_SCHEMA },
      { decision: "approve" },
      served,
    );

    expect(served.config).toContain("<h1>Decide</h1>");
    expect(served.config).not.toContain("<script>alert(1)</script>");
  });

  it("serves no UI schema", function* () {
    const served: Served = { config: "", validator: "" };

    yield* ask({ message: "Decide.", schema: REVIEW_SCHEMA }, { decision: "approve" }, served);

    // The precompiled validator registers the UI schema when there is one. An
    // elicitation has no way to express one and must not acquire a default.
    expect(served.validator).not.toContain("ui:");
    expect(served.validator).toContain("register(");
  });

  it("refuses a schema it cannot serve, before opening anything", function* () {
    let opened = 0;
    let failure: string | undefined;

    yield* scoped(function* () {
      yield* fixtureAssets();
      yield* FormOpener.around({
        // deno-lint-ignore require-yield
        *open() {
          opened++;
        },
      });
      yield* installWebElicitation();
      try {
        yield* Elicitation.operations.elicit({
          message: "Decide.",
          schema: { type: "object", properties: { decision: { $ref: "other.json#/x" } } },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    });

    // Named for the component the author wrote, not for <WebForm>.
    expect(failure).toContain("<Elicit>");
    expect(failure).toContain("other.json#/x");
    expect(opened).toBe(0);
  });
});
