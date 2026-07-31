/**
 * Driving `<WebForm>` the way a document does, and counting what it caused.
 *
 * The claims this package makes hardest are negative — a failing body prints no
 * URL, opens no browser, binds no port, journals nothing; a replay does none of
 * it either. A test can only make those claims if something observes each effect,
 * so every seam is instrumented and the counters are read after the run.
 */

import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { collect, execute, registerComponents, useTempFileCompiler } from "@executablemd/core";
import { Err, Ok } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableStream, Json as DurableJson } from "@executablemd/durable-streams";
import type { Result } from "effection";
import { useStubFs } from "@executablemd/runtime/test";
import { mkdtemp, realpath } from "node:fs/promises";
import process from "node:process";
import { basename, join } from "node:path";
import { rm, writeTextFile } from "@effectionx/fs";

import { FormAssets } from "../src/assets.ts";
import type { Json } from "../src/json.ts";
import { FormOpener } from "../src/opener.ts";
import { FormResponder, submitForm } from "../src/responder.ts";
import { WEB_FORM_PROPS, WEB_FORM_RETURNS, WebForm } from "../src/WebForm.ts";

export const CLIENT_JS = "/* fixture client */\n";
export const THEME_CSS = "/* fixture theme */\n";

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};

/** Every observable thing a live form does, counted. */
export interface Effects {
  /** Everything written for a person to read — where the URL appears. */
  printed: string[];
  /** URLs the opener was asked to launch. */
  opened: string[];
  /** URLs handed to the responder. */
  responded: string[];
  /** Servers whose assets were requested — one per listener that started. */
  served: number;
}

export interface RunOptions {
  /** Answer installed for the responder to submit; absent means answer nothing. */
  answer?: Json;
  /** Reuse a journal to drive replay. */
  stream?: DurableStream;
  /** Extra files beside the document. */
  files?: Record<string, string>;
  /** Component search directories, for repository-override cases. */
  componentDirs?: string[];
  /**
   * Read documents and components from the real filesystem instead of a stub.
   *
   * A `.ts` component is `import()`ed from a real path, so a stubbed filesystem
   * can resolve its name and then fail to load it. Those cases need real files.
   */
  realFiles?: boolean;
}

export interface DocRun {
  output: string;
  completion: Result<DurableJson>;
  effects: Effects;
  stream: DurableStream;
}

/**
 * Run one document with `<WebForm>` registered and every seam observed.
 *
 * The opener and responder are substituted, but the server is not: a submission
 * goes over real HTTP to the real listener, so the protocol still decides what a
 * valid answer is.
 */
export function* runWebFormDoc(source: string, options: RunOptions = {}): Operation<DocRun> {
  return yield* scoped(function* () {
    const effects: Effects = { printed: [], opened: [], responded: [], served: 0 };

    // The documents define their schema in an eval block, which needs a real
    // compiler: without one every expression prop resolves to a diagnostic and
    // the component under test is never reached.
    yield* useTempFileCompiler();
    if (!options.realFiles) {
      yield* useStubFs({ "README.md": source, ...options.files });
    }

    yield* FormAssets.around({
      // deno-lint-ignore require-yield
      *assets() {
        effects.served += 1;
        return { clientJs: CLIENT_JS, themeCss: THEME_CSS };
      },
    });

    yield* FormOpener.around({
      // deno-lint-ignore require-yield
      *open([url]) {
        effects.opened.push(url);
      },
    });

    // `announceForm` writes through the console, so that is what is observed:
    // a counter fed by anything else would stay empty however the code behaved.
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      effects.printed.push(args.map((arg) => String(arg)).join(" "));
    };
    yield* ensure(() => {
      console.error = consoleError;
    });

    yield* FormResponder.around({
      *respond([url]) {
        effects.responded.push(url);
        if (options.answer !== undefined) {
          yield* submitForm(url, options.answer);
        }
      },
    });

    yield* registerComponents([
      {
        name: "WebForm",
        origin: "@executablemd/web",
        fn: WebForm,
        props: WEB_FORM_PROPS,
        returns: WEB_FORM_RETURNS,
      },
    ]);

    const stream = options.stream ?? new InMemoryStream();
    const execution = yield* execute({
      path: options.realFiles ? source : "README.md",
      stream,
      componentDirs: options.componentDirs,
    });

    // Every test here is about what a failure did or did not cause, so the
    // failure has to survive to be inspected rather than end the run.
    let completion: Result<DurableJson>;
    try {
      completion = Ok(yield* collect(execution));
    } catch (error) {
      completion = Err(error instanceof Error ? error : new Error(String(error)));
    }

    return {
      output: completion.ok ? String(completion.value) : "",
      completion,
      effects,
      stream,
    };
  });
}

/** Printed URLs are captured by watching stderr, which is where they go. */
export function* recordingPrints<T>(body: () => Operation<T>): Operation<{
  value: T;
  printed: string[];
}> {
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    printed.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { value: yield* body(), printed };
  } finally {
    console.error = original;
  }
}

/**
 * Every durable yield of one type, whatever its result.
 *
 * Successes alone would not do: a durable operation that began and then failed
 * leaves an `err` event, and a "nothing was journaled" assertion reading only
 * successes would call that nothing. What these tests need to say is that the
 * operation was never entered at all.
 */
export function* journalEvents(
  stream: DurableStream,
  type: string,
): Operation<{ status: string; value?: DurableJson }[]> {
  const events = yield* stream.readAll();
  const found: { status: string; value?: DurableJson }[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === type) {
      found.push(
        event.result.status === "ok"
          ? { status: "ok", value: event.result.value }
          : { status: String(event.result.status) },
      );
    }
  }
  return found;
}

/** The successfully stored values of one type. */
export function* journaled(stream: DurableStream, type: string): Operation<DurableJson[]> {
  const values: DurableJson[] = [];
  for (const event of yield* journalEvents(stream, type)) {
    if (event.status === "ok" && event.value !== undefined) {
      values.push(event.value);
    }
  }
  return values;
}

/** Every journal entry, so a test can say what kinds exist at all. */
export function* journalKinds(stream: DurableStream): Operation<string[]> {
  const events = yield* stream.readAll();
  const kinds = new Set<string>();
  for (const event of events) {
    if (event.type === "yield") {
      kinds.add(String(event.description.type));
    }
  }
  return [...kinds].sort();
}

/**
 * A directory for one test's real files, beneath the process's own.
 *
 * Beneath the process directory rather than the system temp one, because a `.ts`
 * component is imported by a path resolved against the process's cwd.
 */
export function useLocalFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(process.cwd(), "webform-fixture-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(basename(dir));
  });
}

export function* writeFile(path: string, source: string): Operation<void> {
  yield* writeTextFile(path, source);
}
