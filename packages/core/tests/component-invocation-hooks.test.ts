import { capture } from "../src/component-api.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { API } from "@executablemd/runtime";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import {
  createDurableOperation,
  InMemoryStream,
  StaleInputError,
} from "@executablemd/durable-streams";
import { Component, content, formDispatcher, registerComponents } from "../mod.ts";
import type { Json } from "../mod.ts";
import { ComponentInvocationCancelled, executeInstalled } from "../host.ts";
import type {
  ComponentInvocationHooks,
  ComponentInvocationObservation,
  ExecutionInstallation,
  IdentityComponent,
} from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import { useHeldHost } from "./support/held-host.ts";

const props = { type: "object", properties: {}, additionalProperties: false };
function declaration(body: () => Operation<unknown>, name = "Observed"): IdentityComponent {
  return { name, origin: "test://observation", props, factory: () => body };
}
function* run(source: string, installation: ExecutionInstallation) {
  const stream = new InMemoryStream();
  const execution = yield* executeInstalled({ ...retainedSource("hooks.md", source), stream }, [
    installation,
  ]);
  return { result: yield* execution, stream };
}
function* text(): Operation<string> {
  yield* sleep(0);
  return "ordinary";
}

describe("Installation-owned component observation", () => {
  it("R4a/R6: preserves dual-form dispatch, generated identity and accepted values", function* () {
    const events: string[] = [];
    const observations: ComponentInvocationObservation[] = [];
    const values: unknown[] = [];
    const names: string[] = [];
    let projected = 0;
    const component: IdentityComponent = {
      name: "Observed",
      origin: "test://observation",
      props: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { label: { type: "string", default: "default" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      captures: ["raw"],
      returns: {
        type: "object",
        properties: { form: { type: "string" }, accepted: { type: "boolean", default: true } },
        required: ["form", "accepted"],
        additionalProperties: false,
      },
      forms: ["self-closing", "paired"],
      generated: {
        "self-closing": { identity: "https://executable.md/test/observed/read", effect: "read" },
        paired: { identity: "https://executable.md/test/observed/write", effect: "write" },
      },
      factory(claim) {
        function body(form: string) {
          return function* (input: Record<string, Json>, invocation: Parameters<typeof claim>[0]) {
            const name = yield* claim(invocation);
            names.push(name);
            if (form === "write") {
              yield* content();
            }
            const nested = input.nested;
            if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
              nested.label = "changed";
            }
            yield createDurableOperation({ type: "observed", name }, function* () {
              events.push(form);
              return form;
            });
            return { form };
          };
        }
        return formDispatcher({
          forms: "both",
          "self-closing": body("read"),
          paired: body("write"),
        });
      },
    };
    const hooks: ComponentInvocationHooks = {
      *before(observation) {
        expect(projected).toBe(observations.length < 2 ? 0 : 1);
        observations.push(observation);
        expect(Object.isFrozen(observation)).toBe(true);
        expect(Object.isFrozen(observation.props.nested)).toBe(true);
        expect(observation.props).toEqual({ nested: { label: "default" } });
        yield* sleep(0);
      },
      *after(observation, outcome, cancelled) {
        expect(observations.includes(observation)).toBe(true);
        expect(cancelled).toBe(false);
        expect(observation.props).toEqual({ nested: { label: "default" } });
        if (outcome.ok) {
          values.push(outcome.value);
        }
        yield* sleep(0);
      },
    };
    const installation: ExecutionInstallation = {
      components: [component],
      componentInvocations: hooks,
      *install() {
        hooks.before = function* () {
          throw new Error("late mutation");
        };
        hooks.after = hooks.before;
        yield* registerComponents([
          {
            name: "Projected",
            origin: "test://projection",
            props,
            *fn() {
              projected++;
              yield* sleep(0);
              return "content";
            },
          },
        ]);
        yield* Component.around({ generated: () => ({ Observed: ["self-closing", "paired"] }) });
      },
    };
    const held = yield* useHeldHost({
      installations: [installation],
      root: {
        path: "hooks.md",
        source:
          '<Let as="inputs" value={{}} /><Observed nested={inputs} raw={undefined} slot="named" as="read" />\n<Observed nested={{}} as="write"><Projected /></Observed>\n<Held />',
      },
      inside: function* () {
        const caller = yield* Component.operations.env;
        expect(caller?.values.inputs).toEqual({});
        expect(caller?.values.read).toEqual({ form: "read", accepted: true });
        expect(caller?.values.write).toEqual({ form: "write", accepted: true });
      },
    });
    expect(events).toEqual(["read", "write"]);
    const evaluated = yield* held.execution.evaluateGeneratedXmdRoot({
      id: "dual",
      source:
        '<Observed nested={{}} as="a" />\n<Observed nested={{}} as="b">body</Observed>\n<Output><Json value={[a,b]} /></Output>',
      allow: ["read", "write"],
    });
    expect(evaluated.ok).toBe(true);
    expect(events).toEqual(["read", "write", "read", "write"]);
    expect(values).toEqual([
      { form: "read", accepted: true },
      { form: "write", accepted: true },
      { form: "read", accepted: true },
      { form: "write", accepted: true },
    ]);
    expect(new Set(names).size).toBe(4);
    expect(new Set(observations).size).toBe(4);
    const refused = yield* held.execution.evaluateGeneratedXmdRoot({
      id: "readonly",
      source: '<Observed nested={{}} as="denied">body</Observed>',
      allow: ["read"],
    });
    expect(refused.ok).toBe(false);
    expect(events).toHaveLength(4);
  });

  it("R4b: independently optional callbacks and invalid inputs", function* () {
    for (const mode of ["none", "before", "after"]) {
      let before = 0;
      let after = 0;
      const hooks: ComponentInvocationHooks =
        mode === "before"
          ? {
              *before() {
                before++;
                yield* sleep(0);
              },
            }
          : {
              *after() {
                after++;
                yield* sleep(0);
              },
            };
      const done = yield* run('<Observed as="value" />', {
        components: [declaration(text)],
        ...(mode === "none" ? {} : { componentInvocations: hooks }),
      });
      expect(done.result.ok).toBe(true);
      expect([before, after]).toEqual(
        mode === "none" ? [0, 0] : mode === "before" ? [1, 0] : [0, 1],
      );
      const refused = yield* run('<Observed invalid="yes" />', {
        components: [declaration(text)],
        componentInvocations: hooks,
      });
      expect(refused.result.ok).toBe(false);
      expect([before, after]).toEqual(
        mode === "none" ? [0, 0] : mode === "before" ? [1, 0] : [0, 1],
      );
    }
    let observed = false;
    const selected = yield* run("<Observed />", {
      components: [declaration(text)],
      componentInvocations: {
        *before() {
          observed = true;
          yield* sleep(0);
        },
      },
      *install() {
        yield* Component.around({
          registry: (_args, next) =>
            new Map([
              ...next(),
              [
                "Observed",
                {
                  default: {
                    origin: "test://nearer",
                    definition: {
                      kind: "function",
                      name: "Observed",
                      props,
                      fn: function* () {
                        yield* sleep(0);
                        return "replacement";
                      },
                    },
                  },
                },
              ],
            ]),
        });
      },
    });
    expect(selected.result.ok).toBe(true);
    expect(observed).toBe(false);
  });

  it("R4c/d: before rejection, return refusal, callback failure and fatal precedence", function* () {
    for (const mode of ["before", "return", "after", "body", "fatal"]) {
      const failure =
        mode === "fatal" ? new StaleInputError("fatal witness") : new Error("original");
      const callback = new Error("after failure");
      let effects = 0;
      let seen: Result<unknown> | undefined;
      let beforeObservation: ComponentInvocationObservation | undefined;
      let afterObservation: ComponentInvocationObservation | undefined;
      let callbackCleaned = false;
      const component: IdentityComponent = {
        name: "Observed",
        origin: "test://observation",
        props,
        factory: (claim) =>
          function* (_props, invocation) {
            const name = yield* claim(invocation);
            yield createDurableOperation({ type: "observer_effect", name }, function* () {
              effects++;
              yield* sleep(0);
              return "effect";
            });
            if (mode === "body" || mode === "fatal") {
              throw failure;
            }
            return mode === "return" ? false : "value";
          },
      };
      const done = yield* run('<Observed as="result" />', {
        components: [{ ...component, returns: { type: "string" } }],
        componentInvocations: {
          *before(observation) {
            beforeObservation = observation;
            if (mode === "before") {
              throw failure;
            }
            yield* sleep(0);
          },
          *after(observation, outcome, cancelled) {
            afterObservation = observation;
            yield* ensure(() => {
              callbackCleaned = true;
            });
            seen = outcome;
            expect(cancelled).toBe(false);
            if (["body", "fatal", "after"].includes(mode)) {
              throw callback;
            }
            yield* sleep(0);
          },
        },
      });
      expect(done.result.ok).toBe(false);
      expect(afterObservation).toBe(beforeObservation);
      expect(callbackCleaned).toBe(true);
      expect(effects).toBe(mode === "before" ? 0 : 1);
      expect(
        done.stream
          .snapshot()
          .filter(
            (event) => event.type === "yield" && event.description.type === "observer_effect",
          ),
      ).toHaveLength(mode === "before" ? 0 : 1);
      if (mode === "body") {
        expect(
          done.result.ok === false &&
            done.result.error instanceof AggregateError &&
            done.result.error.errors,
        ).toEqual([failure, callback]);
      }
      expect(seen?.ok).toBe(mode === "after");
      if (mode === "before" || mode === "body" || mode === "fatal") {
        expect(seen?.ok === false && seen.error).toBe(failure);
      }
      if (mode === "fatal") {
        expect(done.result.ok === false && done.result.error).toBe(failure);
      }
    }
  });

  it("R4e: halt joins cleanup and supplies the canonical boolean", function* () {
    for (const teardownFails of [false, true]) {
      const entered = withResolvers<void>();
      const cleaning = withResolvers<void>();
      const release = withResolvers<void>();
      const notified = withResolvers<void>();
      const afterRelease = withResolvers<void>();
      const failure = new Error("owning cleanup");
      let cancelled: boolean | undefined;
      let seen: Result<unknown> | undefined;
      let joined = false;
      const task = yield* spawn(function* () {
        yield* run("<Observed />", {
          components: [
            declaration(function* () {
              yield* ensure(function* () {
                cleaning.resolve();
                yield* release.operation;
                if (teardownFails) {
                  throw failure;
                }
              });
              entered.resolve();
              yield* suspend();
            }),
          ],
          componentInvocations: {
            *after(_observation, outcome, selected) {
              seen = outcome;
              cancelled = selected;
              yield* ensure(() => afterRelease.operation);
              notified.resolve();
            },
          },
        });
        throw new Error("cancelled caller continued");
      });
      yield* entered.operation;
      const halt = yield* spawn(function* () {
        try {
          yield* task.halt();
        } catch {
          /* The teardown failure belongs to halt. */
        }
        joined = true;
      });
      yield* cleaning.operation;
      expect(seen).toBeUndefined();
      release.resolve();
      yield* notified.operation;
      expect(cancelled).toBe(!teardownFails);
      expect(joined).toBe(false);
      if (!teardownFails) {
        expect(seen?.ok === false && seen.error.name).toBe("ComponentInvocationCancelled");
        expect(seen?.ok === false && seen.error.message).toBe(
          "The component invocation was cancelled.",
        );
        expect(seen?.ok === false && Object.hasOwn(seen.error, "cause")).toBe(false);
        expect(seen?.ok === false && Object.hasOwn(seen.error, "operation")).toBe(false);
      } else {
        expect(seen?.ok === false && seen.error.name).toBe("InvocationTeardownError");
        expect(seen?.ok === false && seen.error.cause).toBe(failure);
      }
      afterRelease.resolve();
      yield* halt;
      expect(joined).toBe(true);
    }
    const ordinary = new ComponentInvocationCancelled();
    let observed: unknown;
    let cancelled: boolean | undefined;
    yield* run("<Observed />", {
      components: [
        declaration(function* () {
          yield* sleep(0);
          throw ordinary;
        }),
      ],
      componentInvocations: {
        *after(_observation, outcome, selected) {
          observed = outcome.ok ? outcome.value : outcome.error;
          cancelled = selected;
          yield* sleep(0);
        },
      },
    });
    expect(observed).toBe(ordinary);
    expect(cancelled).toBe(false);
  });
});

describe("Invocation observation settlement", () => {
  it("R4a: successful component cleanup and after cleanup precede caller continuation", function* () {
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const notified = withResolvers<void>();
    const afterRelease = withResolvers<void>();
    let after = false;
    let continued = false;
    const execution = yield* spawn(function* () {
      const result = yield* run('<Observed as="value" />', {
        components: [
          declaration(function* () {
            yield* ensure(function* () {
              cleaning.resolve();
              yield* release.operation;
            });
            return { actual: true };
          }),
        ],
        componentInvocations: {
          *after(_observation, result, cancelled) {
            after = true;
            expect(result.ok && result.value).toEqual({ actual: true });
            expect(cancelled).toBe(false);
            yield* ensure(() => afterRelease.operation);
            notified.resolve();
          },
        },
      });
      expect(result.result.ok).toBe(true);
      continued = true;
    });
    yield* cleaning.operation;
    expect(after).toBe(false);
    release.resolve();
    yield* notified.operation;
    expect(continued).toBe(false);
    afterRelease.resolve();
    yield* execution;
    expect(continued).toBe(true);
  });

  it("R4d: nested notifications unwind and outer after survives inner after failure", function* () {
    const order: string[] = [];
    const failure = new Error("inner after");
    const components = [
      declaration(function* () {
        return yield* content();
      }, "Outer"),
      declaration(text, "Inner"),
    ];
    const result = yield* run("<Outer><Inner /></Outer>", {
      components,
      componentInvocations: {
        *before(observation) {
          order.push(`before:${observation.component}`);
          yield* sleep(0);
        },
        *after(observation) {
          order.push(`after:${observation.component}`);
          if (observation.component === "Inner") {
            throw failure;
          }
          yield* sleep(0);
        },
      },
    });
    expect(result.result.ok).toBe(false);
    expect(order).toEqual(["before:Outer", "before:Inner", "after:Inner", "after:Outer"]);
  });
});

describe("Observed live protected returns", () => {
  it("accepts an elicited leaf after cleanup and preserves caller controlled use without publication", function* () {
    let secret = "";
    let produced: unknown;
    let accepted: unknown;
    let notified = false;
    let exactCommand = false;
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    yield* Elicitation.around({
      *elicit() {
        secret = String(Math.floor(100000 + Math.random() * 900000));
        return { code: secret };
      },
    });
    yield* API.Process.around({
      *exec([options]) {
        exactCommand = options.command.join(" ").includes(secret);
        return { exitCode: 0, stdout: secret, stderr: undefined };
      },
    });
    const running = yield* spawn(() =>
      run(
        [
          '<Elicit schema={{type:"object",properties:{code:{type:"string",writeOnly:true}},required:["code"],additionalProperties:false}} as="answer">Enter a code.</Elicit>',
          '<ObservedProtected value={answer.code} as="captured" />',
          "```bash exec",
          "printf '{captured.code}'",
          "```",
          "<Output><Json value={captured} /></Output>",
        ].join("\n\n"),
        {
          components: [
            {
              name: "ObservedProtected",
              origin: "test://observed-protected",
              props,
              captures: ["value"],
              returns: {
                type: "object",
                properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
                required: ["code"],
                additionalProperties: false,
              },
              factory: () =>
                function* () {
                  yield* ensure(function* () {
                    cleaning.resolve();
                    yield* release.operation;
                  });
                  produced = { code: yield* capture("value") };
                  return produced;
                },
            },
          ],
          componentInvocations: {
            *after(_observation, outcome, cancelled) {
              expect(cancelled).toBe(false);
              if (!outcome.ok) {
                throw outcome.error;
              }
              accepted = outcome.value;
              notified = true;
              yield* sleep(0);
            },
          },
        },
      ),
    );
    yield* cleaning.operation;
    expect(notified).toBe(false);
    expect(exactCommand).toBe(false);
    release.resolve();
    const completed = yield* running;
    expect(completed.result.ok).toBe(true);
    expect(notified).toBe(true);
    expect(accepted).toBe(produced);
    expect(exactCommand).toBe(true);
    expect(JSON.stringify(completed.result).includes(secret)).toBe(false);
    expect(JSON.stringify(completed.stream.snapshot()).includes(secret)).toBe(false);
    expect(JSON.stringify(completed.result)).toContain("[redacted]");
  });
});
