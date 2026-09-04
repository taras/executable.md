/**
 * `local/require-scope-bound-event-registration` — a listener outlives nothing.
 *
 * An event listener an Effection operation installs is state that operation
 * owns, and the architecture's ownership contract says owned state is released
 * when the owner is. Nothing about an event source enforces that. A handler
 * attached to a socket, a child process or a DOM target stays attached after
 * the operation that attached it has returned, failed, been halted, or lost a
 * `race()`; the source keeps calling it, and it keeps writing to state the
 * abandoned owner left behind.
 *
 * Cleanup that runs when the event fires is not cleanup. A cancelled wait is
 * precisely the case where the event never arrives, so `emitter.once()` and
 * `addEventListener(..., { once: true })` are reported wherever an Effection
 * owner reaches them. A one-event wait uses the scope-bound helper instead:
 *
 *     const [event] = yield* once(socket, "close");
 *
 * A subscription that outlives one event binds a stable handler and removes
 * that same handler, from that same receiver and event, in the owner's own
 * teardown. Removal is synchronous, so it belongs in one of four places: the
 * `finally` of a `try` around the subscription, an `ensure()` established
 * before the owner can suspend, a synchronous `finally` inside an `ensure()`
 * whose wait needs the listener still attached, or the cleanup an `action()`
 * executor returns. Node removes with `.off()`; the DOM removes with
 * `.removeEventListener()`, matching capture mode included.
 *
 * Recognition is by binding rather than by spelling, because `on` and `once`
 * are ordinary method names. What the rule resolves is:
 *
 * - values and types imported from `node:events`, `node:stream`,
 *   `node:child_process`, `node:net`, `node:http`, `node:https` and
 *   `node:process`;
 * - a binding holding what one of those constructors or factories returned,
 *   and the `stdin`, `stdout`, `stderr` and `socket` members of such a binding;
 * - a parameter or property annotated with one of those imported types;
 * - a class extending a recognized emitter, and `this` inside it;
 * - a local interface that declares a paired `on`/`off` or
 *   `addEventListener`/`removeEventListener` surface;
 * - `process` and its streams while they still name the host global; and
 * - DOM targets reached through `XMLHttpRequest`, `Worker`, `EventTarget`,
 *   `AbortController`/`AbortSignal`, `document`, `window`, `self` and
 *   `globalThis`.
 *
 * An owner is a generator function, or the executor of `action()` imported
 * from `effection`. A callback declared inside one inherits it, because it
 * closes over that scope. Nothing else is an owner: a standalone fixture
 * process, a browser-lifetime callback and a plain Promise helper install
 * listeners for a lifetime Effection does not manage, and are accepted. A
 * helper that ought to be scope-bound is refactored into an operation rather
 * than left as a plain function to escape this rule.
 *
 * There is no autofix. Choosing the owner, the handler binding and the order
 * of teardown changes what the program does when it is cancelled, which is the
 * decision this rule exists to make visible.
 */

/** Node modules whose event sources the rule recognizes, by specifier. */
const NODE_MODULES = new Map([
  ["events", { values: ["EventEmitter"], types: ["EventEmitter"] }],
  [
    "stream",
    {
      values: ["Readable", "Writable", "Duplex", "Transform", "PassThrough", "Stream"],
      types: ["Readable", "Writable", "Duplex", "Transform", "PassThrough", "Stream"],
    },
  ],
  [
    "child_process",
    {
      values: ["spawn", "exec", "execFile", "fork", "ChildProcess"],
      types: ["ChildProcess", "ChildProcessWithoutNullStreams", "ChildProcessByStdio"],
    },
  ],
  [
    "net",
    {
      values: ["connect", "createConnection", "createServer", "Socket", "Server"],
      types: ["Socket", "Server"],
    },
  ],
  [
    "http",
    {
      values: ["createServer", "request", "get", "Server", "ClientRequest"],
      types: ["Server", "IncomingMessage", "ServerResponse", "ClientRequest"],
    },
  ],
  [
    "https",
    {
      values: ["createServer", "request", "get", "Server"],
      types: ["Server", "IncomingMessage", "ServerResponse"],
    },
  ],
  ["process", { values: [], types: [] }],
  ["worker_threads", { values: ["Worker", "MessagePort"], types: ["Worker", "MessagePort"] }],
]);

/** DOM constructors whose instances are event targets. */
const DOM_CONSTRUCTORS = new Set([
  "AbortController",
  "EventSource",
  "EventTarget",
  "MessageChannel",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
]);

/** DOM globals that are event targets in their own right. */
const DOM_GLOBALS = new Set(["document", "globalThis", "self", "window"]);

/** DOM types a parameter or property may be annotated with. */
const DOM_TYPES = new Set([
  "AbortSignal",
  "EventSource",
  "EventTarget",
  "MessagePort",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
]);

/** Members of a recognized source that are themselves event sources. */
const SOURCE_MEMBERS = new Set(["stdin", "stdout", "stderr", "socket", "signal", "port1", "port2"]);

const REGISTER = new Set(["on", "once", "addEventListener"]);
const REMOVE = new Set(["off", "removeEventListener", "removeListener"]);

/** Nodes that stop a search for suspensions belonging to one owner. */
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The module a specifier names, with any `node:` prefix removed. */
function moduleOf(source) {
  return typeof source === "string" ? source.replace(/^node:/u, "") : "";
}

/** The property a member expression reads, whether named or spelled out. */
function memberName(node) {
  if (node.type !== "MemberExpression") {
    return null;
  }

  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }

  return typeof node.property.value === "string" ? node.property.value : null;
}

/** The names a type annotation refers to, for the simple forms the rule reads. */
function typeNames(annotation) {
  const reference = annotation?.typeAnnotation ?? annotation;

  if (reference?.type === "TSUnionType") {
    return reference.types.flatMap((member) => typeNames(member));
  }

  const name = typeName(reference);

  return name === null ? [] : [name];
}

/** The name a single type reference refers to. */
function typeName(annotation) {
  const reference = annotation?.typeAnnotation ?? annotation;

  if (!reference) {
    return null;
  }

  if (reference.type === "TSTypeReference") {
    const name = reference.typeName;
    if (name?.type === "Identifier") {
      return name.name;
    }
    if (name?.type === "TSQualifiedName" && name.right?.type === "Identifier") {
      return name.right.name;
    }
  }

  return null;
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string";
}

/** The name a property declares, whether written plainly or as a string. */
function propertyName(property) {
  if (property.type !== "Property") {
    return null;
  }

  if (!property.computed && property.key?.type === "Identifier") {
    return property.key.name;
  }

  return isStringLiteral(property.key) ? property.key.value : null;
}

/**
 * How a listener options object spells a boolean member, when it says so
 * statically. `{ "once": true }` and `{ once: ONCE }` for a `const ONCE = true`
 * are the same registration as `{ once: true }`.
 */
function staticFlag(node, name, resolve) {
  if (node?.type !== "ObjectExpression") {
    return undefined;
  }

  const property = node.properties.find((entry) => propertyName(entry) === name);

  if (property === undefined) {
    return undefined;
  }

  const value = property.value;

  if (value?.type === "Literal" && typeof value.value === "boolean") {
    return value.value;
  }

  return resolve(value);
}

/**
 * How a listener argument list spells its capture mode. `{ capture: true }`
 * and a bare `true` are the same registration, so both normalize to the same
 * value and a removal has to agree with it.
 */
function captureOf(node, resolve) {
  if (node === undefined) {
    return false;
  }

  if (node.type === "Literal" && typeof node.value === "boolean") {
    return node.value;
  }

  return staticFlag(node, "capture", resolve) === true;
}

export const requireScopeBoundEventRegistration = {
  meta: {
    type: "problem",
    messages: {
      rawOnce:
        '{{receiver}}.once("{{event}}") removes its listener only when the event arrives, which a cancelled wait never gets. Wait with the scope-bound once() from @effectionx/node/events.',
      onceOption:
        'addEventListener("{{event}}", …, { once: true }) removes its listener only when the event arrives, which a cancelled wait never gets. Wait with the scope-bound once() from @effectionx/node/events.',
      anonymous:
        'This listener on "{{event}}" has no name, so nothing can remove it. Bind the handler and remove that binding in the owner\'s teardown.',
      dynamicEvent:
        "This listener's event name is computed, so the pairing with its removal cannot be established. Register each event under a literal name.",
      missing:
        'Nothing removes {{handler}} from {{receiver}} "{{event}}" when this operation ends. Remove it in a finally around the subscription, an ensure() established before the owner suspends, a synchronous finally inside that ensure(), or the cleanup returned by action().',
      mismatched:
        'The cleanup for {{receiver}} "{{event}}" does not name the same receiver, event, handler and capture mode this registration used, so the handler stays attached. Remove {{handler}} from {{receiver}} "{{event}}".',
      selfRemoving:
        '{{handler}} removes itself only when "{{event}}" arrives, which a cancelled owner never gets. Remove it in the owner\'s teardown as well.',
      late: "This cleanup is registered after the owner can already suspend, so a failure in between leaves {{handler}} attached to {{receiver}}. Establish it in the same synchronous prefix as the subscription.",
      unarmed:
        "This ensure() is yielded after {{handler}} was attached, and entering it is itself a suspension: an owner halted there unwinds with no cleanup registered at all, leaving {{handler}} on {{receiver}}. Establish the ensure() before the subscription, or put both inside a try whose finally removes it.",
      suspended:
        "Teardown suspends before it removes {{handler}} from {{receiver}}, so a halt during that wait leaves the handler attached. Remove it in a synchronous finally around the wait.",
      removeListener:
        "removeListener() is not the removal this rule pairs with. Use .off() so the subscription and its cleanup read as one pair.",
    },
  },

  create(context) {
    const source = context.sourceCode;
    const text = source.text;

    /** Imported bindings, by local name, that name a recognized module value. */
    const values = new Map();
    /** Imported bindings, by local name, that name a recognized module type. */
    const types = new Map();
    /** Local interfaces whose declared surface is a paired event source. */
    const structural = new Set();
    /** Classes extending a recognized emitter, by declaration range. */
    const emitterClasses = [];
    const registrations = [];
    const removals = [];
    /** `collection.set(receiver, handler)` calls, which pair a source with its handler. */
    const records = [];
    const reports = [];

    function variableOf(node) {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const found = scope.variables.find((variable) => variable.name === node.name);

        if (found) {
          return found;
        }
      }

      return null;
    }

    /** Whether an identifier still names what the host put there. */
    function isGlobal(node) {
      if (node.type !== "Identifier") {
        return false;
      }

      const variable = variableOf(node);
      return variable === null || variable.defs.length === 0;
    }

    /** The declaration an identifier resolves to, or null. */
    function definitionOf(node) {
      if (node.type !== "Identifier") {
        return null;
      }

      const variable = variableOf(node);
      return variable?.defs?.[0] ?? null;
    }

    /** Whether an identifier resolves to `name` imported from `module`. */
    function importsFrom(node, module, name) {
      const definition = definitionOf(node);

      if (definition?.type !== "ImportBinding") {
        return false;
      }

      const declaration = definition.parent;

      if (declaration.importKind === "type" || definition.node.importKind === "type") {
        return false;
      }

      return (
        moduleOf(declaration.source.value) === module &&
        definition.node.type === "ImportSpecifier" &&
        definition.node.imported.name === name
      );
    }

    function isProcessGlobal(node) {
      if (isGlobal(node) && node.name === "process") {
        return true;
      }

      const definition = definitionOf(node);

      return (
        definition?.type === "ImportBinding" &&
        moduleOf(definition.parent.source.value) === "process" &&
        definition.node.type === "ImportDefaultSpecifier"
      );
    }

    /** Whether a callee names a constructor or factory of a Node event source. */
    function isNodeFactory(node) {
      if (node.type === "MemberExpression") {
        const name = memberName(node);
        const object = node.object;

        if (object.type !== "Identifier" || name === null) {
          return false;
        }

        const definition = definitionOf(object);

        if (definition?.type !== "ImportBinding") {
          return false;
        }

        const module = moduleOf(definition.parent.source.value);
        const recognized = NODE_MODULES.get(module);

        return Boolean(recognized?.values.includes(name));
      }

      if (node.type !== "Identifier") {
        return false;
      }

      const definition = definitionOf(node);

      if (definition?.type !== "ImportBinding") {
        return false;
      }

      const module = moduleOf(definition.parent.source.value);
      const recognized = NODE_MODULES.get(module);

      return Boolean(
        recognized &&
        definition.node.type === "ImportSpecifier" &&
        recognized.values.includes(definition.node.imported.name),
      );
    }

    /** Whether a callee names a DOM constructor whose instances are targets. */
    function isDomConstructor(node) {
      return node.type === "Identifier" && DOM_CONSTRUCTORS.has(node.name) && isGlobal(node);
    }

    /** Whether an expression produces an event source. */
    function producesSource(node) {
      if (!node) {
        return false;
      }

      if (node.type === "NewExpression") {
        return (
          isNodeFactory(node.callee) ||
          isDomConstructor(node.callee) ||
          isEmitterSubclass(node.callee)
        );
      }

      if (node.type === "CallExpression") {
        return isNodeFactory(node.callee);
      }

      if (node.type === "AwaitExpression" || node.type === "TSNonNullExpression") {
        return producesSource(node.expression);
      }

      // A binding chosen between two sources is still a source; one whose
      // alternative is something else is not.
      if (node.type === "ConditionalExpression") {
        return producesSource(node.consequent) && producesSource(node.alternate);
      }

      return isSource(node);
    }

    /** Whether a callee names a class the file declares as an emitter. */
    function isEmitterSubclass(node) {
      if (node.type !== "Identifier") {
        return false;
      }

      const definition = definitionOf(node);
      const declaration = definition?.node;

      return (
        declaration?.type === "ClassDeclaration" &&
        emitterClasses.some((range) => range[0] === declaration.range[0])
      );
    }

    /** Whether an annotation names an event source, in any member of a union. */
    function isSourceType(annotation, at) {
      return typeNames(annotation).some((name) => {
        if (DOM_TYPES.has(name) || structural.has(name)) {
          return true;
        }

        const binding = types.get(name);
        return binding !== undefined && binding <= at;
      });
    }

    /**
     * Whether an expression names an event source. Aliases and members are
     * followed, so `child.stdout` and a binding that merely holds a socket both
     * resolve to what produced them.
     */
    function isSource(node) {
      if (!node) {
        return false;
      }

      if (node.type === "MemberExpression") {
        const name = memberName(node);

        if (name === null) {
          return false;
        }

        if (SOURCE_MEMBERS.has(name)) {
          return isSource(node.object) || isProcessGlobal(node.object);
        }

        if (isGlobal(node.object) && node.object.name === "globalThis") {
          return DOM_GLOBALS.has(name) || name === "process";
        }

        return false;
      }

      if (node.type === "ThisExpression") {
        return inEmitterClass(node);
      }

      if (node.type !== "Identifier") {
        return false;
      }

      if (isProcessGlobal(node)) {
        return true;
      }

      if (isGlobal(node) && DOM_GLOBALS.has(node.name)) {
        return true;
      }

      const definition = definitionOf(node);

      if (!definition) {
        return false;
      }

      if (definition.type === "Parameter") {
        const parameter = definition.name ?? definition.node;

        if (isSourceType(parameter?.typeAnnotation, node.range[0])) {
          return true;
        }

        // A default value is the only thing a parameter says about itself when
        // it carries no annotation.
        const pattern = parameter?.parent;

        return (
          pattern?.type === "AssignmentPattern" &&
          pattern.left === parameter &&
          producesSource(pattern.right)
        );
      }

      if (definition.type === "Variable" || definition.type === "VariableDeclarator") {
        const declarator = definition.node;

        if (isSourceType(declarator.id?.typeAnnotation, node.range[0])) {
          return true;
        }

        // Only a binding that holds the source itself resolves: reassignment
        // and conditional initialization say nothing about what it now holds.
        return producesSource(declarator.init);
      }

      return false;
    }

    /** Whether a node sits inside a class that extends a recognized emitter. */
    function inEmitterClass(node) {
      return emitterClasses.some((range) => range[0] <= node.range[0] && node.range[1] <= range[1]);
    }

    /** The normalized text of a receiver expression, used as its identity. */
    function receiverKey(node) {
      return text.slice(node.range[0], node.range[1]).replace(/\s+/gu, "");
    }

    /** A `const`-bound boolean, when the binding says so and nothing reassigns it. */
    function constantBoolean(node) {
      if (node?.type !== "Identifier") {
        return undefined;
      }

      const variable = variableOf(node);
      const definition = variable?.defs?.[0];

      if (definition?.type !== "Variable" && definition?.type !== "VariableDeclarator") {
        return undefined;
      }

      const initializer = definition.node.init;

      return definition.parent?.kind === "const" &&
        initializer?.type === "Literal" &&
        typeof initializer.value === "boolean"
        ? initializer.value
        : undefined;
    }

    /** Constructs that can decide not to run what is nested inside them. */
    const BRANCHES = new Set([
      "IfStatement",
      "SwitchStatement",
      "SwitchCase",
      "ForStatement",
      "ForOfStatement",
      "ForInStatement",
      "WhileStatement",
      "DoWhileStatement",
      "CatchClause",
      "ConditionalExpression",
      "LogicalExpression",
    ]);

    /**
     * Whether cleanup at `to` is reached whenever the registration at `from`
     * has happened, with nothing suspending in between.
     *
     * Cleanup nested in a branch the registration is not nested in may simply
     * not run, which is a listener left attached rather than a pair.
     */
    function unconditionallyReached(from, to) {
      const path = [];

      for (let parent = to.parent; parent; parent = parent.parent) {
        if (contains(parent.range, from)) {
          break;
        }
        path.push(parent);
      }

      if (path.some((node) => BRANCHES.has(node.type))) {
        return false;
      }

      return adjacent(from, to);
    }

    /** The identifier a member chain is rooted in, or null. */
    function rootIdentifier(node) {
      let current = node;

      while (current?.type === "MemberExpression") {
        current = current.object;
      }

      return current?.type === "Identifier" ? current : null;
    }

    /**
     * Whether two expressions name the same value, rather than merely being
     * spelled the same. Two connections both called `socket` are two sockets,
     * and removing a handler from one says nothing about the other.
     */
    function sameValue(left, right) {
      if (receiverKey(left) !== receiverKey(right)) {
        return false;
      }

      const first = rootIdentifier(left);
      const second = rootIdentifier(right);

      if (!first || !second) {
        return true;
      }

      return variableOf(first) === variableOf(second);
    }

    /**
     * The nearest enclosing Effection owner.
     *
     * Nearest, and nothing wider. A nested generator or `action()` executor is
     * a scope of its own and ends before the one around it, so cleanup an
     * outer owner performs runs too late to be this registration's pair —
     * whether it names the handler directly or walks a collection the handler
     * was recorded in. A plain callback declared inside an owner is not a
     * scope, so it inherits that owner and may register on its behalf.
     */
    function ownerOf(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          (parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") &&
          parent.generator
        ) {
          return { node: parent, kind: "generator" };
        }

        if (FUNCTIONS.has(parent.type) && isActionExecutor(parent)) {
          return { node: parent, kind: "action" };
        }
      }

      return null;
    }

    /** Whether a function is the executor `action()` was given. */
    function isActionExecutor(node) {
      const call = node.parent;

      return (
        call?.type === "CallExpression" &&
        call.arguments[0] === node &&
        importsFrom(call.callee, "effection", "action")
      );
    }

    function contains(range, node) {
      return range[0] <= node.range[0] && node.range[1] <= range[1];
    }

    /** Suspensions performed between two positions of one block. */
    function suspendsBetween(block, from, to) {
      let found = false;

      walk(block, (node) => {
        if (node.type === "YieldExpression" && node.range[0] >= from && node.range[1] <= to) {
          found = true;
        }
      });

      return found;
    }

    /** The statement of its own block that contains `node`. */
    function statementOf(node) {
      let current = node;

      for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
        if (parent.type === "BlockStatement" || parent.type === "Program") {
          return current;
        }
      }

      return null;
    }

    /** The innermost block that holds both nodes. */
    function commonBlock(first, second) {
      for (let parent = first.parent; parent; parent = parent.parent) {
        if (
          (parent.type === "BlockStatement" || parent.type === "Program") &&
          contains(parent.range, second)
        ) {
          return parent;
        }
      }

      return null;
    }

    /** The statement of `block` that holds `node`. */
    function statementIn(block, node) {
      let current = node;

      for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
        if (parent === block) {
          return current;
        }
      }

      return null;
    }

    /**
     * Whether two nodes are reached in one uninterrupted synchronous run: the
     * statements holding them, in the innermost block holding both, with
     * nothing that suspends in between.
     */
    function adjacent(first, second) {
      const block = commonBlock(first, second);

      if (!block) {
        return false;
      }

      const earlier = statementIn(block, first);
      const later = statementIn(block, second);

      if (!earlier || !later || earlier === later) {
        return true;
      }

      const [start, end] = earlier.range[0] < later.range[0] ? [earlier, later] : [later, earlier];

      return !suspendsBetween(block, start.range[1], end.range[0]);
    }

    /** Visit every node under `root` that the same function evaluates. */
    function walk(root, visit) {
      if (!root || typeof root.type !== "string") {
        return;
      }

      visit(root);

      for (const key of Object.keys(root)) {
        if (key === "parent" || key === "loc" || key === "range") {
          continue;
        }

        const value = root[key];

        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === "object" && typeof child.type === "string") {
            if (FUNCTIONS.has(child.type)) {
              continue;
            }
            walk(child, visit);
          }
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const module = moduleOf(node.source.value);
        const recognized = NODE_MODULES.get(module);

        if (!recognized) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }

          const imported = specifier.imported.name;

          if (recognized.values.includes(imported)) {
            values.set(specifier.local.name, node.range[0]);
          }

          if (recognized.types.includes(imported)) {
            types.set(specifier.local.name, node.range[0]);
          }
        }
      },

      TSInterfaceDeclaration(node) {
        const members = node.body.body
          .filter((member) => member.type === "TSMethodSignature" && !member.computed)
          .map((member) => member.key?.name);

        if (
          (members.includes("on") && members.includes("off")) ||
          (members.includes("addEventListener") && members.includes("removeEventListener"))
        ) {
          structural.add(node.id.name);
        }
      },

      ClassDeclaration(node) {
        const parent = node.superClass;

        if (parent && (isNodeFactory(parent) || isDomConstructor(parent))) {
          emitterClasses.push(node.range);
        }
      },

      CallExpression(node) {
        const callee = node.callee;

        if (callee.type !== "MemberExpression") {
          return;
        }

        const method = memberName(callee);

        if (method === null) {
          return;
        }

        if (REMOVE.has(method)) {
          removals.push({ node, method, receiver: callee.object });
          return;
        }

        if (method === "set" && node.arguments.length === 2) {
          records.push({ node, collection: callee.object });
          return;
        }

        if (!REGISTER.has(method)) {
          return;
        }

        registrations.push({ node, method, receiver: callee.object });
      },

      "Program:exit"() {
        for (const entry of registrations) {
          classify(entry);
        }

        reports.sort((left, right) => left.node.range[0] - right.node.range[0]);

        for (const entry of reports) {
          context.report(entry);
        }
      },
    };

    /** Report what one registration is missing, if anything. */
    function classify(entry) {
      const { node, method, receiver } = entry;

      if (!isSource(receiver)) {
        return;
      }

      const owner = ownerOf(node);

      if (!owner) {
        return;
      }

      const [event, handler, options] = node.arguments;
      const receiverText = receiverKey(receiver);

      if (!isStringLiteral(event)) {
        reports.push({ node, messageId: "dynamicEvent", data: {} });
        return;
      }

      if (method === "once") {
        reports.push({
          node,
          messageId: "rawOnce",
          data: { receiver: receiverText, event: event.value },
        });
        return;
      }

      if (method === "addEventListener" && staticFlag(options, "once", constantBoolean) === true) {
        reports.push({ node, messageId: "onceOption", data: { event: event.value } });
        return;
      }

      if (handler?.type !== "Identifier") {
        reports.push({ node, messageId: "anonymous", data: { event: event.value } });
        return;
      }

      const capture = method === "addEventListener" ? captureOf(options, constantBoolean) : false;
      const remover = method === "addEventListener" ? "removeEventListener" : "off";

      // Only the owner's own cleanup counts. Two operations in one file often
      // name their socket `socket`, and a removal in one of them says nothing
      // about what the other leaves attached.
      const owned = removals.filter((removal) => contains(owner.node.range, removal.node));

      const pairs = owned.filter(
        (removal) =>
          sameValue(removal.receiver, receiver) &&
          isStringLiteral(removal.node.arguments[0]) &&
          removal.node.arguments[0].value === event.value &&
          removal.node.arguments[1]?.type === "Identifier" &&
          sameValue(removal.node.arguments[1], handler) &&
          (method !== "addEventListener" ||
            captureOf(removal.node.arguments[2], constantBoolean) === capture),
      );

      const data = { receiver: receiverText, event: event.value, handler: handler.name };
      const candidates = pairs.filter((removal) => removal.method === remover);

      if (candidates.length === 0) {
        if (pairs.length > 0) {
          reports.push({ node, messageId: "removeListener", data });
          return;
        }

        if (detachedInBulk(entry, receiverText, handler, event.value, owner)) {
          return;
        }

        const near = owned.some(
          (removal) =>
            receiverKey(removal.receiver) === receiverText ||
            (removal.node.arguments[1]?.type === "Identifier" &&
              removal.node.arguments[1].name === handler.name),
        );

        reports.push({ node, messageId: near ? "mismatched" : "missing", data });
        return;
      }

      const verdicts = candidates.map((removal) => placement(removal, node, owner, handler));

      if (verdicts.includes("accepted")) {
        return;
      }

      const verdict = verdicts.find((value) => value !== "unrelated") ?? "missing";

      reports.push({
        node,
        messageId: verdict === "unrelated" ? "missing" : verdict,
        data,
      });
    }

    /**
     * Whether the owner remembers this pair in a collection and detaches that
     * whole collection in its teardown.
     *
     * One handler per accepted connection cannot be named individually, so the
     * collection is the pairing: the registration records the receiver and its
     * handler together, and teardown walks the same collection removing each
     * handler from the receiver it was recorded against.
     */
    function detachedInBulk(entry, receiverText, handler, event, owner) {
      const collections = records
        .filter(
          (record) =>
            contains(owner.node.range, record.node) &&
            sameValue(record.node.arguments[0], entry.receiver) &&
            record.node.arguments[1]?.type === "Identifier" &&
            sameValue(record.node.arguments[1], handler) &&
            // Recorded in the same synchronous run as the subscription: a pair
            // written down after the owner could suspend is one the teardown
            // in between would not have found.
            unconditionallyReached(entry.node, record.node),
        )
        .map((record) => record.collection);

      if (collections.length === 0) {
        return false;
      }

      return removals.some((removal) => {
        if (
          removal.method !==
            (entry.method === "addEventListener" ? "removeEventListener" : "off") ||
          !contains(owner.node.range, removal.node) ||
          !isStringLiteral(removal.node.arguments[0]) ||
          removal.node.arguments[0].value !== event
        ) {
          return false;
        }

        const loop = iterationOf(removal.node);

        if (!loop || !collections.some((collection) => sameValue(collection, loop.right))) {
          return false;
        }

        const pattern = loop.left.declarations?.[0]?.id ?? loop.left;

        return (
          pattern?.type === "ArrayPattern" &&
          pattern.elements[0]?.name === receiverKey(removal.receiver) &&
          pattern.elements[1]?.name === removal.node.arguments[1]?.name &&
          releasedBeforeSuspending(removal.node, owner)
        );
      });
    }

    /** The `for…of` whose body contains this node, within one function. */
    function iterationOf(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === "ForOfStatement") {
          return parent;
        }

        if (FUNCTIONS.has(parent.type)) {
          return null;
        }
      }

      return null;
    }

    /** Whether a bulk detach runs in teardown, before that teardown suspends. */
    function releasedBeforeSuspending(removal, owner) {
      const cleanup = ensureCleanup(removal, owner);

      if (cleanup) {
        return !suspendsBefore(cleanup, removal, protectedBy(removal)?.range);
      }

      return protectedBy(removal) !== null;
    }

    /**
     * Where a matching removal sits relative to the registration, and whether
     * that place runs when the owner ends.
     */
    function placement(removal, registration, owner, handler) {
      // Only a handler this file declares can remove itself. A handler that
      // arrived as a parameter is somebody else's function, and its
      // declaration is the enclosing signature rather than a body.
      const definition = definitionOf(handler);
      const handlerNode =
        definition?.type === "Variable" || definition?.type === "VariableDeclarator"
          ? definition.node.init
          : definition?.type === "FunctionName"
            ? definition.node
            : null;

      if (
        handlerNode &&
        FUNCTIONS.has(handlerNode.type) &&
        contains(handlerNode.range, removal.node)
      ) {
        return "selfRemoving";
      }

      for (let parent = removal.node.parent; parent; parent = parent.parent) {
        if (
          parent.type === "TryStatement" &&
          parent.finalizer &&
          contains(parent.finalizer.range, removal.node)
        ) {
          // The `finally` of a `try` that covers the subscription runs on every
          // way out of it, which is the whole guarantee this rule is after. A
          // subscription made just before that `try` is covered too, as long
          // as nothing between the two can suspend.
          if (contains(parent.block.range, registration)) {
            return "accepted";
          }

          if (guards(parent, registration)) {
            return "accepted";
          }

          // Otherwise the `finally` still protects whatever its `try` suspends
          // on, which is what an ensure() with a listener-dependent wait needs.
          const cleanup = ensureCleanup(removal.node, owner);

          if (cleanup) {
            return suspendsBefore(cleanup, removal.node, parent.range)
              ? "suspended"
              : armed(cleanup, registration);
          }

          if (statementOf(parent)?.parent === statementOf(registration)?.parent) {
            return "late";
          }
        }

        if (parent === owner.node) {
          break;
        }
      }

      const cleanup = ensureCleanup(removal.node, owner);

      if (cleanup) {
        if (suspendsBefore(cleanup, removal.node, protectedBy(removal.node)?.range)) {
          return "suspended";
        }

        return armed(cleanup, registration);
      }

      if (owner.kind === "action" && returnedCleanup(removal.node, owner.node)) {
        return "accepted";
      }

      return "unrelated";
    }

    /**
     * Whether a `try` statement covers a subscription made just before it,
     * with no suspension in between to fail through.
     */
    function guards(statement, registration) {
      const subscription = statementOf(registration);
      const guard = statementOf(statement);

      if (!subscription || !guard || subscription === guard) {
        return false;
      }

      // A lexical finalizer only covers what runs in its own frame. A `try`
      // inside an `ensure()` cleanup is a different function, reached only once
      // that `ensure()` has been established — which is the very thing the
      // ordering rule in `armed()` is about.
      if (functionOf(statement) !== functionOf(registration)) {
        return false;
      }

      return (
        subscription.range[1] <= guard.range[0] && unconditionallyReached(registration, statement)
      );
    }

    /** The nearest function a node runs in, or null at module level. */
    function functionOf(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (FUNCTIONS.has(parent.type)) {
          return parent;
        }
      }

      return null;
    }

    /** The `ensure()` cleanup function a node sits inside, within this owner. */
    function ensureCleanup(node, owner) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          FUNCTIONS.has(parent.type) &&
          parent.parent?.type === "CallExpression" &&
          parent.parent.arguments[0] === parent &&
          importsFrom(parent.parent.callee, "effection", "ensure")
        ) {
          return parent;
        }

        if (parent === owner.node) {
          return null;
        }
      }

      return null;
    }

    /**
     * Whether the cleanup suspends before it reaches the removal. A suspension
     * inside a `try` whose `finally` performs that removal does not count: it
     * is the wait the listener is being kept alive for.
     */
    function suspendsBefore(cleanup, removal, protectedRange) {
      let found = false;

      walk(cleanup.body, (node) => {
        if (node.type !== "YieldExpression" || node.range[1] > removal.range[0]) {
          return;
        }

        if (protectedRange && contains(protectedRange, node)) {
          return;
        }

        found = true;
      });

      return found;
    }

    /** The `try` whose `finally` performs this removal, if there is one. */
    function protectedBy(removal) {
      for (let parent = removal.parent; parent; parent = parent.parent) {
        if (
          parent.type === "TryStatement" &&
          parent.finalizer &&
          contains(parent.finalizer.range, removal)
        ) {
          return parent;
        }
      }

      return null;
    }

    /**
     * Whether the `ensure()` holding this cleanup was established in the same
     * uninterrupted synchronous run as the subscription.
     */
    function armed(cleanup, registration) {
      const call = cleanup.parent;

      if (!unconditionallyReached(registration, call)) {
        return "late";
      }

      // Established means finished. `yield* ensure(...)` is itself a
      // suspension, so an owner halted while it is registering unwinds with no
      // cleanup on it at all — measured: the listener stays attached and the
      // cleanup never runs. Only an `ensure()` that completed before the
      // subscription existed has covered it.
      return call.range[1] <= registration.range[0] ? "accepted" : "unarmed";
    }

    /** Whether a node sits in a function the action executor returns. */
    function returnedCleanup(node, executor) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (FUNCTIONS.has(parent.type)) {
          const owner = parent.parent;

          if (owner?.type === "ReturnStatement" && contains(executor.range, owner)) {
            return true;
          }

          if (executor.body === parent.parent || parent === executor) {
            return false;
          }
        }

        if (parent === executor) {
          return executor.body === node || contains(executor.range, node);
        }
      }

      return false;
    }
  },
};
