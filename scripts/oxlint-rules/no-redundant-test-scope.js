/**
 * `local/no-redundant-test-scope` — a scope that wraps a whole test body.
 *
 * The Effection BDD adapter runs each `it()` callback in its own scope and
 * destroys it when the test settles. A `scoped()` call around the entire
 * callback therefore opens a lifetime that begins and ends where the test's
 * own lifetime already begins and ends: it owns nothing the test scope would
 * not have owned, and destroys nothing sooner. What it does cost is clarity —
 * a reader has two candidate owners for the test's resources instead of one,
 * and the shape reads as though a test body needs a scope to be structured,
 * which is what makes these wrappers multiply.
 *
 * A scope earns its place when it covers one phase of a test, because then
 * its boundary is observable: the test can assert on what teardown did before
 * the test itself completes.
 *
 *     it("cleans up", function* () {
 *       let cleaned = false;
 *
 *       yield* scoped(function* () {
 *         yield* ensure(() => {
 *           cleaned = true;
 *         });
 *       });
 *
 *       expect(cleaned).toBe(true);
 *     });
 *
 * Only the outer wrapper of a nested pair is reported. Unwrapping it exposes
 * the inner one as a whole-body wrapper in turn, so repeated `oxlint --fix`
 * passes peel the whole stack without a second rule.
 */
const EFFECTION = new Set(["effection", "effection/experimental"]);

function isTestCall(node) {
  const { callee } = node;

  if (callee.type === "Identifier") {
    return callee.name === "it";
  }

  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "it" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "only";
}

function generatorCallback(node) {
  const last = node.arguments.at(-1);

  if (
    last &&
    last.type === "FunctionExpression" &&
    last.generator &&
    last.body.type === "BlockStatement"
  ) {
    return last;
  }

  return null;
}

function asCall(expression) {
  return expression.type === "CallExpression" ? expression : null;
}

function delegatedCall(expression) {
  if (expression.type === "YieldExpression" && expression.delegate && expression.argument) {
    return asCall(expression.argument);
  }

  return null;
}

/**
 * The whole executable body of a callback, when it is a single call whose
 * result is either discarded or returned. `delegated` distinguishes
 * `yield* scoped(...)`, which runs the scope, from `return scoped(...)`,
 * which hands the operation back to the caller.
 */
function wholeBodyCall(block) {
  if (block.body.length !== 1) {
    return null;
  }

  const [statement] = block.body;

  if (statement.type === "ExpressionStatement") {
    const call = delegatedCall(statement.expression);
    return call ? { statement, call, delegated: true } : null;
  }

  if (statement.type === "ReturnStatement" && statement.argument) {
    const delegated = delegatedCall(statement.argument);

    if (delegated) {
      return { statement, call: delegated, delegated: true };
    }

    const call = asCall(statement.argument);
    return call ? { statement, call, delegated: false } : null;
  }

  return null;
}

function bindsOwnThis(node) {
  return node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ClassExpression" ||
    node.type === "ClassDeclaration";
}

function usesEnclosingThis(node) {
  if (node.type === "ThisExpression") {
    return true;
  }

  if (node.type === "Identifier" && node.name === "arguments") {
    return true;
  }

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }

    const value = node[key];
    const children = Array.isArray(value) ? value : [value];

    for (const child of children) {
      if (
        child &&
        typeof child === "object" &&
        typeof child.type === "string" &&
        !bindsOwnThis(child) &&
        usesEnclosingThis(child)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Unwrapping preserves control flow only when the scope body is an inline
 * generator that takes nothing from its own function binding: no parameters,
 * no self-reference by name, and no `this`/`arguments`.
 */
function unwrappable(scope, delegated) {
  if (!delegated || scope.arguments.length !== 1) {
    return null;
  }

  const [operation] = scope.arguments;

  if (
    operation.type !== "FunctionExpression" ||
    !operation.generator ||
    operation.id ||
    operation.params.length > 0 ||
    operation.body.type !== "BlockStatement" ||
    usesEnclosingThis(operation.body)
  ) {
    return null;
  }

  return operation.body;
}

function indentOf(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const indent = text.slice(lineStart, offset);

  return /^\s*$/.test(indent) ? indent : "";
}

function unwrappedText(text, statement, block) {
  const inner = text.slice(block.range[0] + 1, block.range[1] - 1);
  const lines = inner.split("\n");

  if (lines.length === 1) {
    return inner.trim();
  }

  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }

  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }

  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const common = Math.min(...indents);
  const target = indentOf(text, statement.range[0]);

  // The replacement starts where the statement started, so the first line
  // inherits the indentation already in the file.
  return lines
    .map((line, index) => {
      if (line.trim() === "") {
        return "";
      }

      return index === 0 ? line.slice(common) : target + line.slice(common);
    })
    .join("\n");
}

export const noRedundantTestScope = {
  meta: {
    type: "problem",
    fixable: "code",
    messages: {
      redundant: "Remove the redundant scope: the it() callback already runs in its own scope.",
    },
  },

  create(context) {
    const names = new Set();
    const namespaces = new Set();
    const candidates = [];

    function isScoped(callee) {
      if (callee.type === "Identifier") {
        return names.has(callee.name);
      }

      return callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        callee.property.name === "scoped";
    }

    return {
      ImportDeclaration(node) {
        if (!EFFECTION.has(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "scoped") {
            names.add(specifier.local.name);
          }

          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          }
        }
      },

      CallExpression(node) {
        if (!isTestCall(node)) {
          return;
        }

        const callback = generatorCallback(node);
        const body = callback && wholeBodyCall(callback.body);

        if (body) {
          candidates.push(body);
        }
      },

      "Program:exit"() {
        const text = context.sourceCode.text;

        for (const { statement, call, delegated } of candidates) {
          if (!isScoped(call.callee)) {
            continue;
          }

          const block = unwrappable(call, delegated);

          context.report({
            node: call,
            messageId: "redundant",
            fix: block
              ? (fixer) =>
                fixer.replaceTextRange(statement.range, unwrappedText(text, statement, block))
              : undefined,
          });
        }
      },
    };
  },
};
