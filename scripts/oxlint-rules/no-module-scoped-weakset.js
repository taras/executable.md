/**
 * `local/no-module-scoped-weakset` — a registry that outlives every run.
 *
 * A `WeakSet` created at module scope is one table shared by every execution the
 * process performs, keyed by whatever objects happen to reach it. It survives
 * the run that filled it, so state written during one document is still there
 * for the next, and nothing in a caller's scope can see it, override it, or
 * clear it. That is the shape of a global, and it forfeits the scope-local
 * inheritance the rest of the engine is built on.
 *
 * What the shape is usually reaching for is a mark on an object, which belongs
 * on that object:
 *
 *     const CAPTURED = Symbol.for("executablemd.captured");
 *     Object.defineProperty(segment, CAPTURED, { value: true });
 *
 * A `WeakSet` whose lifetime is a function call or an operation is fine — it is
 * created and discarded with the work it describes, so this reports only the
 * module-scoped ones, including exported and lazily-assigned declarations.
 */
const LIFETIME = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassBody",
  "StaticBlock",
]);

function isWeakSetConstruction(node) {
  return (
    node !== null &&
    node !== undefined &&
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "WeakSet"
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
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (LIFETIME.has(parent.type)) {
      return false;
    }

    if (parent.type === "Program") {
      return true;
    }
  }

  return false;
}

export const noModuleScopedWeakSet = {
  meta: {
    type: "problem",
    messages: {
      moduleScoped:
        "A module-scoped WeakSet is a process-lifetime registry shared by every run. Mark the object itself, or create the set inside the lifetime it describes.",
    },
  },

  create(context) {
    return {
      NewExpression(node) {
        if (!isWeakSetConstruction(node) || !atModuleScope(node)) {
          return;
        }

        context.report({ node, messageId: "moduleScoped" });
      },
    };
  },
};
