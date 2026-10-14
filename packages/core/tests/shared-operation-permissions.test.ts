/**
 * Tier PRM — one read-only region, and everything inside it.
 *
 * `Permissions` is a runtime Api and its composition is proved beside it (Tier
 * PM). What these rows are about is the property that only a document can show:
 * an authored element, a generated fragment's element and a direct contextual
 * call are *the same operation*, so one restriction decides all three. Before
 * U2 that was not even expressible — a generated element reached a filesystem
 * the profile handed it, which no middleware and no policy in the document's
 * scope could see.
 *
 * Everything here drives the real host provider against a real directory, and
 * every claim is checked twice: once in what the document reported, and once in
 * what the filesystem actually holds afterwards. A refusal that printed the
 * right sentence and wrote the file anyway would pass the first and fail the
 * second.
 *
 * The region is a component rather than a wrapper the harness installs,
 * because the thing under test is *scoped* permission: a region has an inside
 * and an outside, and the sibling written after it is what makes the outside
 * observable.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, Permissions, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { withResolvers } from "effection";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import type { ExecutionInstallation } from "../host.ts";
import {
  directoryEntry,
  fetchEntry,
  fileDeleteEntry,
  fileReadEntry,
  fileWriteEntry,
  globReadEntry,
  syntaxReadEntry,
} from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { content } from "../src/component-api.ts";
import { readFileText, writeFileText } from "../src/files.ts";
import { cwd } from "@executablemd/runtime";

const ROOT_PATH = "document.md";
const SOURCE = "the source note\n";

interface Fixture {
  readonly workspace: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "prm-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    yield* until(mkdir(workspace));
    yield* writeTextFile(join(workspace, "source.txt"), SOURCE);
    yield* provide({ workspace });
  });
}

/**
 * The host this document runs under: a working directory, a real provider, and
 * no restriction at all.
 *
 * Installed outside the execution, where an entrypoint installs it, so every
 * restriction below is something a *region inside the document* established.
 */
function* useHost(fixture: Fixture): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.workspace;
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
}

/**
 * The ordinary ceiling, with the write table admitted.
 *
 * The write form is admitted deliberately: a generated write that preflight
 * refused would prove nothing about live permission, because the fragment
 * would never reach an operation. These rows are about the refusal that
 * happens at the provider, so the fragment has to be allowed to try.
 */
function ceiling(): ExecutionInstallation {
  return {
    evaluation: {
      read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()],
      write: [
        fileWriteEntry(),
        directoryEntry({ origin: "test://host", key: "Dir", revision: "1" }, "Dir"),
        fileDeleteEntry(),
      ],
    },
  };
}

/** The components these documents are written with. */
function* useRegions(): Operation<void> {
  yield* registerComponents([
    {
      name: "ReadOnly",
      origin: "test://regions",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        // The ordinary restriction, exactly as the contract documents it:
        // refuse the class, delegate everything else unchanged.
        yield* Permissions.around({
          files: ([operation], next) => (operation === "write" ? false : next(operation)),
        });
        return yield* content();
      },
    },
    {
      name: "Permitting",
      origin: "test://regions",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        // What a scope that wants more than it was given would write. It
        // installs at the default order, inside the region above.
        yield* Permissions.around({ files: () => true });
        return yield* content();
      },
    },
    {
      name: "Editing",
      origin: "test://regions",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        // Changes the outgoing headers *in place* rather than building a new
        // object, which is the shape a comparison against the request's own
        // objects would be defeated by.
        yield* API.Fetch.around({
          *fetch([input, init], next) {
            if (init?.headers !== undefined) {
              init.headers["x-bound"] = "changed";
            }
            return yield* next(input, init);
          },
        });
        return yield* content();
      },
    },
    {
      name: "DirectRead",
      origin: "test://regions",
      props: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      *fn(props): Operation<string> {
        const read = yield* readFileText({ cwd: yield* cwd(), path: String(props.path) });
        return read.ok ? read.value : "direct read refused\n";
      },
    },
    {
      name: "DirectWrite",
      origin: "test://regions",
      props: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
      *fn(props): Operation<string> {
        const failure = yield* writeFileText({
          cwd: yield* cwd(),
          path: String(props.path),
          content: String(props.text),
        });
        return failure === undefined ? "direct write committed\n" : "direct write refused\n";
      },
    },
  ]);
}

function run(fixture: Fixture, source: string): Operation<Json> {
  return scoped(function* () {
    yield* useHost(fixture);
    yield* useRegions();
    return yield* collect(
      yield* executeInstalled(
        { ...retainedSource(ROOT_PATH, source), stream: new InMemoryStream() },
        [ceiling()],
      ),
    );
  });
}

/**
 * What one run refused with.
 *
 * Public `<Evaluate>` fails on every refusal — which is its contract, and the
 * reason a generated refusal is a separate row from an authored one: an
 * authored `<File>` prints its own failure and the document carries on, while a
 * fragment's failure ends the element that admitted it.
 */
function* refusal(fixture: Fixture, source: string): Operation<string> {
  try {
    yield* run(fixture, source);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One request the transport actually accepted. */
interface Accepted {
  readonly method: string;
  readonly path: string;
  /** The one bounded header these rows are about, as it arrived. */
  readonly bound?: string;
}

interface Loopback {
  readonly origin: string;
  readonly accepted: Accepted[];
}

/**
 * A real server on a port the host chose.
 *
 * A stub `API.Fetch` would prove nothing here: the terminal is what asks
 * `Permissions`, so a test that replaced it would be asserting about a
 * transport that never reaches the question. What a refusal has to show is that
 * no request was *sent*, and only something listening can say that.
 */
function useLoopback(): Operation<Loopback> {
  return resource(function* (provide) {
    const accepted: Accepted[] = [];
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const bound = request.headers["x-bound"];
      accepted.push({
        method: request.method ?? "",
        path: request.url ?? "",
        ...(typeof bound === "string" ? { bound } : {}),
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("from the network");
    });
    const listening = withResolvers<void>();
    let onError: ((error: Error) => void) | undefined;
    yield* ensure(() => {
      if (onError) {
        server.off("error", onError);
      }
    });
    onError = (error: Error) => listening.reject(error);
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;
    yield* ensure(function* () {
      const closed = withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      yield* closed.operation;
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the loopback server reported no TCP address");
    }
    yield* provide({ origin: `http://127.0.0.1:${address.port}`, accepted });
  });
}

describe("Tier PRM — authored, generated and direct operations under one restriction", () => {
  it("PRM1: every class of read is answered inside the region", function* () {
    const fixture = yield* useFixture();
    const output = String(
      yield* run(
        fixture,
        [
          "<ReadOnly>",
          "",
          // Authored, rendering what it read rather than binding it, so the
          // answer is visible in the document.
          '<File path="source.txt" />',
          // Generated, through public `<Evaluate>` under the admitted tables.
          `<Evaluate text={'<File path="source.txt" />\\n'} />`,
          // Direct, from a component that reaches no component at all.
          '<DirectRead path="source.txt" />',
          "",
          "</ReadOnly>",
          "",
        ].join("\n"),
      ),
    );

    // Three callers, three answers, one provider and one permitted class.
    expect(output.split("the source note").length - 1).toBe(3);
    expect(output).not.toContain("direct read refused");
    expect(output).not.toContain("ERROR");
  });

  it("PRM1b: an authored write is refused, and the sibling outside the region is not", function* () {
    const fixture = yield* useFixture();
    const output = String(
      yield* run(
        fixture,
        [
          "<ReadOnly>",
          "",
          '<File path="authored.txt">written by the document</File>',
          "",
          "</ReadOnly>",
          "",
          '<File path="after.txt">written outside the region</File>',
          "",
        ].join("\n"),
      ),
    );

    expect(output).toContain("permission denied");
    expect(yield* exists(join(fixture.workspace, "authored.txt"))).toBe(false);
    // The restriction belonged to the region rather than to the run, and
    // leaving it restored the host's own allowance.
    expect(yield* readTextFile(join(fixture.workspace, "after.txt"))).toBe(
      "written outside the region",
    );
  });

  it("PRM1c: a direct contextual write is refused on the same terms", function* () {
    const fixture = yield* useFixture();
    const output = String(
      yield* run(
        fixture,
        [
          "<ReadOnly>",
          "",
          '<DirectWrite path="direct.txt" text="written directly" />',
          "",
          "</ReadOnly>",
          "",
          '<DirectWrite path="direct-after.txt" text="written outside" />',
          "",
        ].join("\n"),
      ),
    );

    // A component calling the contextual operation itself names no component
    // and gets no different answer: the restriction is the provider's to obey,
    // not a component's to apply.
    expect(output).toContain("direct write refused");
    expect(output).toContain("direct write committed");
    expect(yield* exists(join(fixture.workspace, "direct.txt"))).toBe(false);
    expect(yield* readTextFile(join(fixture.workspace, "direct-after.txt"))).toBe(
      "written outside",
    );
  });

  it("PRM1d: a generated write is refused by the same restriction, and fails its element", function* () {
    const fixture = yield* useFixture();
    const failed = yield* refusal(
      fixture,
      [
        "<ReadOnly>",
        "",
        `<Evaluate allow={["write"]} text={'<File path="generated.txt">written by a fragment</File>\\n'} />`,
        "",
        "</ReadOnly>",
        "",
      ].join("\n"),
    );

    // The write table was admitted, so preflight let the fragment try: what
    // refused it is the live restriction at the provider, which is the whole
    // reason the form is admitted here.
    expect(failed).toContain("permission denied");
    expect(yield* exists(join(fixture.workspace, "generated.txt"))).toBe(false);
  });

  it("PRM2: a descendant answering true cannot defeat the enclosing refusal", function* () {
    const fixture = yield* useFixture();
    const output = String(
      yield* run(
        fixture,
        [
          "<ReadOnly>",
          "",
          "<Permitting>",
          "",
          '<DirectWrite path="widened.txt" text="written by a widened scope" />',
          "",
          "</Permitting>",
          "",
          "</ReadOnly>",
          "",
        ].join("\n"),
      ),
    );

    // The descendant installed at the default order and answered `true`. The
    // enclosing refusal is never asked to delegate, so the answer the provider
    // reads is still no.
    expect(output).toContain("direct write refused");
    expect(yield* exists(join(fixture.workspace, "widened.txt"))).toBe(false);
  });

  it("PRM3: a paired write reads its children before the write is refused", function* () {
    const fixture = yield* useFixture();
    const crossed: string[] = [];

    const output = String(
      yield* scoped(function* () {
        yield* useHost(fixture);
        yield* useRegions();
        yield* API.Files.around({
          *readTextFile([input], next) {
            crossed.push(`read ${input.path}`);
            return yield* next(input);
          },
          *writeTextFile([input], next) {
            crossed.push(`write ${input.path}`);
            return yield* next(input);
          },
        });
        return yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                ROOT_PATH,
                [
                  "<ReadOnly>",
                  "",
                  '<File path="copy.txt"><File path="source.txt" /></File>',
                  "",
                  "</ReadOnly>",
                  "",
                ].join("\n"),
              ),
              stream: new InMemoryStream(),
            },
            [ceiling()],
          ),
        );
      }),
    );

    // The authored order is the contract, and permission did not move it: the
    // pure path check runs before the children, the children expand — so the
    // read inside really happened — and authorization stands at the write the
    // provider is eventually asked to perform. The read is not in the output
    // because the write consumed it, which is why this row observes the
    // operations rather than reading the rendering.
    expect(crossed).toEqual(["read source.txt", "write copy.txt"]);
    expect(output).toContain("permission denied");
    expect(yield* exists(join(fixture.workspace, "copy.txt"))).toBe(false);
  });

  it("PRM4: a generated fragment's operations cross the document's own middleware", function* () {
    const fixture = yield* useFixture();
    const crossed: string[] = [];

    const output = String(
      yield* scoped(function* () {
        yield* useHost(fixture);
        yield* useRegions();
        // Installed where a document's own middleware is, and both observing
        // and transforming: what the fragment asked for is not what the
        // provider performs.
        yield* API.Files.around({
          *readTextFile([input], next) {
            crossed.push(`read ${input.path}`);
            return yield* next(input);
          },
          *writeTextFile([input], next) {
            crossed.push(`write ${input.path}`);
            return yield* next({ ...input, content: `transformed: ${input.content}` });
          },
        });
        return yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                ROOT_PATH,
                `<Evaluate allow={["read","write"]} text={'<File path="source.txt" as="note" />\\n` +
                  `<File path="made.txt">from the fragment</File>\\n'} />\n`,
              ),
              stream: new InMemoryStream(),
            },
            [ceiling()],
          ),
        );
      }),
    );

    expect(output).not.toContain("could not");
    // One middleware, both payloads, in the fragment's own order.
    expect(crossed).toEqual(["read source.txt", "write made.txt"]);
    // And the transformation is what landed, which is the half an
    // observing-only assertion would miss.
    expect(yield* readTextFile(join(fixture.workspace, "made.txt"))).toBe(
      "transformed: from the fragment",
    );
  });

  it("PRM6: a generated request performs its entry's admitted request, and the transport sees it", function* () {
    const fixture = yield* useFixture();
    const output = String(
      yield* scoped(function* () {
        const server = yield* useLoopback();
        yield* useHost(fixture);
        yield* useRegions();
        const admitted = { url: `${server.origin}/admitted`, method: "GET", headers: {} };
        const rendered = yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                ROOT_PATH,
                `<Evaluate text={'<Fetch url="${admitted.url}" as="answer" />\\n` +
                  `<Json value={answer} />\\n'} />\n`,
              ),
              stream: new InMemoryStream(),
            },
            [
              {
                evaluation: {
                  read: [
                    fileReadEntry(),
                    globReadEntry(),
                    syntaxReadEntry(),
                    fetchEntry([admitted]),
                  ],
                },
              },
            ],
          ),
        );
        // Read inside the scope, before the server is torn down.
        expect(server.accepted).toEqual([{ method: "GET", path: "/admitted" }]);
        return rendered;
      }),
    );

    expect(output).toContain("from the network");
  });

  it("PRM7: a transformation off the entry's ceiling is refused at the transport", function* () {
    const fixture = yield* useFixture();
    let accepted: readonly Accepted[] = [];

    const failed = yield* scoped(function* () {
      const server = yield* useLoopback();
      yield* useHost(fixture);
      yield* useRegions();
      const admitted = { url: `${server.origin}/admitted`, method: "GET", headers: {} };
      // A handler composed around the contextual chain while the document runs,
      // rewriting the destination to somewhere the entry never admitted.
      yield* API.Fetch.around({
        *fetch([input, init], next) {
          return yield* next(input.replace("/admitted", "/elsewhere"), init);
        },
      });
      let message = "";
      try {
        yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                ROOT_PATH,
                `<Evaluate text={'<Fetch url="${admitted.url}" as="answer" />\\n` +
                  `<Json value={answer} />\\n'} />\n`,
              ),
              stream: new InMemoryStream(),
            },
            [
              {
                evaluation: {
                  read: [
                    fileReadEntry(),
                    globReadEntry(),
                    syntaxReadEntry(),
                    fetchEntry([admitted]),
                  ],
                },
              },
            ],
          ),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      accepted = [...server.accepted];
      return message;
    });

    // The ceiling is in force where the request is actually sent, not only
    // where the component read its props — and a refused request is not a
    // request: the transport accepted nothing at all.
    expect(failed).toContain("not permitted in this scope");
    expect(accepted).toEqual([]);
  });

  /**
   * The ceiling is the whole request, and headers are part of it.
   *
   * PRM7 rewrites the destination, which any comparison catches. This is the
   * case a URL-and-method comparison lets through: the element asks for exactly
   * the admitted request, and contextual middleware changes one admitted header
   * on the way out. The host that stated the ceiling stated that header, so a
   * transformation that sends a different one is sending a request this entry
   * never admitted — and middleware being available in the consuming scope is
   * not evidence the host approved it.
   */
  it("PRM7b: a changed admitted header is refused at the transport", function* () {
    const fixture = yield* useFixture();
    let control: readonly Accepted[] = [];
    let afterChange: readonly Accepted[] = [];
    let failed = "";

    yield* scoped(function* () {
      const server = yield* useLoopback();
      yield* useHost(fixture);
      yield* useRegions();
      const admitted = {
        url: `${server.origin}/admitted`,
        method: "GET",
        headers: { "x-bound": "admitted" },
      };
      const source =
        `<Evaluate text={'<Fetch url="${admitted.url}" headers={{"x-bound":"admitted"}} ` +
        `as="answer" />\\n<Json value={answer} />\\n'} />\n`;
      const admitting: ExecutionInstallation = {
        evaluation: {
          read: [fileReadEntry(), globReadEntry(), syntaxReadEntry(), fetchEntry([admitted])],
        },
      };

      // The positive control first, in the same scope and against the same
      // server: the element, the ceiling and the header all agree, and the
      // request goes out.
      yield* collect(
        yield* executeInstalled(
          { ...retainedSource(ROOT_PATH, source), stream: new InMemoryStream() },
          [admitting],
        ),
      );
      control = [...server.accepted];

      yield* scoped(function* () {
        // Ordinary `API.Fetch` middleware, changing one admitted header and
        // delegating everything else unchanged.
        yield* API.Fetch.around({
          *fetch([input, init], next) {
            return yield* next(input, {
              ...init,
              headers: { ...init?.headers, "x-bound": "changed" },
            });
          },
        });
        try {
          yield* collect(
            yield* executeInstalled(
              { ...retainedSource(ROOT_PATH, source), stream: new InMemoryStream() },
              [admitting],
            ),
          );
        } catch (error) {
          failed = error instanceof Error ? error.message : String(error);
        }
      });
      afterChange = [...server.accepted];
    });

    expect(control).toEqual([{ method: "GET", path: "/admitted", bound: "admitted" }]);
    expect(failed).toContain("not permitted in this scope");
    // Nothing further reached the transport: the refusal is a request that was
    // never sent rather than one the server answered.
    expect(afterChange).toEqual(control);
  });

  /**
   * And the baseline is not the object the chain was handed.
   *
   * The request travels through middleware by reference, so a handler can edit
   * the outgoing headers *in place* rather than building a new object. Against
   * a comparison that read those same objects both sides would move together,
   * the edited request would still "match", and it would be sent — so the
   * refusal below is exactly the assertion that the ceiling is held by value
   * taken at capture and the transport is handed a copy.
   *
   * The permitted element ahead of it shares one capture with it, which is what
   * makes it evidence rather than decoration: the entry is demonstrably working
   * for the request the host admitted, in this very run, and the edit is what
   * the terminal refuses.
   */
  it("PRM7c: an in-place edit is refused, and the admitted request in the same capture is not", function* () {
    const fixture = yield* useFixture();
    let accepted: readonly Accepted[] = [];
    let failed = "";

    yield* scoped(function* () {
      const server = yield* useLoopback();
      yield* useHost(fixture);
      yield* useRegions();
      const admitted = {
        url: `${server.origin}/admitted`,
        method: "GET",
        headers: { "x-bound": "admitted" },
      };
      const element =
        `<Evaluate text={'<Fetch url="${admitted.url}" headers={{"x-bound":"admitted"}} ` +
        `as="answer" />\\n<Json value={answer} />\\n'} />`;

      try {
        yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                ROOT_PATH,
                // Permitted first — a generated refusal ends the run, so the
                // element that proves the entry works has to be the one ahead
                // of it.
                [element, "", "<Editing>", "", element, "", "</Editing>", ""].join("\n"),
              ),
              stream: new InMemoryStream(),
            },
            [
              {
                evaluation: {
                  read: [
                    fileReadEntry(),
                    globReadEntry(),
                    syntaxReadEntry(),
                    fetchEntry([admitted]),
                  ],
                },
              },
            ],
          ),
        );
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
      }
      accepted = [...server.accepted];
    });

    expect(failed).toContain("not permitted in this scope");
    // One request: the admitted one. The edited element sent nothing, so the
    // edit neither reached the network nor became something this entry admits.
    expect(accepted).toEqual([{ method: "GET", path: "/admitted", bound: "admitted" }]);
  });

  /**
   * The half a refusal cannot show: what the *next* invocation sends.
   *
   * An in-place edit that happens to stay inside the ceiling is permitted, and
   * that is the case which reveals whether the edit reached the entry's own
   * copy of the admitted request. Both headers are admitted here, so the edited
   * element goes out as `changed`; the element after it, outside the editing
   * region, asks for the same entry again. It sends `admitted` — so the edit
   * changed the request on its way out and nothing else.
   *
   * Against an entry that handed the transport its own ceiling object, the edit
   * would have landed in that object and this second element would send
   * `changed` too.
   */
  it("PRM7d: an in-place edit does not change what the next invocation sends", function* () {
    const fixture = yield* useFixture();
    let accepted: readonly Accepted[] = [];

    yield* scoped(function* () {
      const server = yield* useLoopback();
      yield* useHost(fixture);
      yield* useRegions();
      const url = `${server.origin}/admitted`;
      const element =
        `<Evaluate text={'<Fetch url="${url}" headers={{"x-bound":"admitted"}} ` +
        `as="answer" />\\n<Json value={answer} />\\n'} />`;

      yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(
              ROOT_PATH,
              ["<Editing>", "", element, "", "</Editing>", "", element, ""].join("\n"),
            ),
            stream: new InMemoryStream(),
          },
          [
            {
              evaluation: {
                read: [
                  fileReadEntry(),
                  globReadEntry(),
                  syntaxReadEntry(),
                  // Both spellings admitted, so the edit below is inside the
                  // ceiling and the row is about the copy rather than about the
                  // refusal.
                  fetchEntry([
                    { url, method: "GET", headers: { "x-bound": "admitted" } },
                    { url, method: "GET", headers: { "x-bound": "changed" } },
                  ]),
                ],
              },
            },
          ],
        ),
      );
      accepted = [...server.accepted];
    });

    expect(accepted).toEqual([
      { method: "GET", path: "/admitted", bound: "changed" },
      { method: "GET", path: "/admitted", bound: "admitted" },
    ]);
  });

  it("PRM5: a generated Dir scopes what follows it and restores the directory", function* () {
    const fixture = yield* useFixture();

    yield* run(
      fixture,
      `<Evaluate allow={["write"]} text={'<Dir path="nested">\\n` +
        `<File path="inside.txt">in the nested directory</File>\\n</Dir>\\n` +
        `<File path="beside.txt">beside it</File>\\n'} />\n`,
    );

    // The directory the fragment made, the file it wrote inside it, and — the
    // discriminating half — the file written after the directory closed, which
    // is in the workspace rather than in the nested directory. The working
    // directory a generated `<Dir>` installs is the ordinary invocation-owned
    // one, so leaving the element takes it away again.
    expect(yield* readTextFile(join(fixture.workspace, "nested", "inside.txt"))).toBe(
      "in the nested directory",
    );
    expect(yield* readTextFile(join(fixture.workspace, "beside.txt"))).toBe("beside it");
    expect(yield* exists(join(fixture.workspace, "nested", "beside.txt"))).toBe(false);
  });
});
