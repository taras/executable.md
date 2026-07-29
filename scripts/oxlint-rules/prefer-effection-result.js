/**
 * `local/prefer-effection-result` — one result contract, one representation.
 *
 * Effection's `Result<T>` is `{ ok: true, value: T } | { ok: false, error:
 * Error }`. Every function that hands a caller an outcome instead of raising
 * one can speak that shape, and when they all do, a failure travels through
 * the codebase as the same value it started as. The rule reports the two ways
 * that stops being true.
 *
 * The first is rebuilding a failure that already exists. Inside
 * `if (!result.ok)`, `result` is the failed arm — a complete `Result<T>`:
 *
 *     if (!result.ok) {
 *       return Err(result.error);
 *     }
 *
 * `Err(result.error)` allocates a second result carrying the same error, so
 * anything the original held beyond `error` — a subclass, a `cause` chain, the
 * identity a caller compares against — survives only by accident. Returning
 * the narrowed value preserves all of it:
 *
 *     if (!result.ok) {
 *       return result;
 *     }
 *
 * That rewrite is safe whenever the narrowed value is a plain identifier, so
 * the rule autofixes it. `Err` is resolved through an `effection` import,
 * aliases included, because a local function of the same name is a different
 * function.
 *
 * The second is declaring the contract again locally:
 *
 *     type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };
 *
 * A union like this is recognized by its structure — arms that fix `ok` to
 * `true` and to `false` — not by its name, because the names vary (`Result`,
 * `ParseResult`, `Outcome`) and inline return types have none at all. Each
 * such union renames the success payload or retypes the failure, and a caller
 * holding one cannot pass it where a `Result<T>` is expected. Convergence is
 * not mechanical: the success field has to move under `value` and the failure
 * data has to become an `Error`, which is a decision about what that error is.
 * So these are reported without a fix.
 *
 * A union discriminated on something else is a different shape with a
 * different meaning, and is left alone.
 */
const EFFECTION = new Set(["effection", "effection/experimental"]);

const BOUNDARY = new Set([
  "FunctionExpression",
  "FunctionDeclaration",
  "ArrowFunctionExpression",
  "ClassBody",
]);

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

/**
 * Returns the guard itself performs. A `return` inside a nested function
 * belongs to that function, not to the guarded branch.
 */
function returnStatements(node, found) {
  if (node.type === "ReturnStatement") {
    found.push(node);
  }

  for (const child of childNodes(node)) {
    if (!BOUNDARY.has(child.type)) {
      returnStatements(child, found);
    }
  }

  return found;
}

/** The object whose failure arm `<object>.<name>` reads, or null. */
function readerOf(expression, name) {
  if (
    expression.type !== "MemberExpression" ||
    expression.computed ||
    expression.optional ||
    expression.property.type !== "Identifier" ||
    expression.property.name !== name
  ) {
    return null;
  }

  return expression.object;
}

/** The value that `if (!value.ok)` narrows to its failure arm. */
function narrowedValue(test) {
  if (test.type !== "UnaryExpression" || test.operator !== "!") {
    return null;
  }

  return readerOf(test.argument, "ok");
}

/** The object a single-argument call reads `.error` from, or null. */
function reconstructedFrom(call) {
  if (call.arguments.length !== 1) {
    return null;
  }

  return readerOf(call.arguments[0], "error");
}

/** The boolean a type literal member fixes `ok` to, or undefined. */
function okLiteral(member) {
  if (
    member.type !== "TSPropertySignature" ||
    member.computed ||
    member.key.type !== "Identifier" ||
    member.key.name !== "ok" ||
    !member.typeAnnotation
  ) {
    return undefined;
  }

  const declared = member.typeAnnotation.typeAnnotation;

  if (declared.type !== "TSLiteralType" || typeof declared.literal.value !== "boolean") {
    return undefined;
  }

  return declared.literal.value;
}

/**
 * Whether every arm of the union is an object type that fixes `ok` to a
 * boolean literal, and both outcomes appear. A union that merely contains a
 * result-shaped arm describes something wider than a result, so it is not one.
 */
function isResultUnion(node) {
  const outcomes = new Set();

  for (const arm of node.types) {
    if (arm.type !== "TSTypeLiteral") {
      return false;
    }

    const declared = arm.members
      .map((member) => okLiteral(member))
      .filter((value) => value !== undefined);

    if (declared.length !== 1) {
      return false;
    }

    outcomes.add(declared[0]);
  }

  return outcomes.has(true) && outcomes.has(false);
}

export const preferEffectionResult = {
  meta: {
    type: "problem",
    fixable: "code",
    messages: {
      reconstructed:
        "The narrowed value is already a failed Result. Return it instead of rebuilding it with Err().",
      declared:
        "Use Effection's Result<T> instead of declaring an ok: true | false union: move the success payload under `value` and make the failure an Error.",
    },
  },

  create(context) {
    const text = context.sourceCode.text;
    const names = new Set();
    const namespaces = new Set();
    const candidates = [];
    const reports = [];

    function isErr(callee) {
      if (callee.type === "Identifier") {
        return names.has(callee.name);
      }

      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        callee.property.name === "Err"
      );
    }

    return {
      ImportDeclaration(node) {
        if (!EFFECTION.has(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "Err") {
            names.add(specifier.local.name);
          }

          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          }
        }
      },

      IfStatement(node) {
        const narrowed = narrowedValue(node.test);

        if (!narrowed) {
          return;
        }

        for (const statement of returnStatements(node.consequent, [])) {
          if (!statement.argument || statement.argument.type !== "CallExpression") {
            continue;
          }

          const call = statement.argument;
          const rebuilt = reconstructedFrom(call);

          if (rebuilt && text.slice(...rebuilt.range) === text.slice(...narrowed.range)) {
            candidates.push({ call, narrowed });
          }
        }
      },

      TSUnionType(node) {
        if (isResultUnion(node)) {
          reports.push({ node, messageId: "declared" });
        }
      },

      "Program:exit"() {
        for (const { call, narrowed } of candidates) {
          if (!isErr(call.callee)) {
            continue;
          }

          reports.push({
            node: call,
            messageId: "reconstructed",
            fix:
              narrowed.type === "Identifier"
                ? (fixer) => fixer.replaceTextRange(call.range, narrowed.name)
                : undefined,
          });
        }

        reports.sort((left, right) => left.node.range[0] - right.node.range[0]);

        for (const report of reports) {
          context.report(report);
        }
      },
    };
  },
};
