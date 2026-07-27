/**
 * `local/no-yield-in-finally` — cleanup that suspends while unwinding.
 *
 * A `finally` block runs while the operation is already on its way out.
 * Effection cannot guarantee that a suspension point there ever resumes: when
 * the enclosing operation is halted, the `yield*` meant to remove the
 * directory, close the socket, or kill the process may never come back, and
 * the resource the block was written to release stays behind. The shape reads
 * as guaranteed cleanup while guaranteeing nothing.
 *
 * Cleanup that must run belongs in an `ensure()` frame, registered before the
 * work it guards:
 *
 *     yield* ensure(() => rm(dir, { recursive: true, force: true }));
 *
 *     for (const [name, content] of Object.entries(files)) {
 *       yield* writeTextFile(path.join(dir, name), content);
 *     }
 *     return yield* body({ dir });
 *
 * `ensure()` attaches to the enclosing frame, and `yield*` delegation does not
 * give a generator a frame of its own — inside a reusable helper, cleanup
 * registered this way belongs to the caller and waits for the caller to
 * settle. Where the `finally` completed before the helper returned, wrap the
 * guarded lifetime in `scoped()` and register `ensure()` as its first
 * statement, so the boundary stays where it was.
 *
 * Which of the two rewrites preserves the resource's lifetime depends on the
 * surrounding code, so the rule reports without fixing.
 *
 * Only suspensions the enclosing generator performs are reported. A generator
 * declared inside a `finally` block suspends on its own behalf, wherever it is
 * later run.
 */
const BOUNDARY = new Set(["FunctionExpression", "FunctionDeclaration", "ClassBody"]);

function childNodes(node) {
  const children = [];

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }

    const value = node[key];

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") {
        children.push(child);
      }
    }
  }

  return children;
}

function collect(node, found) {
  if (node.type === "YieldExpression") {
    found.push(node);
  }

  for (const child of childNodes(node)) {
    if (BOUNDARY.has(child.type)) {
      continue;
    }

    // A nested `finally` is reported when that TryStatement is visited, so
    // descending into it here would report its suspensions twice. What the
    // nested `try` and `catch` suspend on still runs inside this finalizer.
    if (child.type === "TryStatement") {
      collect(child.block, found);

      if (child.handler) {
        collect(child.handler, found);
      }

      continue;
    }

    collect(child, found);
  }
}

export const noYieldInFinally = {
  meta: {
    type: "problem",
    messages: {
      suspended:
        "Cleanup that suspends in finally is not guaranteed to complete when the operation is halted. Register it with ensure() before the work it guards.",
    },
  },

  create(context) {
    return {
      TryStatement(node) {
        if (!node.finalizer) {
          return;
        }

        const found = [];
        collect(node.finalizer, found);

        for (const expression of found) {
          context.report({ node: expression, messageId: "suspended" });
        }
      },
    };
  },
};
