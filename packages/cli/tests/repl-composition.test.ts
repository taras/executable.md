/**
 * The keyed composition kernel (#848 C1, C2, I1).
 *
 * Small fake components, one real Freedom tree. What is under test is the
 * protocol Slices D and E consume: that a description reconciles into exactly
 * one mounted tree, that identity survives redescription, that an absent
 * description leaves nothing behind, and that a normalized event reaches the
 * same place whether it arrived as a key or as a click.
 *
 * No terminal, no bytes, no cell geometry. The frame here is a list of strings
 * each mounted node contributed, which is enough to prove that a removed node
 * stops contributing and not enough to pretend a renderer exists.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, sleep, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as composition from "../src/repl/description.ts";
import {
  component,
  describe as describeNode,
  detach,
  fields,
  readComponent,
  readDescription,
  validateDescriptions,
} from "../src/repl/description.ts";
import type {
  ReplComponent,
  ReplDescription,
  ReplInputEvent,
  ReplNode,
  ReplViewData,
} from "../src/repl/description.ts";
import { useReplHandoff } from "../src/repl/handoff.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplTree } from "../src/repl/reconcile.ts";
import * as patched from "../src/repl/vendor/freedom/patched/index.ts";
import type { Root } from "../src/repl/vendor/freedom/patched/index.ts";
import * as upstream from "../src/repl/vendor/freedom/upstream/index.ts";

/** The shape `MANIFEST.json` records, as this test reads it back. */
interface VendorManifest {
  readonly commit: string;
  readonly repository: string;
  readonly license: { readonly upstreamRepository: string; readonly packageMetadata: string };
  readonly patches: readonly { readonly name: string; readonly files: readonly string[] }[];
  readonly files: readonly {
    readonly path: string;
    readonly kind: string;
    readonly sha256?: string;
    readonly upstream?: string;
    readonly patched?: string;
    readonly patch?: string;
  }[];
}

/**
 * The closed set of things a component in these tests can ask for.
 *
 * Closed on purpose: the composition surface is parameterized by it, so a
 * component cannot invent an action and the root cannot receive one it has no
 * case for.
 */
type Act =
  | { readonly kind: "activate"; readonly from: string }
  | { readonly kind: "submit"; readonly from: string }
  | { readonly kind: "close-drawer"; readonly from: string };

/** What each fake component did, in the order it did it. */
type Journal = string[];

/** A component's input is view data, so a component narrows it by parsing. */
function label(input: ReplViewData): string {
  const value = fields(input)?.["label"];
  if (typeof value !== "string") {
    throw new Error("this fake is given a { label } input");
  }
  return value;
}

/** A focusable leaf that records its whole lifetime and follows its input. */
function panel(journal: Journal): ReplComponent<Act> {
  return component<Act>({
    name: "panel",
    attach(node: ReplNode<Act>): () => void {
      journal.push(`mount:${node.key}`);
      node.focusable();
      node.render(`[${label(node.input)}]`);
      node.claim((event: ReplInputEvent): Act | undefined =>
        event.kind === "pointer" || (event.kind === "key" && event.key === "Enter")
          ? { kind: "activate", from: node.key }
          : undefined,
      );
      node.onInput((input: ReplViewData) => {
        journal.push(`update:${node.key}`);
        node.render(`[${label(input)}]`);
      });
      return () => journal.push(`unmount:${node.key}`);
    },
    *lifetime(node: ReplNode<Act>): Operation<void> {
      journal.push(`running:${node.key}`);
      yield* sleep(60_000);
    },
  });
}

/** A different component type under the same key, for replacement. */
function banner(journal: Journal): ReplComponent<Act> {
  return component<Act>({
    name: "banner",
    attach(node: ReplNode<Act>): () => void {
      journal.push(`mount:${node.key}`);
      node.render(`<${label(node.input)}>`);
      node.onInput((input: ReplViewData) => node.render(`<${label(input)}>`));
      return () => journal.push(`unmount:${node.key}`);
    },
  });
}

/** A focusable leaf that claims nothing, so events pass to its ancestors. */
function control(journal: Journal): ReplComponent<Act> {
  return component<Act>({
    name: "control",
    attach(node: ReplNode<Act>): () => void {
      journal.push(`mount:${node.key}`);
      node.focusable();
      node.render(`(${label(node.input)})`);
      return () => journal.push(`unmount:${node.key}`);
    },
  });
}

/** An ancestor that owns what its controls mean. */
function group(journal: Journal): ReplComponent<Act> {
  return component<Act>({
    name: "group",
    attach(node: ReplNode<Act>): () => void {
      journal.push(`mount:${node.key}`);
      node.render(`{${label(node.input)}}`);
      node.claim((event: ReplInputEvent): Act | undefined =>
        event.kind === "pointer" || (event.kind === "key" && event.key === "Enter")
          ? { kind: "submit", from: node.key }
          : undefined,
      );
      return () => journal.push(`unmount:${node.key}`);
    },
  });
}

/** A drawer that closes on Escape and answers nothing. */
function drawer(journal: Journal): ReplComponent<Act> {
  return component<Act>({
    name: "drawer",
    attach(node: ReplNode<Act>): () => void {
      journal.push(`mount:${node.key}`);
      node.render(`|${label(node.input)}|`);
      node.claim((event: ReplInputEvent): Act | undefined =>
        event.kind === "pointer" || (event.kind === "key" && event.key === "Escape")
          ? { kind: "close-drawer", from: node.key }
          : undefined,
      );
      return () => journal.push(`unmount:${node.key}`);
    },
  });
}

function child(
  kind: ReplComponent<Act>,
  key: string,
  text: string,
  children: readonly ReplDescription<Act>[] = [],
  options: { placement?: { slot: string }; modal?: true; focus?: true } = {},
): ReplDescription<Act> {
  return describeNode<Act>({
    key,
    component: kind,
    input: { label: text },
    children,
    ...(options.placement === undefined ? {} : { placement: options.placement }),
    ...(options.modal === undefined ? {} : { modal: options.modal }),
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
}

function committed(outcome: { ok: boolean; error?: Error }): void {
  if (!outcome.ok) {
    throw outcome.error;
  }
}

function refused(outcome: { ok: boolean; error?: Error }): Error {
  if (outcome.ok || outcome.error === undefined) {
    throw new Error("this description set was admitted, and it must be refused");
  }
  return outcome.error;
}

/**
 * Every object and array reachable from these roots, the roots included.
 *
 * Functions are skipped: what has to be frozen is the data a handle retains,
 * and a component's `attach` is behavior the factory was given rather than a
 * record the tree stores members on.
 */
function reachableFrom(roots: readonly unknown[]): object[] {
  const seen = new Set<object>();
  const found: object[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    found.push(value);
    for (const member of Object.values(value)) {
      walk(member);
    }
  };
  for (const root of roots) {
    walk(root);
  }
  return found;
}

/** The cells one frame holds, so a test can compare what is drawn. */
function cells(tree: ReplTree<Act>): string[] {
  return tree.frame().cells.map((cell) => cell.cell);
}

/** What one dispatch produced, or a failure naming what came back instead. */
function acted(outcome: { ok: boolean; value?: unknown; error?: Error }) {
  if (!outcome.ok) {
    throw outcome.error;
  }
  const value = outcome.value;
  if (typeof value !== "object" || value === null || !("outcome" in value)) {
    throw new Error("a dispatch answers with a closed outcome");
  }
  return value as
    | { outcome: "action"; action: Act; ancestry: readonly string[] }
    | { outcome: "focus"; focused: string | undefined }
    | { outcome: "dropped"; reason: string };
}

describe("REPL composition: reconciling a described tree", () => {
  it("C1: the same key and component keep the node and its running lifetime", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply([child(kind, "one", "first"), child(kind, "two", "second")]));
    const before = tree.mounted();
    expect(before).toHaveLength(2);
    expect(cells(tree)).toEqual(["[first]", "[second]"]);

    committed(yield* tree.apply([child(kind, "one", "changed"), child(kind, "two", "second")]));

    expect(tree.mounted()).toEqual(before);
    expect(journal.filter((entry) => entry.startsWith("unmount:"))).toEqual([]);
    expect(cells(tree)).toEqual(["[changed]", "[second]"]);
    expect(journal).toContain("update:one");
  });

  it("C1: a changed component replaces the node, and the replacement mounts first", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply([child(panel(journal), "one", "a")]));
    const original = tree.mounted();
    journal.length = 0;

    committed(yield* tree.apply([child(banner(journal), "one", "a")]));

    expect(tree.mounted()).not.toEqual(original);
    expect(journal.filter((entry) => !entry.startsWith("running:"))).toEqual([
      "mount:one",
      "unmount:one",
    ]);
  });

  it("C1: a new sibling mounts before an absent one is removed", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply([child(kind, "one", "a")]));
    journal.length = 0;
    committed(yield* tree.apply([child(kind, "two", "b")]));

    expect(journal.filter((entry) => !entry.startsWith("running:"))).toEqual([
      "mount:two",
      "unmount:one",
    ]);
    expect(cells(tree)).toEqual(["[b]"]);
  });

  it("C1: canonical order is the described order, not the created order", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply([child(kind, "one", "a"), child(kind, "two", "b")]));
    committed(yield* tree.apply([child(kind, "two", "b"), child(kind, "one", "a")]));

    expect(cells(tree)).toEqual(["[b]", "[a]"]);
    expect(tree.mounted().map((id) => tree.keyOf(id))).toEqual(["two", "one"]);
  });

  it("C1: a refused set changes nothing at all", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>((placement) => placement["slot"] !== "nowhere");

    committed(yield* tree.apply([child(kind, "one", "a"), child(kind, "two", "b")]));
    const mounted = tree.mounted();
    const drawn = cells(tree);
    journal.length = 0;

    expect(
      refused(yield* tree.apply([child(kind, "dup", "x"), child(kind, "dup", "y")])).message,
    ).toContain("two children keyed dup");
    expect(
      refused(
        yield* tree.apply([
          child(kind, "a", "x", [], { focus: true }),
          child(kind, "b", "y", [], { focus: true }),
        ]),
      ).message,
    ).toContain("two descriptions claim focus");
    expect(
      refused(yield* tree.apply([child(kind, "a", "x", [], { placement: { slot: "nowhere" } })]))
        .message,
    ).toContain("does not accept");

    expect(tree.mounted()).toEqual(mounted);
    expect(cells(tree)).toEqual(drawn);
    expect(journal).toEqual([]);
  });

  it("C1: an absent description leaves no node, focus, frame or state", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply([child(kind, "one", "a"), child(kind, "two", "b")]));
    const [first] = tree.mounted();
    const stale = tree.frame().id;
    expect(tree.focused()).toBe(first);

    committed(yield* tree.apply([child(kind, "two", "b")]));

    expect(journal).toContain("unmount:one");
    expect(tree.mounted()).not.toContain(first);
    expect(tree.focused()).not.toBe(first);
    expect(cells(tree)).toEqual(["[b]"]);

    const gone = acted(
      yield* tree.dispatch({ kind: "pointer", target: first, frame: tree.frame().id }),
    );
    expect(gone.outcome === "dropped" && gone.reason).toContain("no longer holds");
    expect(stale).not.toBe(tree.frame().id);
  });

  it("C1: next() returns only after that exact set has been committed", function* () {
    const journal: Journal = [];
    const kind = panel(journal);
    const tree = yield* useReplTree<Act>();
    const handoff = yield* useReplHandoff<Act>((descriptions) => tree.apply(descriptions));

    const first = yield* handoff.next([child(kind, "one", "a")]);
    expect(first.ok).toBe(true);
    expect(cells(tree)).toEqual(["[a]"]);

    const second = yield* handoff.next([child(kind, "one", "a"), child(kind, "two", "b")]);
    expect(second.ok).toBe(true);
    expect(cells(tree)).toEqual(["[a]", "[b]"]);

    const bad = yield* handoff.next([child(kind, "dup", "x"), child(kind, "dup", "y")]);
    expect(bad.ok).toBe(false);
    expect(cells(tree)).toEqual(["[a]", "[b]"]);
  });

  it("C1: validation reads the whole set, including descendants", function* () {
    const journal: Journal = [];
    const kind = panel(journal);

    const deep = validateDescriptions([
      child(kind, "one", "a", [child(kind, "same", "x"), child(kind, "same", "y")]),
    ]);

    expect(deep.ok).toBe(false);
    expect(deep.ok === false && deep.error.message).toContain("two children keyed same");
  });
});

describe("REPL composition: a description is issued, not written", () => {
  it("C1: what the caller keeps mutating is not what the tree holds", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    const mutable = { label: "first", nested: { deep: "original" } };

    const description = describeNode<Act>({
      key: "one",
      component: panel(journal),
      input: mutable,
    });

    // Changed after describing, and again while the description is in hand.
    mutable.label = "changed";
    mutable.nested.deep = "changed";
    committed(yield* tree.apply([description]));

    expect(cells(tree)).toEqual(["[first]"]);
    // And the caller's own object was not frozen out from under it.
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.nested)).toBe(false);
    mutable.label = "changed again";
    expect(cells(tree)).toEqual(["[first]"]);
  });

  it("C1: a description mutated while its offer waits cannot change the tree", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    const handoff = yield* useReplHandoff<Act>((descriptions) => tree.apply(descriptions));
    const mutable = { label: "offered" };
    const description = describeNode<Act>({
      key: "one",
      component: panel(journal),
      input: mutable,
    });

    const offer = yield* spawn(() => handoff.next([description]));
    mutable.label = "swapped";
    yield* offer;

    expect(cells(tree)).toEqual(["[offered]"]);
  });

  it("C1: a plain object shaped like a description is refused", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    const real = child(panel(journal), "real", "a");
    committed(yield* tree.apply([real]));
    const mounted = tree.mounted();

    // Everything a description appears to have, and none of what one is.
    const forged = {
      key: "forged",
      component: panel(journal),
      input: { label: "x" },
      placement: {},
      children: [],
      modal: false,
      focus: false,
    };
    // Validation takes what a caller actually has, so a forged member reaches
    // the production parser and is refused by it rather than by a type.
    const smuggled: readonly unknown[] = [real, forged];
    expect(refused(validateDescriptions(smuggled)).message).toContain(
      "not a description this tree",
    );
    expect(validateDescriptions([real]).ok).toBe(true);
    expect(tree.mounted()).toEqual(mounted);
  });

  it("C1: an issued handle cannot be shadowed into meaning something else", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    const Panel = panel(journal);
    const description = child(Panel, "one", "a");

    // Both attempts a holder could make on the handle: replace what the tree
    // reads, and replace what it runs.
    expect(() =>
      Object.defineProperty(description, "input", { value: { label: "swapped" } }),
    ).toThrow();
    expect(() => Object.defineProperty(Panel, "attach", { value: () => undefined })).toThrow();
    expect(() =>
      Object.defineProperty(Object.getPrototypeOf(Panel), "attach", { value: 1 }),
    ).toThrow();

    committed(yield* tree.apply([description]));
    expect(cells(tree)).toEqual(["[a]"]);
    expect(journal).toContain("mount:one");
  });

  it("C1: the records behind a handle are frozen, all the way down", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    const Panel = panel(journal);
    const description = child(Panel, "one", "a", [child(Panel, "child", "b")]);

    // Read through the seam the reconciler reads through, because that is the
    // one place the backing records are reachable at all.
    const described = readDescription(description);
    const definition = readComponent(Panel);

    // Every record and list the handles retain, walked.
    for (const retained of reachableFrom([described, definition])) {
      expect(Object.isFrozen(retained)).toBe(true);
    }
    expect(Object.isFrozen(described)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);

    // Mutation is refused rather than quietly accepted. `Reflect.set` reports
    // false on a frozen target; a bare assignment throws in strict mode.
    let ran = false;
    const replacement = (node: ReplNode<Act>): void => {
      ran = true;
      node.render("replaced");
    };
    expect(Reflect.set(definition, "attach", replacement)).toBe(false);
    expect(Reflect.set(described, "input", { label: "swapped" })).toBe(false);
    expect(Reflect.set(described, "component", Panel)).toBe(false);
    expect(Reflect.defineProperty(definition, "attach", { value: replacement })).toBe(false);

    // And the already-issued description still mounts the original input and
    // runs the original behavior, which is what the freezes were protecting.
    committed(yield* tree.apply([description]));
    expect(ran).toBe(false);
    expect(cells(tree)).toEqual(["[a]", "[b]"]);
    expect(readComponent(Panel).attach).not.toBe(replacement);
    expect(readDescription(description).input).toEqual({ label: "a" });
  });

  it("C1: a factory-shaped component is refused before anything attaches", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    let ran = false;

    // Everything a component appears to have, issued by nobody.
    const forged = {
      name: "forged",
      runs: false,
      attach(node: ReplNode<Act>): void {
        ran = true;
        node.render("forged");
      },
      lifetime: undefined,
    };

    // Through a runtime-untyped call, which is the only way it could arrive.
    expect(() =>
      Reflect.apply(describeNode, undefined, [
        { key: "one", component: forged, input: { label: "a" } },
      ]),
    ).toThrow();
    expect(ran).toBe(false);
    expect(tree.mounted()).toEqual([]);

    // And the reader the reconciler goes through refuses it too, so there is
    // no second route from a look-alike to a mounted node.
    expect(() => readComponent(Reflect.apply(Object, undefined, [forged]))).toThrow();
    expect(ran).toBe(false);
  });

  it("C1: only view data crosses into a description", function* () {
    // The static type already forbids a function or an instance at
    // `describe()`. This is the other half: a value that reached the parser
    // through `unknown` is refused rather than carried into the tree.
    const smuggled: unknown = { label: "a", when: new Date() };
    expect(() => detach(smuggled)).toThrow();
    expect(() => detach({ act: () => "no" })).toThrow();

    // And ordinary view data is copied rather than referenced.
    const original = { label: "a", nested: { deep: [1, 2] } };
    const copy = detach(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });
});

describe("REPL composition: the vendored snapshot", () => {
  const VENDOR = fileURLToPath(new URL("../src/repl/vendor/freedom/", import.meta.url));

  function* digest(path: string): Operation<string> {
    const bytes = yield* until(readFile(join(VENDOR, path)));
    const hashed = yield* until(crypto.subtle.digest("SHA-256", bytes));
    return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function* present(directory = ""): Operation<string[]> {
    const found: string[] = [];
    for (const entry of yield* until(readdir(join(VENDOR, directory), { withFileTypes: true }))) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...(yield* present(path)));
      } else {
        found.push(path);
      }
    }
    return found.sort();
  }

  function* manifest(): Operation<VendorManifest> {
    const bytes = yield* until(readFile(join(VENDOR, "MANIFEST.json")));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  it("C2: the manifest is an exact inventory of what is vendored", function* () {
    const recorded = yield* manifest();
    expect(recorded.commit).toBe("8be97e7201cd6effddb2f8b240b4b5166641e7f0");
    expect(recorded.repository).toBe("https://github.com/bombshell-dev/playground");
    expect(recorded.license.upstreamRepository).toBe("MIT");
    expect(recorded.license.packageMetadata).toBe("ISC");

    const expected = new Set<string>(["MANIFEST.json"]);
    for (const entry of recorded.files) {
      expected.add(entry.kind === "source" ? `upstream/${entry.path}` : entry.path);
      if (entry.kind === "source") {
        expected.add(`patched/${entry.path}`);
      }
    }

    expect(yield* present()).toEqual([...expected].sort());
  });

  it("C2: every vendored byte is the byte the manifest recorded", function* () {
    const recorded = yield* manifest();

    for (const entry of recorded.files) {
      if (entry.kind !== "source") {
        expect(yield* digest(entry.path)).toBe(entry.sha256);
        continue;
      }
      expect(yield* digest(`upstream/${entry.path}`)).toBe(entry.upstream);
      expect(yield* digest(`patched/${entry.path}`)).toBe(entry.patched);
    }
  });

  it("C2: the provenance states both licence declarations and settles neither", function* () {
    const bytes = yield* until(readFile(join(VENDOR, "PROVENANCE.md")));
    const provenance = new TextDecoder().decode(bytes);

    expect(provenance).toContain("MIT notice");
    expect(provenance).toContain('"license": "ISC"');
    expect(provenance).toContain("makes no determination");
    // The conclusion this must not draw.
    expect(provenance).not.toContain("governed by");
  });

  it("C2: every production difference from upstream belongs to one named patch", function* () {
    const recorded = yield* manifest();
    const named = new Map<string, string>();
    for (const patch of recorded.patches) {
      for (const path of patch.files) {
        named.set(path, patch.name);
      }
    }

    const differing: string[] = [];
    for (const entry of recorded.files) {
      if (entry.kind !== "source") {
        continue;
      }
      if (entry.upstream === entry.patched) {
        expect(named.has(entry.path)).toBe(false);
        expect(entry.patch).toBe(undefined);
        continue;
      }
      differing.push(entry.path);
      expect(entry.patch).toBe(named.get(entry.path));
    }

    expect(differing.sort()).toEqual(["lib/focus.ts", "lib/mod.ts", "lib/node.ts", "lib/root.ts"]);
    expect(recorded.patches.map((patch) => patch.name).sort()).toEqual([
      "executablemd/caller-owned-root",
      "executablemd/containment-aware-removal",
    ]);
  });

  it("C2: production imports the patched copy and never the pristine one", function* () {
    const sources = fileURLToPath(new URL("../src/repl/", import.meta.url));
    const importing: string[] = [];
    for (const entry of yield* until(readdir(sources, { withFileTypes: true }))) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const text = new TextDecoder().decode(yield* until(readFile(join(sources, entry.name))));
      expect(text).not.toContain("vendor/freedom/upstream");
      if (text.includes("vendor/freedom/patched")) {
        importing.push(entry.name);
      }
    }

    expect(importing).toEqual(["reconcile.ts"]);
  });
});

describe("REPL composition: what the two patches change", () => {
  const Ambient = createContext<string>("executablemd.repl.test-ambient");

  it("C2: a patched root belongs to its caller, and pristine has no such surface", function* () {
    let insideOwned: string | undefined;
    let destroyed = false;

    yield* spawn(function* () {
      yield* Ambient.set("from the caller");
      const root = yield* patched.useRoot();
      insideOwned = root.node.scope.get(Ambient);
      root.node.scope.run(function* () {
        try {
          yield* sleep(60_000);
        } finally {
          destroyed = true;
        }
      });
      yield* sleep(1);
    });
    yield* sleep(5);

    expect(insideOwned).toBe("from the caller");
    expect(destroyed).toBe(true);
  });

  it("C2: pristine upstream fails the ownership control", function* () {
    expect("useRoot" in upstream).toBe(false);
    expect("useRoot" in patched).toBe(true);

    let root: Root | undefined;
    yield* ensure(function* () {
      if (root !== undefined) {
        yield* until(root.destroy());
      }
    });
    yield* Ambient.set("from the caller");
    root = upstream.createRoot();

    expect(root.node.scope.get(Ambient)).toBe(undefined);
  });

  it("C2: removing the branch above the focused control moves focus to a survivor", function* () {
    let root: Root | undefined;
    yield* ensure(function* () {
      if (root !== undefined) {
        yield* until(root.destroy());
      }
    });
    root = patched.createRoot();
    const drawerNode = root.node.createChild("drawer");
    const controlNode = drawerNode.createChild("control");
    const survivor = root.node.createChild("survivor");
    patched.focusable(controlNode);
    patched.focusable(survivor);
    patched.useFocus(root.node);
    patched.focus(controlNode);
    expect(patched.current(root.node)).toBe(controlNode);

    yield* until(drawerNode.remove());

    expect(patched.current(root.node)).toBe(survivor);
    expect(survivor.props.focused).toBe(true);
  });

  it("C2: pristine upstream fails the containment control", function* () {
    let root: Root | undefined;
    yield* ensure(function* () {
      if (root !== undefined) {
        yield* until(root.destroy());
      }
    });
    root = upstream.createRoot();
    const drawerNode = root.node.createChild("drawer");
    const controlNode = drawerNode.createChild("control");
    const survivor = root.node.createChild("survivor");
    upstream.focusable(controlNode);
    upstream.focusable(survivor);
    upstream.useFocus(root.node);
    upstream.focus(controlNode);

    yield* until(drawerNode.remove());

    expect(upstream.current(root.node)).not.toBe(survivor);
    expect(survivor.props.focused).toBe(false);
  });

  it("C2: the patched sources run on this repository's stable Effection", function* () {
    const root = yield* patched.useRoot();
    const probe = root.node.createChild("probe");
    patched.focusable(probe);
    patched.useFocus(root.node);

    expect(patched.current(root.node)).toBe(probe);
  });
});

describe("REPL composition: where a normalized event goes", () => {
  it("I1: a key and a click on the same control mean the same thing", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    committed(
      yield* tree.apply([
        child(group(journal), "form", "outer", [child(control(journal), "field", "inner")]),
      ]),
    );

    const target = tree.focused();
    if (target === undefined) {
      throw new Error("a focusable control is mounted");
    }

    const keyed = acted(yield* tree.dispatch({ kind: "key", key: "Enter" }));
    const clicked = acted(
      yield* tree.dispatch({ kind: "pointer", target, frame: tree.frame().id }),
    );
    if (keyed.outcome !== "action" || clicked.outcome !== "action") {
      throw new Error("both activations produce an action");
    }

    expect(keyed.action).toEqual({ kind: "submit", from: "form" });
    expect(clicked.action).toEqual(keyed.action);
    expect(keyed.ancestry).toEqual(clicked.ancestry);
    expect(keyed.ancestry).toHaveLength(2);
    expect(keyed.ancestry[0]).toBe(target);
  });

  it("I1: the host names a target and an event shape, never an action", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    committed(
      yield* tree.apply([
        child(group(journal), "form", "outer", [child(control(journal), "field", "inner")]),
      ]),
    );
    const target = tree.focused();
    if (target === undefined) {
      throw new Error("a focusable control is mounted");
    }

    const event: ReplInputEvent = { kind: "pointer", target, frame: tree.frame().id };
    const result = acted(yield* tree.dispatch(event));

    expect(result.outcome === "action" && result.action.kind).toBe("submit");
    expect(Object.values(event).map(String)).not.toContain("submit");
    expect(Object.keys(event).sort()).toEqual(["frame", "kind", "target"]);
  });

  it("I1: Backtab arrives through dispatch, like every other event", function* () {
    const journal: Journal = [];
    const leaf = control(journal);
    const tree = yield* useReplTree<Act>();
    committed(
      yield* tree.apply([
        child(group(journal), "form", "outer", [
          child(leaf, "one", "a"),
          child(leaf, "two", "b"),
          child(leaf, "three", "c"),
        ]),
      ]),
    );

    const first = tree.focused();
    const back = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
    const again = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));

    // A focus move is its own outcome, not an action a component invented.
    expect(back.outcome).toBe("focus");
    expect(back.outcome === "focus" && back.focused).not.toBe(first);
    expect(tree.keyOf(back.outcome === "focus" ? (back.focused ?? "") : "")).toBe("three");
    expect(tree.keyOf(again.outcome === "focus" ? (again.focused ?? "") : "")).toBe("two");
  });

  it("I1: Escape closes the drawer and answers nothing", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    committed(
      yield* tree.apply([
        child(
          drawer(journal),
          "modal",
          "question",
          [child(control(journal), "choice", "approve")],
          {
            modal: true,
          },
        ),
      ]),
    );

    const result = acted(yield* tree.dispatch({ kind: "key", key: "Escape" }));

    expect(result.outcome === "action" && result.action).toEqual({
      kind: "close-drawer",
      from: "modal",
    });
  });

  it("I1: a pointer from an obsolete frame or a removed node is dropped", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    committed(
      yield* tree.apply([
        child(group(journal), "form", "outer", [child(control(journal), "field", "inner")]),
      ]),
    );
    const target = tree.focused();
    const stale = tree.frame().id;

    committed(
      yield* tree.apply([
        child(group(journal), "form", "outer", [child(control(journal), "other", "later")]),
      ]),
    );

    const live = tree.focused();
    if (target === undefined || live === undefined) {
      throw new Error("both trees hold a focusable control");
    }
    const obsolete = acted(yield* tree.dispatch({ kind: "pointer", target: live, frame: stale }));
    const gone = acted(yield* tree.dispatch({ kind: "pointer", target, frame: tree.frame().id }));

    expect(obsolete.outcome === "dropped" && obsolete.reason).toContain("no longer drawn");
    expect(gone.outcome === "dropped" && gone.reason).toContain("no longer holds");
  });

  it("I1: an event nothing claims is an explicit failure, not a silence", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply([child(control(journal), "lonely", "a")]));

    const unowned = yield* tree.dispatch({ kind: "key", key: "Enter" });

    expect(unowned.ok).toBe(false);
    expect(unowned.ok === false && unowned.error.name).toBe("ReplUnownedEventError");
  });
});

describe("REPL composition: a modal branch owns focus while it is mounted", () => {
  function scene(journal: Journal, modal: boolean): readonly ReplDescription<Act>[] {
    const leaf = control(journal);
    return [
      child(group(journal), "page", "under", [child(leaf, "beneath", "x")]),
      child(
        drawer(journal),
        "modal",
        "question",
        [child(leaf, "approve", "approve"), child(leaf, "decline", "decline")],
        modal ? { modal: true } : {},
      ),
    ];
  }

  it("C2: a mounted modal traps focus, and popping it restores the prior one", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();

    committed(
      yield* tree.apply([
        child(group(journal), "page", "under", [child(control(journal), "beneath", "x")]),
      ]),
    );
    const beneath = tree.focused();
    expect(tree.keyOf(beneath ?? "")).toBe("beneath");

    committed(yield* tree.apply(scene(journal, true)));

    // Focus is seeded inside the modal, and cycling stays inside it however
    // many times it is asked to move.
    const reached = new Set<string | undefined>();
    for (let step = 0; step < 6; step++) {
      const moved = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
      reached.add(tree.keyOf(moved.outcome === "focus" ? (moved.focused ?? "") : ""));
    }
    expect([...reached].sort()).toEqual(["approve", "decline"]);
    expect(reached.has("beneath")).toBe(false);

    // Removing the modal pops its focus root and hands focus back.
    committed(
      yield* tree.apply([
        child(group(journal), "page", "under", [child(control(journal), "beneath", "x")]),
      ]),
    );

    expect(tree.keyOf(tree.focused() ?? "")).toBe("beneath");
    // And no stale entry is left behind: cycling now reaches the page again.
    const after = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
    expect(after.outcome).toBe("focus");
    expect(tree.keyOf(after.outcome === "focus" ? (after.focused ?? "") : "")).toBe("beneath");
  });

  it("C2: the same branch without the modal push does not trap focus", function* () {
    const journal: Journal = [];
    const tree = yield* useReplTree<Act>();

    // The control for the clause above. Identical descriptions, no push, and
    // cycling walks straight out of the drawer into the tree underneath.
    committed(yield* tree.apply(scene(journal, false)));

    const reached = new Set<string | undefined>();
    for (let step = 0; step < 6; step++) {
      const moved = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
      reached.add(tree.keyOf(moved.outcome === "focus" ? (moved.focused ?? "") : ""));
    }

    expect(reached.has("beneath")).toBe(true);
  });
});

describe("REPL composition: cancellation owns an uncommitted offer", () => {
  /**
   * A component whose teardown waits for this test.
   *
   * It is what puts a real commit into its suspended state: the branch is
   * retired synchronously, and the tree then waits for the scope to finish
   * unwinding, which is where a cancellation actually lands in production.
   */
  function blocking(journal: Journal, gate: Promise<void>): ReplComponent<Act> {
    return component<Act>({
      name: "blocking",
      attach(node: ReplNode<Act>): () => void {
        journal.push(`mount:${node.key}`);
        node.render(`*${label(node.input)}*`);
        return () => journal.push(`unmount:${node.key}`);
      },
      *lifetime(): Operation<void> {
        yield* ensure(() => until(gate));
        yield* suspend();
      },
    });
  }

  it("C1: cancelling an offer suspended in the real commit path mounts nothing", function* () {
    const journal: Journal = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tree = yield* useReplTree<Act>();
    const handoff = yield* useReplHandoff<Act>((descriptions) => tree.apply(descriptions));
    const Held = blocking(journal, gate);
    const Panel = panel(journal);

    committed(yield* tree.apply([child(Held, "held", "a")]));
    yield* sleep(2);

    // This commit prepares synchronously and then suspends in its own
    // retirement, waiting for the blocked teardown.
    const first = yield* spawn(() => handoff.next([child(Panel, "after", "b")]));
    yield* sleep(2);
    expect(cells(tree)).toEqual(["[b]"]);
    const committedShape = tree.mounted();

    // A second offer reaches the real path and suspends on the outstanding
    // retirement, before it has touched anything. Cancelling it there is the
    // case a flag flipped before the commit began cannot account for.
    const second = yield* spawn(() => handoff.next([child(Panel, "abandoned", "c")]));
    yield* sleep(2);
    yield* second.halt();
    yield* sleep(2);

    expect(journal).not.toContain("mount:abandoned");
    expect(tree.mounted()).toEqual(committedShape);
    expect(cells(tree)).toEqual(["[b]"]);

    // Releasing settles the outstanding teardown, and the first offer — whose
    // commit the cancellation never disturbed — completes.
    release();
    expect((yield* first).ok).toBe(true);
    expect(journal).toContain("unmount:held");
    expect(journal).not.toContain("mount:abandoned");

    // And nothing was left pending: a later offer runs immediately.
    const third = yield* handoff.next([child(Panel, "later", "d")]);
    expect(third.ok).toBe(true);
    expect(cells(tree)).toEqual(["[d]"]);
  });

  it("C1: cancelling the holder cannot release a concurrent commit", function* () {
    const journal: Journal = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tree = yield* useReplTree<Act>();
    const handoff = yield* useReplHandoff<Act>((descriptions) => tree.apply(descriptions));
    const Held = blocking(journal, gate);
    const Panel = panel(journal);

    committed(yield* tree.apply([child(Held, "held", "a")]));
    yield* sleep(2);

    // The holder is cancelled while its own retirement is still outstanding.
    const holder = yield* spawn(() => handoff.next([child(Panel, "after", "b")]));
    yield* sleep(2);
    yield* holder.halt();

    // The next offer does not overlap it: the retirement the cancelled holder
    // started is still the tree's, and the next commit waits for it.
    const next = yield* spawn(() => handoff.next([child(Panel, "later", "d")]));
    yield* sleep(4);
    expect(journal).not.toContain("mount:later");

    release();
    expect((yield* next).ok).toBe(true);
    expect(journal).toContain("unmount:held");
    expect(cells(tree)).toEqual(["[d]"]);
  });
});

describe("REPL composition: the construction surface", () => {
  it("C1: the only public construction is describe() and component()", function* () {
    // The discriminator for the opacity claim. An alternate issuer, a reader
    // that unwraps an arbitrary value, or an exported definition reader would
    // each make the classes forgeable again, and each would show up here.
    expect(Object.keys(composition).sort()).toEqual([
      "ReplDescriptionError",
      "component",
      "describe",
      "detach",
      "fields",
      "readComponent",
      "readDescription",
      "validateDescriptions",
    ]);

    // The classes themselves are types, not values: there is no constructor
    // to reach and no static to call.
    const surface: Record<string, unknown> = composition;
    expect(surface["ReplDescription"]).toBe(undefined);
    expect(surface["ReplComponent"]).toBe(undefined);

    // The two readers are the composition implementation's seam, and each one
    // refuses anything it did not issue rather than unwrapping it.
    expect(() => readDescription(Reflect.apply(Object, undefined, [{ key: "x" }]))).toThrow();
    expect(() => readComponent(Reflect.apply(Object, undefined, [{ name: "x" }]))).toThrow();
  });

  it("C1: an issued handle shows nothing and cannot be changed", function* () {
    const journal: Journal = [];
    const Panel = panel(journal);
    const description = child(Panel, "one", "a");

    // Nothing to read: a private field is invisible to property access, to
    // enumeration and to reflection.
    for (const handle of [description, Panel]) {
      expect(Object.keys(handle)).toEqual([]);
      expect(Object.getOwnPropertyNames(handle)).toEqual([]);
      expect(Object.getOwnPropertySymbols(handle)).toEqual([]);
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(handle)).sort()).toEqual([
        "constructor",
      ]);
      // And nothing to change: frozen on the way out, prototype included.
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.isFrozen(Object.getPrototypeOf(handle))).toBe(true);
    }

    // What it says is still exactly what it was told, read through the seam.
    expect(readDescription(description).key).toBe("one");
    expect(readDescription(description).input).toEqual({ label: "a" });
  });
});

describe("REPL composition: a modal stack", () => {
  // One identity per kind, shared across every description in a test: a fresh
  // component object is a different kind of child, and would replace the node
  // rather than preserve it.
  const journal: Journal = [];
  const Page = group(journal);
  const Leaf = control(journal);
  const Drawer = drawer(journal);

  function page(modals: readonly ReplDescription<Act>[]) {
    return [child(Page, "page", "under", [child(Leaf, "beneath", "x")]), ...modals];
  }

  function outer(nested: readonly ReplDescription<Act>[], modal: boolean) {
    return child(
      Drawer,
      "outer",
      "first",
      [child(Leaf, "outer-choice", "a"), ...nested],
      modal ? { modal: true } : {},
    );
  }

  function inner() {
    return child(Drawer, "inner", "second", [child(Leaf, "inner-choice", "b")], { modal: true });
  }

  /** Where Backtab can reach from here, as keys. */
  function* reachable(tree: ReplTree<Act>): Operation<string[]> {
    const seen = new Set<string>();
    for (let step = 0; step < 8; step++) {
      const moved = acted(yield* tree.dispatch({ kind: "key", key: "Backtab" }));
      const key = tree.keyOf(moved.outcome === "focus" ? (moved.focused ?? "") : "");
      if (key !== undefined) {
        seen.add(key);
      }
    }
    return [...seen].sort();
  }

  it("C2: a current-frame pointer cannot reach the page behind an open drawer", function* () {
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply(page([])));
    const beneath = tree.focused();
    if (beneath === undefined) {
      throw new Error("the page holds a focusable control");
    }

    committed(yield* tree.apply(page([outer([], true)])));

    // Same frame, live node, and still unreachable: the modal root is what
    // makes the branch underneath inaccessible rather than merely covered.
    const behind = acted(
      yield* tree.dispatch({ kind: "pointer", target: beneath, frame: tree.frame().id }),
    );
    expect(behind.outcome === "dropped" && behind.reason).toContain("behind the open drawer");

    // And the drawer's own controls are reachable in the same frame.
    const inside = tree.focused();
    if (inside === undefined) {
      throw new Error("the drawer seeds focus inside itself");
    }
    const hit = acted(
      yield* tree.dispatch({ kind: "pointer", target: inside, frame: tree.frame().id }),
    );
    expect(hit.outcome).toBe("action");
  });

  it("C2: a nested stack pushes outer first and pops inner first", function* () {
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply(page([])));
    committed(yield* tree.apply(page([outer([inner()], true)])));

    // Innermost wins: Backtab stays inside the inner drawer.
    expect(yield* reachable(tree)).toEqual(["inner-choice"]);

    // Removing the inner drawer restores the outer one.
    committed(yield* tree.apply(page([outer([], true)])));
    expect(yield* reachable(tree)).toEqual(["outer-choice"]);

    // Removing the outer restores the page.
    committed(yield* tree.apply(page([])));
    expect(yield* reachable(tree)).toEqual(["beneath"]);

    // No stale entry: the page is reachable by pointer again.
    const beneath = tree.focused();
    if (beneath === undefined) {
      throw new Error("the page holds focus again");
    }
    const hit = acted(
      yield* tree.dispatch({ kind: "pointer", target: beneath, frame: tree.frame().id }),
    );
    expect(hit.outcome).toBe("action");
  });

  it("C2: removing an outer drawer pops the stack above it, innermost first", function* () {
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply(page([])));
    committed(yield* tree.apply(page([outer([inner()], true)])));
    expect(yield* reachable(tree)).toEqual(["inner-choice"]);

    // Both at once: the outer root goes while the inner one is still pushed,
    // so the stack has to unwind from the top rather than from the entry that
    // happened to be removed.
    committed(yield* tree.apply(page([])));

    expect(yield* reachable(tree)).toEqual(["beneath"]);
    const beneath = tree.focused();
    if (beneath === undefined) {
      throw new Error("the page holds focus again");
    }
    const hit = acted(
      yield* tree.dispatch({ kind: "pointer", target: beneath, frame: tree.frame().id }),
    );
    expect(hit.outcome).toBe("action");
  });

  it("C2: a preserved node whose modal intent changes pushes or pops in place", function* () {
    const tree = yield* useReplTree<Act>();

    committed(yield* tree.apply(page([outer([], false)])));
    const before = tree.mounted();
    expect(yield* reachable(tree)).toEqual(["beneath", "outer-choice"]);
    journal.length = 0;

    // Same key, same component, modal now: it pushes without being rebuilt.
    committed(yield* tree.apply(page([outer([], true)])));
    expect(tree.mounted()).toEqual(before);
    expect(journal.filter((entry) => entry.startsWith("unmount:"))).toEqual([]);
    expect(yield* reachable(tree)).toEqual(["outer-choice"]);

    // And back again: it pops, still without being rebuilt.
    committed(yield* tree.apply(page([outer([], false)])));
    expect(tree.mounted()).toEqual(before);
    expect(journal.filter((entry) => entry.startsWith("unmount:"))).toEqual([]);
    expect(yield* reachable(tree)).toEqual(["beneath", "outer-choice"]);
  });

  it("C2: a focus claim beside a modal is refused before anything mounts", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page([])));
    const before = tree.mounted();
    const drawn = cells(tree);

    // The page is mounted, the drawer would open over it, and the page also
    // asks for focus. Freedom would refuse that the moment it was asked — by
    // which time the whole new tree is already attached — so it is refused
    // here instead.
    const refusal = refused(
      yield* tree.apply([
        child(Page, "page", "under", [child(Leaf, "beneath", "x", [], { focus: true })]),
        outer([], true),
      ]),
    );

    expect(refusal.message).toContain("does not contain it");
    expect(tree.mounted()).toEqual(before);
    expect(cells(tree)).toEqual(drawn);
  });

  it("C2: a focus claim in an outer modal but outside the inner one is refused", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page([])));
    const before = tree.mounted();
    const drawn = cells(tree);

    // Inside a modal is not enough: the innermost one is what is open.
    const refusal = refused(
      yield* tree.apply([
        child(Page, "page", "under", [child(Leaf, "beneath", "x")]),
        child(
          Drawer,
          "outer",
          "first",
          [child(Leaf, "outer-choice", "a", [], { focus: true }), inner()],
          { modal: true },
        ),
      ]),
    );

    expect(refusal.message).toContain("does not contain it");
    expect(tree.mounted()).toEqual(before);
    expect(cells(tree)).toEqual(drawn);
  });

  it("C2: a focus claim inside the innermost modal is admitted", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page([])));

    // The positive control: the rule refuses a claim the open modal does not
    // contain, and admits the one it does.
    committed(
      yield* tree.apply([
        child(Page, "page", "under", [child(Leaf, "beneath", "x")]),
        child(
          Drawer,
          "outer",
          "first",
          [
            child(Leaf, "outer-choice", "a"),
            child(
              Drawer,
              "inner",
              "second",
              [child(Leaf, "inner-choice", "b", [], { focus: true })],
              { modal: true },
            ),
          ],
          { modal: true },
        ),
      ]),
    );

    expect(tree.keyOf(tree.focused() ?? "")).toBe("inner-choice");
  });

  it("C2: two modal roots on disjoint branches are refused before anything mounts", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page([])));
    const before = tree.mounted();

    const conflicting = refused(
      yield* tree.apply([
        child(Drawer, "left", "a", [], { modal: true }),
        child(Drawer, "right", "b", [], { modal: true }),
      ]),
    );

    expect(conflicting.message).toContain("neither contains the other");
    expect(tree.mounted()).toEqual(before);
  });
});
