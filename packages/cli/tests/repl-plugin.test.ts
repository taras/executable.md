import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { Plugin } from "@executablemd/core/api";
import { contributeDocumentation } from "@executablemd/core";
import { Repl } from "../api.ts";
import type { ReplPluginInstallation } from "../api.ts";
import { installPlugins } from "../src/plugin-host.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { HeadlessReplRoot } from "../src/repl/program.ts";
import { useReplLiveScreen } from "../src/repl/live-screen.ts";
import { usePluginProgram } from "./support/plugin-program.ts";
import { useMountedHost } from "./support/mounted-repl.ts";

const Session = createContext<{ workspace: string; calls: number }>("test.repl-plugin.session");
const props = { type: "object", properties: {}, additionalProperties: false };
function fixture(name: string, events: string[], counts: { factories: number }) {
  const Own = createContext<{ calls: number }>(`test.repl-plugin.${name}`);
  return Plugin({
    name,
    *install(): Operation<ReplPluginInstallation> {
      yield* contributeDocumentation(function* () {
        yield* sleep(0);
        return {
          source: {
            owner: `test://${name}`,
            asset: `${name}.md`,
            text: `## ${name}\nRead ${name}'s session state.\n`,
          },
          supplies: new Set([name]),
        };
      });
      return {
        repl: {
          *initialize({ workspace }) {
            events.push(`start:${name}`);
            yield* ensure(() => {
              events.push(`stop:${name}`);
            });
            if ((yield* Session.get()) === undefined) {
              yield* Session.set({ workspace, calls: 0 });
            }
            yield* Own.set({ calls: 0 });
            yield* Repl.around({
              *initialize([session], next) {
                events.push(`cooperate:${name}`);
                yield* next(session);
              },
            });
          },
          components: [
            {
              name,
              origin: `test://${name}`,
              props,
              returns: { type: "integer" },
              factory() {
                counts.factories++;
                return function* () {
                  const state = yield* Session.expect();
                  state.calls++;
                  const own = yield* Own.expect();
                  own.calls++;
                  events.push(`body:${name}:${own.calls}`);
                  return state.calls;
                };
              },
            },
          ],
        },
      };
    },
  });
}

describe("Selected REPL Plugin contributions", () => {
  it("R1/R5: collection and descriptions start no service; ordered setup shares session state", function* () {
    const events: string[] = [];
    const counts = { factories: 0 };
    yield* scoped(function* () {
      const host = yield* useMountedHost({
        plugins: [fixture("First", events, counts), fixture("Second", events, counts)],
      });
      const profile = yield* host.profile.finalize();
      expect(yield* profile.vocabulary.symbols()).toContain("First");
      expect(yield* profile.vocabulary.documentation(["First", "Second"])).toContain(
        "session state",
      );
      expect(events).toEqual([]);
      expect(counts.factories).toBe(0);
      const view = yield* useReplLiveScreen();
      const ready = withResolvers<Parameters<HeadlessReplRoot["ready"]>[0]>();
      const running = yield* spawn(() =>
        runReplProgram({
          profile,
          root: host.root,
          headless: {
            view,
            *ready(root) {
              ready.resolve(root);
              yield* sleep(0);
            },
          },
        }),
      );
      const root = yield* ready.operation;
      expect(events.slice(0, 2)).toEqual(["start:First", "start:Second"]);
      const submission = yield* root.session.submit('<First as="one" /><Second as="two" />');
      if (!submission.ok) {
        throw submission.error;
      }
      expect((yield* submission.value.join()).ok).toBe(true);
      const bindings = yield* root.session.bindings();
      expect(bindings.ok && bindings.value.one).toBe(1);
      expect(bindings.ok && bindings.value.two).toBe(2);
      expect(events.filter((one) => one.startsWith("body:"))).toEqual([
        "body:First:1",
        "body:Second:1",
      ]);
      yield* profile.vocabulary.symbols();
      expect(events.filter((one) => one.startsWith("start:"))).toHaveLength(2);
      yield* running.halt();
    });
    expect(events.slice(-2)).toEqual(["stop:Second", "stop:First"]);
  });

  it("R1/R5: deselection removes only that Plugin's setup, syntax and documentation", function* () {
    for (const selected of ["First", "Second"]) {
      yield* scoped(function* () {
        const events: string[] = [];
        const counts = { factories: 0 };
        const held = yield* usePluginProgram({ plugins: [fixture(selected, events, counts)] });
        const omitted = selected === "First" ? "Second" : "First";
        const vocabulary = (yield* held.host.profile.finalize()).vocabulary;
        expect(yield* vocabulary.symbols()).toContain(selected);
        expect(yield* vocabulary.symbols()).not.toContain(`## ${omitted}`);
        expect(yield* vocabulary.documentation([selected])).toContain(
          `${selected}'s session state`,
        );
        const submitted = yield* held.root.session.submit(`<${selected} as="value" />`);
        if (!submitted.ok) {
          throw submitted.error;
        }
        expect((yield* submitted.value.join()).ok).toBe(true);
        expect(events.filter((one) => one.startsWith("start:"))).toEqual([`start:${selected}`]);
      });
    }
  });

  it("R1/R3: extension-only collection survives and malformed callbacks refuse before setup", function* () {
    let started = 0;
    const only = Plugin({
      name: "extension-only",
      *install(): Operation<ReplPluginInstallation> {
        yield* sleep(0);
        return {
          repl: {
            *initialize() {
              started++;
              yield* sleep(0);
            },
          },
        };
      },
    });
    const installed = yield* installPlugins([only], { command: "repl", args: [] });
    expect(installed.repl).toHaveLength(1);
    expect(started).toBe(0);
    let rejected = false;
    try {
      yield* installPlugins(
        [
          Plugin({
            name: "invalid",
            *install() {
              yield* sleep(0);
              return { components: [], repl: { initialize: 7 } };
            },
          }),
        ],
        { command: "repl", args: [] },
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(started).toBe(0);
  });

  it("R3: setup failure and cancellation join acquired resources before any operational work", function* () {
    for (const cancel of [false, true]) {
      yield* scoped(function* () {
        const cleanup = withResolvers<void>();
        const release = withResolvers<void>();
        const gated = withResolvers<void>();
        let ready = false;
        let sidekick = false;
        let joined = false;
        const failure = new Error("setup failed");
        const first = Plugin({
          name: "first",
          *install(): Operation<ReplPluginInstallation> {
            yield* sleep(0);
            return {
              repl: {
                *initialize() {
                  yield* ensure(function* () {
                    cleanup.resolve();
                    yield* release.operation;
                  });
                },
                *sidekick() {
                  sidekick = true;
                  yield* sleep(0);
                },
              },
            };
          },
        });
        const second = Plugin({
          name: "second",
          *install(): Operation<ReplPluginInstallation> {
            yield* sleep(0);
            return {
              repl: {
                *initialize() {
                  gated.resolve();
                  if (cancel) {
                    yield* suspend();
                  }
                  throw failure;
                },
              },
            };
          },
        });
        const host = yield* useMountedHost({ plugins: [first, second] });
        const view = yield* useReplLiveScreen();
        const running = yield* spawn(function* () {
          try {
            return yield* runReplProgram({
              profile: host.profile,
              root: host.root,
              headless: {
                view,
                *ready() {
                  ready = true;
                  yield* sleep(0);
                },
              },
            });
          } catch (error) {
            return error;
          } finally {
            joined = true;
          }
        });
        yield* gated.operation;
        const halting = cancel ? yield* spawn(() => running.halt()) : undefined;
        yield* cleanup.operation;
        expect(joined).toBe(false);
        expect(ready).toBe(false);
        expect(sidekick).toBe(false);
        release.resolve();
        if (halting !== undefined) {
          yield* halting;
        } else {
          expect(yield* running).toBe(failure);
        }
        expect(joined).toBe(true);
      });
    }
  });
});
