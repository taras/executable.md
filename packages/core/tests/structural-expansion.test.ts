/**
 * Tier EX — expanding one occurrence of an installed structural form (§6.1).
 *
 * The order is the whole contract. What the author wrote is decided from source
 * first, then the parent's props are evaluated and checked, then each accepted
 * child's, in source order — and only a complete, validated occurrence is
 * published to public policy and handed to the installation that declared it.
 *
 * Every row reads that order back rather than assuming it. The controlled
 * installation counts what it was asked to do, the document records every
 * expression it evaluates and every component it resolves, and a row claiming
 * that a failure "reached no implementation" reads those counters.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";

import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { Execution } from "../mod.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { ExpansionProtocolError } from "../src/expansion-request.ts";
import type { ExpansionRegion, ExpansionRequest } from "../src/expansion-request.ts";
import type { StructuralDeclaration } from "../src/execution-declarations.ts";
import { retainedSource } from "../src/root-source.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import { installedAuthority } from "./support/installed-structural.ts";
import type { Segment } from "../src/types.ts";

const ORIGIN = "@test/panels";
const ROOT = "root.md";

function panel(overrides: Partial<StructuralDeclaration> = {}): StructuralDeclaration {
  return {
    kind: "structural",
    name: "Panel",
    origin: ORIGIN,
    forms: ["paired"],
    props: {
      type: "object",
      properties: {
        columns: { type: "number", multipleOf: 1, minimum: 1 },
        label: { type: "string", default: "untitled" },
        meta: { type: "object" },
      },
      required: ["columns"],
      additionalProperties: false,
    },
    syntax: ["<Panel columns={2}>…</Panel>"],
    description: "Arrange slots.",
    context: "The `<Slot>` children the panel arranges.",
    placement: { kind: "parent", minimumChildren: 1, nested: "forbidden" },
    ...overrides,
  };
}

function slot(overrides: Partial<StructuralDeclaration> = {}): StructuralDeclaration {
  return {
    kind: "structural",
    name: "Slot",
    origin: ORIGIN,
    forms: ["self-closing", "paired"],
    props: {
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
      additionalProperties: false,
    },
    syntax: ['<Slot title="One" />'],
    description: "One slot.",
    context: "Markdown the slot renders.",
    placement: { kind: "child", parent: "Panel" },
    ...overrides,
  };
}

/** What the implementation was handed, and what the document reached. */
interface Observed {
  /** Each occurrence's request, in the order the implementation received it. */
  requests: ExpansionRequest[];
  /** The regions handed with each request. */
  regions: readonly ExpansionRegion[][];
  /** Every expression the document evaluated, by label, in order. */
  calls: string[];
  /** Every component the document tried to resolve, in order. */
  imports: string[];
  /** How many times the package's own resource was reached. */
  resources: number;
}

function harness(
  declarations: readonly StructuralDeclaration[] = [panel(), slot()],
  expand?: (
    request: ExpansionRequest,
    regions: readonly ExpansionRegion[],
    observed: Observed,
  ) => Operation<void>,
): { installation: ExecutionInstallation; observed: Observed } {
  const observed: Observed = { requests: [], regions: [], calls: [], imports: [], resources: 0 };
  const installation: ExecutionInstallation = {
    declarations,
    *expand(request, regions): Operation<void> {
      observed.requests.push(request);
      observed.regions = [...observed.regions, [...regions]];
      observed.resources++;
      if (expand !== undefined) {
        yield* expand(request, regions, observed);
      }
    },
  };
  return { installation, observed };
}

/**
 * Run one document with every boundary a child's body would cross trapped.
 *
 * A component the run resolves and an expression it evaluates are recorded
 * rather than performed, so "nothing beneath the parent happened" is something
 * a row reads back instead of assuming.
 */
function run(
  source: string,
  installation: ExecutionInstallation,
  observed: Observed,
  values: Record<string, unknown> = {},
): Operation<Json> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          observed.imports.push(name);
          throw new Error(`Component not found: ${name}`);
        },
      },
      { at: "min" },
    );
    yield* Component.around(
      {
        env: () => ({
          values: {
            ...values,
            seen: (label: string, value: unknown) => {
              observed.calls.push(label);
              return value;
            },
          },
        }),
      },
      { at: "min" },
    );
    return yield* collect(
      yield* executeInstalled(
        { ...retainedSource(ROOT, source), stream: new InMemoryStream(), includes: [] },
        [installation],
      ),
    );
  });
}

/**
 * Expand one document directly, under an environment this row supplies.
 *
 * `run()` above drives a whole execution, which is what the protocol rows need.
 * A row about *evaluating props* needs values and a recorder in the document's
 * environment, and this is where an expansion is given one.
 */
function expandWith(
  source: string,
  installation: ExecutionInstallation,
  observed: Observed,
  values: Record<string, unknown> = {},
): Operation<Segment[]> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          observed.imports.push(name);
          throw new Error(`Component not found: ${name}`);
        },
      },
      { at: "min" },
    );
    yield* Component.around(
      {
        env: () => ({
          values: {
            ...values,
            seen: (label: string, value: unknown) => {
              observed.calls.push(label);
              return value;
            },
          },
        }),
      },
      { at: "min" },
    );
    const authority = yield* installedAuthority(installation);
    return yield* expandSegments(
      scanSegments(source),
      {},
      {},
      new Set(),
      undefined,
      undefined,
      "",
      0,
      undefined,
      authority,
    );
  });
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

const ONE_SLOT = '<Panel columns={2}><Slot title="One" /></Panel>\n';

describe("Tier PV — props arrive evaluated, validated and frozen", () => {
  it("PV1: literals, expressions, defaults and nested JSON all arrive as values", function* () {
    const { installation, observed } = harness();

    yield* expandWith(
      [
        '<Panel columns={size} meta={{ rows: [1, 2], nested: { deep: true } }} label="board">',
        "<Slot title={name} />",
        "</Panel>",
        "",
      ].join("\n"),
      installation,
      observed,
      { size: 3, name: "computed" },
    );

    const [request] = observed.requests;
    expect(request?.name).toBe("Panel");
    expect(request?.origin).toBe(ORIGIN);
    expect(request?.form).toBe("paired");
    expect(request?.props).toEqual({
      columns: 3,
      label: "board",
      meta: { rows: [1, 2], nested: { deep: true } },
    });
    const [regions] = observed.regions;
    expect(regions?.[0]?.props).toEqual({ title: "computed" });
    expect(regions?.[0]?.form).toBe("self-closing");
  });

  it("PV1: a schema default appears even where the author wrote nothing", function* () {
    const { installation, observed } = harness();

    yield* run(ONE_SLOT, installation, observed);

    expect(observed.requests[0]?.props["label"]).toBe("untitled");
  });

  it("PV1: an expression resolving to undefined leaves the prop absent", function* () {
    const { installation, observed } = harness([
      panel({
        props: {
          type: "object",
          properties: {
            columns: { type: "number", multipleOf: 1, minimum: 1 },
            note: { type: "string" },
          },
          required: ["columns"],
          additionalProperties: false,
        },
      }),
      slot(),
    ]);

    yield* expandWith(
      '<Panel columns={2} note={missing}><Slot title="One" /></Panel>\n',
      installation,
      observed,
      { missing: undefined },
    );

    expect("note" in (observed.requests[0]?.props ?? {})).toBe(false);
  });

  it("PV1: the request, its props and every nested container are deeply frozen", function* () {
    const { installation, observed } = harness();

    yield* run(
      '<Panel columns={2} meta={{ rows: [1], nested: { deep: true } }}><Slot title="One" /></Panel>\n',
      installation,
      observed,
    );

    const request = observed.requests[0];
    if (request === undefined) {
      throw new Error("the implementation received no request");
    }
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.props)).toBe(true);
    const meta = request.props["meta"];
    expect(Object.isFrozen(meta)).toBe(true);
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      throw new Error("meta did not arrive as an object");
    }
    const members: Record<string, unknown> = { ...meta };
    expect(Object.isFrozen(members["rows"])).toBe(true);
    expect(Object.isFrozen(members["nested"])).toBe(true);
    // The regions and the array holding them are the implementation's to read
    // and nobody's to change.
    expect(Object.isFrozen(observed.regions[0]?.[0])).toBe(true);
  });

  it("PV1: the parent's props evaluate before any child's, in source order", function* () {
    const { installation, observed } = harness();

    yield* expandWith(
      [
        "<Panel columns={seen('parent', 2)}>",
        "<Slot title={seen('first', 'a')} />",
        "<Slot title={seen('second', 'b')} />",
        "</Panel>",
        "",
      ].join("\n"),
      installation,
      observed,
    );

    expect(observed.calls).toEqual(["parent", "first", "second"]);
  });

  it("PV1: a prop the schema refuses stops before middleware, the implementation and the body", function* () {
    const { installation, observed } = harness();
    let middleware = 0;

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          *expand([request], next) {
            middleware++;
            yield* next(request);
          },
        });
        return yield* run(
          ["<Panel columns={0}>", '<Slot title="One"><Missing /></Slot>', "</Panel>", ""].join(
            "\n",
          ),
          installation,
          observed,
        );
      }),
    );

    expect(message(failure)).toContain("columns");
    expect(middleware).toBe(0);
    expect(observed.requests).toEqual([]);
    expect(observed.resources).toBe(0);
    expect(observed.imports).toEqual([]);
  });

  it("PV1: a later child's props do not evaluate after an earlier one fails", function* () {
    const { installation, observed } = harness();

    yield* expandWith(
      [
        "<Panel columns={2}>",
        '<Slot title="" />',
        "<Slot title={seen('later', 'b')} />",
        "</Panel>",
        "",
      ].join("\n"),
      installation,
      observed,
    );

    expect(observed.calls).toEqual([]);
    expect(observed.requests).toEqual([]);
  });

  it("PV1: an unknown prop is refused by the declared schema", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      run(
        '<Panel columns={2} layout="tiled"><Slot title="One" /></Panel>\n',
        installation,
        observed,
      ),
    );

    expect(message(failure)).toContain("layout");
    expect(observed.requests).toEqual([]);
  });
});

describe("Tier PL — where a document may write an installed form", () => {
  it("PL1: whitespace between accepted children is nothing at all", function* () {
    const { installation, observed } = harness();

    yield* run(
      [
        "<Panel columns={2}>",
        "",
        '<Slot title="One" />',
        "",
        '<Slot title="Two" />',
        "",
        "</Panel>",
        "",
      ].join("\n"),
      installation,
      observed,
    );

    expect(observed.regions[0]?.map((region) => region.props["title"])).toEqual(["One", "Two"]);
  });

  it("PL1: text, a foreign element and a control structure are each refused", function* () {
    const rows: [string, string, string][] = [
      ["text", '<Panel columns={2}>a note<Slot title="One" /></Panel>\n', 'Found text "a note"'],
      [
        "a foreign element",
        '<Panel columns={2}><Note /><Slot title="One" /></Panel>\n',
        "Found <Note>",
      ],
      [
        "a control structure",
        '<Panel columns={2}><If condition={true}><Slot title="One" /></If></Panel>\n',
        "Found <If>",
      ],
    ];

    for (const [form, source, expected] of rows) {
      const { installation, observed } = harness();
      const failure = yield* raised(run(source, installation, observed));
      expect(`${form}: ${message(failure)}`).toContain(expected);
      expect(`${form}: ${observed.requests.length}`).toBe(`${form}: 0`);
    }
  });

  it("PL1: too few children, the wrong form, and a forbidden nested parent are refused", function* () {
    const rows: [string, string, string][] = [
      ["no child", "<Panel columns={2}></Panel>\n", "requires at least one <Slot>"],
      ["self-closing", "<Panel columns={2} />\n", "written paired"],
      [
        "a nested parent",
        '<Panel columns={2}><Slot title="One"><Panel columns={1}><Slot title="Two" /></Panel>' +
          "</Slot></Panel>\n",
        "cannot be written inside another <Panel>",
      ],
    ];

    for (const [form, source, expected] of rows) {
      const { installation, observed } = harness();
      const failure = yield* raised(run(source, installation, observed));
      expect(`${form}: ${message(failure)}`).toContain(expected);
      expect(`${form}: ${observed.requests.length}`).toBe(`${form}: 0`);
    }
  });

  it("PL1: a child written outside every parent names no component", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(run('<Slot title="One" />\n', installation, observed));

    expect(message(failure)).toContain("<Slot> must be a direct child of <Panel>");
    // It is installed syntax, so selection never went looking for a file.
    expect(observed.imports).toEqual([]);
  });

  it("PL1: a child below its parent that is not one of its children is refused", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      run(
        '<Panel columns={2}><Slot title="One"><Slot title="Two" /></Slot></Panel>\n',
        installation,
        observed,
      ),
    );

    expect(message(failure)).toContain("<Slot> must be a direct child of <Panel>");
    expect(observed.requests).toEqual([]);
  });

  it("PL1: `as` on an installed form is refused by its declared schema", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      run('<Panel columns={2} as="board"><Slot title="One" /></Panel>\n', installation, observed),
    );

    expect(message(failure)).toContain("as");
    expect(observed.requests).toEqual([]);
  });
});

describe("Tier EX — public policy observes, refuses and delegates", () => {
  it("EX1: middleware sees the frozen request and delegates it to the captured owner", function* () {
    const { installation, observed } = harness();
    const seen: ExpansionRequest[] = [];

    yield* scoped(function* () {
      yield* Execution.around({
        *expand([request], next) {
          seen.push(request);
          yield* next(request);
        },
      });
      return yield* run(ONE_SLOT, installation, observed);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("Panel");
    expect(Object.isFrozen(seen[0])).toBe(true);
    // The same request object the implementation was handed.
    expect(seen[0]).toBe(observed.requests[0]);
  });

  it("EX1: middleware is given no regions and no implementation", function* () {
    const { installation, observed } = harness();
    let keys: string[] = [];

    yield* scoped(function* () {
      yield* Execution.around({
        *expand([request], next) {
          keys = Object.keys(request);
          yield* next(request);
        },
      });
      return yield* run(ONE_SLOT, installation, observed);
    });

    expect(keys.sort()).toEqual(["form", "name", "origin", "position", "props"]);
    expect(keys).not.toContain("regions");
    expect(keys).not.toContain("expand");
  });

  it("EX1: a handler that returns without delegating is refused, and nothing expands", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          // deno-lint-ignore require-yield
          *expand() {
            return undefined;
          },
        });
        return yield* run(ONE_SLOT, installation, observed);
      }),
    );

    expect(message(failure)).toContain("returned without delegating");
    expect(observed.requests).toEqual([]);
    expect(observed.resources).toBe(0);
  });

  it("EX1: a handler that throws refuses the occurrence and reaches no owner", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          // deno-lint-ignore require-yield
          *expand() {
            throw new Error("refused by policy");
          },
        });
        return yield* run(ONE_SLOT, installation, observed);
      }),
    );

    expect(message(failure)).toContain("refused by policy");
    expect(observed.requests).toEqual([]);
  });

  it("EX1: a forged request cannot invoke an owner", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          *expand([request], next) {
            yield* next({
              name: request.name,
              origin: request.origin,
              form: request.form,
              props: { columns: 99 },
            });
          },
        });
        return yield* run(ONE_SLOT, installation, observed);
      }),
    );

    expect(message(failure)).toContain("canonical execution did not issue");
    expect(observed.requests).toEqual([]);
  });

  it("EX1: delegating one occurrence's request twice is refused", function* () {
    const { installation, observed } = harness();

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          *expand([request], next) {
            yield* next(request);
            yield* next(request);
          },
        });
        return yield* run(ONE_SLOT, installation, observed);
      }),
    );

    expect(message(failure)).toContain("more than once");
    expect(observed.requests).toHaveLength(1);
  });

  it("EX1: a request kept from a sibling occurrence cannot settle another", function* () {
    const { installation, observed } = harness();
    let retained: ExpansionRequest | undefined;

    const failure = yield* raised(
      scoped(function* () {
        yield* Execution.around({
          *expand([request], next) {
            if (retained === undefined) {
              retained = request;
              yield* next(request);
              return;
            }
            yield* next(retained);
          },
        });
        return yield* run(
          [
            '<Panel columns={1}><Slot title="One" /></Panel>',
            '<Panel columns={1}><Slot title="Two" /></Panel>',
            "",
          ].join("\n"),
          installation,
          observed,
        );
      }),
    );

    expect(message(failure)).toContain("another expansion issued");
    expect(observed.requests).toHaveLength(1);
  });

  it("EX1: the public default refuses outside canonical execution", function* () {
    const failure = yield* raised(
      Execution.operations.expand({
        name: "Panel",
        origin: ORIGIN,
        form: "paired",
        props: {},
      }),
    );

    expect(failure).toBeInstanceOf(ExpansionProtocolError);
    expect(message(failure)).toContain("outside canonical core");
  });
});

describe("Tier EX — an implementation's failure is the parent's failure", () => {
  it("EX1: a thrown error becomes a positioned checked failure at the parent site", function* () {
    const { installation, observed } = harness([panel(), slot()], function* () {
      throw new Error("the package refused");
    });

    const failure = yield* raised(run(ONE_SLOT, installation, observed));

    expect(message(failure)).toContain("the package refused");
    expect(message(failure)).toContain(`${ROOT}:1:1`);
  });

  it("EX1: a JSON cause is carried onto the failure as evidence", function* () {
    const { installation, observed } = harness([panel(), slot()], function* () {
      throw new Error("no provider", { cause: { layout: { columns: 2, rows: 1 } } });
    });

    const failure = yield* raised(run(ONE_SLOT, installation, observed));

    expect(message(failure)).toContain("no provider");
  });
});
