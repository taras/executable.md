/**
 * `local/prefer-effection-operation` — work is an Operation, not a Generator.
 *
 * `Generator` and `AsyncGenerator` are the types of the object a `function*`
 * produces. Naming one is right when a declaration really is handing a consumer
 * a sequence — `Generator<number, void, unknown>` says what arrives on each
 * `next()`, and this rule leaves it alone. What it reports is the concrete type
 * standing in for Effection work:
 *
 *     type EvalBlock = (env: Record<string, unknown>) =>
 *       Generator<unknown, unknown, unknown>;
 *
 * Nobody consumes that. A caller only runs the result with `yield*`, and this
 * type does not even let it: `Generator<unknown, …>` yields `unknown` where an
 * `Operation` yields `Effect`, so every call site needs a cast to get back the
 * contract it already had. `Operation<unknown>` is that contract, and a
 * `function*` remains a perfectly good way to implement it.
 *
 * ## What the yield type settles
 *
 * The first type argument is the whole test, because it is where the two
 * meanings differ. A generator that serves a consumer names what it yields. One
 * that yields `unknown` — or nothing, or `any` — offers a consumer nothing it
 * can use, which is the shape of work waiting for a runner. So a reference is
 * reported when its yield type is:
 *
 * - absent, `unknown`, or `any` — no consumer is being served; or
 * - an effect, which Effection work is what yields.
 *
 * Anything else is iteration and passes. That line is syntactic, so it is drawn
 * conservatively: a domain type this rule has never seen is taken at its word
 * as a value, and a `function*` whose generator type is inferred is never
 * examined at all. This rule reads declarations, not implementations.
 *
 * ## Which type is an effect
 *
 * A name is not evidence. `SoundEffect` is a sound, and a generator yielding
 * one is ordinary iteration, so an effect has to be recognized from something
 * the source actually says:
 *
 * - `Effect` imported from `effection`, however it is spelled at the import —
 *   directly, renamed, or reached through a namespace;
 * - a type this module declares by extending or intersecting one of those; or
 * - a type this module declares with Effection's effect contract itself:
 *
 *       description: string;
 *       enter(resolve, routine): (resolve) => void;
 *
 *   `description` annotated `string`, and `enter` a two-parameter signature
 *   whose result is itself callable — entering an effect hands back the
 *   operation that leaves it. Both shapes are checked, not just the two names,
 *   because names are cheap: `{ description: number; enter: boolean }` is a
 *   doorway, and a generator yielding one is iteration.
 *
 *   This branch is what recognizes `DurableEffect`. It restates the contract
 *   rather than extending it, deliberately, to keep `enter`'s variance under
 *   its own control, so nothing in its declaration names Effection at all.
 *   `Workflow<T>` yields it, which is why that declaration keeps its concrete
 *   type behind a suppression of its own.
 *
 * A union or intersection counts when any member does. Everything else is a
 * value — including a type imported from another module of this repository,
 * whose declaration this rule cannot see and will not guess at.
 *
 * ## Which `Generator` is the built-in
 *
 * Only the global one. A module with a `Generator` of its own is talking about
 * that type, and shadowing is lexical: a module-level import or declaration
 * covers the whole module, while a nested declaration or a type parameter
 * covers only the scope that owns it. A reference outside that scope is still
 * the built-in —
 *
 *     function local<Generator>(value: Generator): Generator { return value; }
 *
 *     type EvalBlock = () => Generator<unknown, unknown, unknown>;  // reported
 *
 * — and `globalThis.Generator` reaches past every shadow, so it is never taken
 * for a local name.
 *
 * ## No fix
 *
 * Whether a reported declaration should become `Operation<T>` or should keep a
 * generator and name what it yields depends on what the author meant. A
 * syntactic rule choosing between them would rewrite the contract rather than
 * the annotation, so the diagnostic names both and stops there.
 */
const BUILT_INS = new Set(["Generator", "AsyncGenerator"]);

const IMPORTS = new Set(["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"]);

const EFFECTION = new Set(["effection", "effection/experimental"]);

/** `enter(resolve, routine)` — the two Effection passes an effect on the way in. */
const ENTER_ARITY = 2;

/** Nodes that open a lexical scope a type declaration belongs to. */
const SCOPES = new Set(["BlockStatement", "StaticBlock", "TSModuleBlock", "Program"]);

/** Yield types that hand a consumer nothing it can name. */
const OPAQUE = new Map([
  ["TSUnknownKeyword", "unknown"],
  ["TSAnyKeyword", "any"],
]);

/** The name a type parameter binds, whichever shape the AST gives it. */
function parameterName(node) {
  if (typeof node.name === "string") {
    return node.name;
  }

  return node.name && node.name.type === "Identifier" ? node.name.name : undefined;
}

/** The trailing identifier of a type name, qualified or not. */
function referenceName(typeName) {
  if (typeName.type === "Identifier") {
    return typeName.name;
  }

  if (typeName.type === "TSQualifiedName" && typeName.right.type === "Identifier") {
    return typeName.right.name;
  }

  return undefined;
}

/** Whether a type name reaches the global object explicitly. */
function isGlobal(typeName) {
  return (
    typeName.type === "TSQualifiedName" &&
    typeName.left.type === "Identifier" &&
    typeName.left.name === "globalThis"
  );
}

/** The built-in a type reference names, or undefined for anything else. */
function builtIn(typeName) {
  const name = referenceName(typeName);

  if (!BUILT_INS.has(name) || !(typeName.type === "Identifier" || isGlobal(typeName))) {
    return undefined;
  }

  return name;
}

/** What the generator hands its consumer, or undefined when it is left off. */
function yielded(node) {
  const args = node.typeArguments ?? node.typeParameters;

  return args && args.params.length > 0 ? args.params[0] : undefined;
}

/** The name a member signs, or undefined when it is not a plain one. */
function memberName(member) {
  return member.key && member.key.type === "Identifier" ? member.key.name : undefined;
}

/** The type a member is annotated with, or undefined. */
function annotation(member) {
  return member.typeAnnotation ? member.typeAnnotation.typeAnnotation : undefined;
}

/** `description: string` — the effect's own annotation, not merely its name. */
function isDescription(member) {
  const declared = annotation(member);

  return (
    memberName(member) === "description" &&
    declared !== undefined &&
    declared.type === "TSStringKeyword"
  );
}

/**
 * `enter(resolve, routine): (resolve) => void` — a two-parameter signature whose
 * result is itself callable. That return is what makes an effect an effect:
 * entering one hands back the operation that leaves it.
 */
function isEnter(member) {
  if (memberName(member) !== "enter") {
    return false;
  }

  const declared = annotation(member);
  const signature =
    member.type === "TSMethodSignature"
      ? member
      : declared && declared.type === "TSFunctionType"
        ? declared
        : undefined;

  if (!signature) {
    return false;
  }

  const parameters = signature.params ?? signature.parameters ?? [];
  const returns = signature.returnType ? signature.returnType.typeAnnotation : undefined;

  return (
    parameters.length === ENTER_ARITY && returns !== undefined && returns.type === "TSFunctionType"
  );
}

/** Whether a body declares Effection's effect contract itself. */
function declaresContract(members) {
  return members.some(isDescription) && members.some(isEnter);
}

/** The type names a declaration builds itself out of. */
function ancestry(type, found) {
  if (!type) {
    return found;
  }

  if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
    for (const member of type.types) {
      ancestry(member, found);
    }
  }

  if (type.type === "TSTypeReference") {
    found.push(type.typeName);
  }

  return found;
}

/**
 * The type names an interface extends. A heritage clause carries an expression
 * rather than a type name, so a qualified one arrives as a member expression.
 */
function heritage(node) {
  return (node.extends ?? []).flatMap((entry) => {
    const expression = entry.expression ?? entry;

    if (expression.type === "Identifier" || expression.type === "TSQualifiedName") {
      return [expression];
    }

    if (
      expression.type === "MemberExpression" &&
      !expression.computed &&
      expression.object.type === "Identifier" &&
      expression.property.type === "Identifier"
    ) {
      return [{ type: "TSQualifiedName", left: expression.object, right: expression.property }];
    }

    return [];
  });
}

/** The innermost scope a declaration belongs to, or null at module level. */
function enclosingScope(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (SCOPES.has(parent.type)) {
      return parent.type === "Program" ? null : parent.range;
    }
  }

  return null;
}

export const preferEffectionOperation = {
  meta: {
    type: "problem",
    messages: {
      opaque:
        "{{name}} yielding {{yields}} offers a consumer nothing to consume: this is work for a runner. Declare Effection work as Operation<T> and run it with yield*, or, if it really is iteration, name what it yields — Iterator, IterableIterator, AsyncIterator, and AsyncIterableIterator say what arrives without fixing how it is produced.",
      effects:
        "A {{name}} that yields effects is Effection work, and its concrete type is the machinery producing it. Declare it as Operation<T> and run it with yield*.",
    },
  },

  create(context) {
    const shadows = [];
    const candidates = [];
    const imported = new Set();
    const namespaces = new Set();
    const declared = [];

    function shadow(name, range) {
      if (typeof name === "string" && BUILT_INS.has(name)) {
        shadows.push({ name, range });
      }
    }

    function declaring(node) {
      if (node.id && node.id.type === "Identifier") {
        shadow(node.id.name, enclosingScope(node));
      }
    }

    /** Whether a declaration of `name` covers this position. */
    function shadowed(name, at) {
      return shadows.some(
        (entry) =>
          entry.name === name &&
          (entry.range === null || (entry.range[0] <= at && at < entry.range[1])),
      );
    }

    /**
     * The names this module knows to be effects. Declarations are resolved to a
     * fixed point so a chain of them settles however it is ordered.
     */
    function effectNames() {
      const names = new Set(imported);

      for (let settling = true; settling; ) {
        settling = false;

        for (const entry of declared) {
          const inherited = entry.ancestry.some((typeName) => isEffect(typeName, names));

          if (!names.has(entry.name) && (entry.contract || inherited)) {
            names.add(entry.name);
            settling = true;
          }
        }
      }

      return names;
    }

    /** Whether a type name is one of Effection's effects. */
    function isEffect(typeName, names) {
      if (typeName.type === "TSQualifiedName") {
        return (
          typeName.left.type === "Identifier" &&
          namespaces.has(typeName.left.name) &&
          referenceName(typeName) === "Effect"
        );
      }

      return typeName.type === "Identifier" && names.has(typeName.name);
    }

    function yieldsEffects(type, names) {
      return ancestry(type, []).some((typeName) => isEffect(typeName, names));
    }

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (IMPORTS.has(specifier.type)) {
            shadow(specifier.local.name, enclosingScope(node));
          }

          if (!EFFECTION.has(node.source.value)) {
            continue;
          }

          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "Effect") {
            imported.add(specifier.local.name);
          }

          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          }
        }
      },

      // A type parameter is visible in the declaration that introduced it and
      // nowhere else, so that declaration's extent is its scope.
      TSTypeParameter(node) {
        const owner = node.parent && node.parent.parent;

        if (owner) {
          shadow(parameterName(node), owner.range);
        }
      },

      ClassDeclaration: declaring,
      TSEnumDeclaration: declaring,

      TSInterfaceDeclaration(node) {
        declaring(node);

        declared.push({
          name: node.id.name,
          contract: declaresContract(node.body.body),
          ancestry: heritage(node),
        });
      },

      TSTypeAliasDeclaration(node) {
        declaring(node);

        declared.push({
          name: node.id.name,
          contract:
            node.typeAnnotation.type === "TSTypeLiteral" &&
            declaresContract(node.typeAnnotation.members),
          ancestry: ancestry(node.typeAnnotation, []),
        });
      },

      TSTypeReference(node) {
        const name = builtIn(node.typeName);

        if (name !== undefined) {
          candidates.push({ node, name });
        }
      },

      "Program:exit"() {
        const names = effectNames();

        for (const candidate of candidates) {
          const global = isGlobal(candidate.node.typeName);

          if (!global && shadowed(candidate.name, candidate.node.range[0])) {
            continue;
          }

          const type = yielded(candidate.node);
          const opaque = type ? OPAQUE.get(type.type) : "nothing";

          if (!opaque && !yieldsEffects(type, names)) {
            continue;
          }

          context.report({
            node: candidate.node,
            messageId: opaque ? "opaque" : "effects",
            data: { name: candidate.name, yields: opaque ?? "" },
          });
        }
      },
    };
  },
};
