/**
 * `local/no-module-scoped-registry` — state that outlives every run.
 *
 * A `Map`, `Set`, `WeakMap`, or `WeakSet` created at module scope is one table
 * shared by every execution the process performs, keyed by whatever happens to
 * reach it. It survives the run that filled it, so what one document decided is
 * still answering questions during the next, and nothing in a caller's scope can
 * see it, override it, or clear it. That is a global, and it forfeits the
 * scope-local inheritance the rest of the engine is built on.
 *
 * State belongs to the operation that owns it: create the table inside that
 * operation and hand it down through context, so it is reclaimed when the scope
 * that made it ends.
 *
 *     export function* useDiagnostics() {
 *       const diagnostics = { captured: new WeakSet(), causes: new WeakMap() };
 *       yield* RunDiagnostics.set(diagnostics);
 *       return diagnostics;
 *     }
 *
 * Moving the state onto the objects it describes — a symbol brand on each one —
 * is not the answer either: it is the same lifetime, spread across more places,
 * and a `Symbol.for` key is itself a process-global anyone can forge.
 *
 * A table whose lifetime is a function call or an operation is fine, so this
 * reports only the module-scoped ones: declared, exported, assigned later, held
 * inside another module-scoped value, or standing in a class body — a class at
 * module scope holds its fields for the life of the module.
 *
 * Three shapes are not that. A table built from its own contents is a constant
 * rather than a registry — `new Set(["Content", "Output"])` answers the same
 * question forever. An instance field belongs to its object's lifetime, not the
 * module's. And a table handed straight to a call — a context's empty default —
 * is one the module keeps no handle on, so nothing here can accumulate into it.
 *
 * The one shape that is not run state is metadata an author declares about a
 * definition at module evaluation, outside any operation — `captureErrors(fn)`
 * marking a component function. That belongs on the definition, and a
 * module-private `Symbol()` is how it is written.
 */
// A class body is not a lifetime: a class declared at module scope holds its
// fields for the life of the module, which is exactly the shape this reports.
const LIFETIME = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];

/** Where a module keeps a handle on what it built. */
const MODULE_BINDING = ["VariableDeclarator", "AssignmentExpression"];

const REGISTRIES = ["Map", "Set", "WeakMap", "WeakSet"];

/**
 * An empty table is one something intends to fill: a registry. A table built
 * from its contents is a constant — a set of reserved names, a lookup of
 * handlers — and answers the same question for the life of the program because
 * nothing ever writes to it.
 */
function isRegistryConstruction(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    REGISTRIES.includes(node.callee.name) &&
    (node.arguments === undefined || node.arguments.length === 0)
  );
}

/**
 * Whether nothing between this node and the module body opens a new lifetime.
 *
 * The walk is upward and asks only that one question, so it covers every way a
 * module-lifetime table is written: a declaration, an export, an assignment made
 * later, and one held inside another module-scoped value.
 */
function atModuleScope(node) {
  let bound = false;

  for (let parent = node.parent; parent; parent = parent.parent) {
    if (LIFETIME.includes(parent.type)) {
      return false;
    }

    // An instance field is initialized per instance, so its table belongs to
    // that object's lifetime. A static one belongs to the module.
    if (parent.type === "PropertyDefinition") {
      if (!parent.static) {
        return false;
      }
      bound = true;
      continue;
    }

    if (MODULE_BINDING.includes(parent.type)) {
      bound = true;
      continue;
    }

    // Handed straight to a call — a context's empty default, a provider's
    // initial registry — and never bound here. The module holds no reference,
    // so nothing in it can accumulate into the table.
    if (parent.type === "CallExpression" || parent.type === "NewExpression") {
      return false;
    }

    if (parent.type === "Program") {
      return bound;
    }
  }

  return false;
}

export const noModuleScopedRegistry = {
  meta: {
    type: "problem",
    messages: {
      moduleScoped:
        "A module-scoped Map, Set, WeakMap, or WeakSet is a process-lifetime registry shared by every run. Create it inside the operation that owns it and provide it via context.",
    },
  },

  create(context) {
    return {
      NewExpression(node) {
        if (!isRegistryConstruction(node) || !atModuleScope(node)) {
          return;
        }

        context.report({ node, messageId: "moduleScoped" });
      },
    };
  },
};
