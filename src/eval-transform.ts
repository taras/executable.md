/**
 * Source transform for generator eval blocks (spec §4).
 *
 * Rewrites top-level declarations to export their values to a shared
 * binding environment, injects a preamble for importing bindings from
 * previous blocks, and detects execution mode from the AST.
 *
 * Uses acorn for parsing and magic-string for string mutations.
 */

import { parse } from "acorn";
import MagicString from "magic-string";
import type { Json } from "./types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TransformResult {
  /** Transformed body, without the generator wrapper */
  code: string;
  /** V3 source map JSON */
  map: string;
  /** Top-level names written to env */
  exports: string[];
  /** Names read from env (free variables present in env) */
  imports: string[];
  /** Execution mode detected from AST */
  mode: "generator" | "async" | "sync";
}

// ---------------------------------------------------------------------------
// Main transform function (spec §4.3)
// ---------------------------------------------------------------------------

/**
 * Transform an eval block's source code for execution.
 *
 * Pipeline:
 * 1. Parse with acorn (ecmaVersion: "latest", sourceType: "module")
 * 2. Detect mode from top-level yield/await
 * 3. Collect exports from top-level declarations
 * 4. Collect imports — free variable references in currentEnvKeys
 * 5. Build preamble — const { a, b } = env; for each imported name
 * 6. Append env-writes — env.x = x; after each top-level declaration
 * 7. Append sourceURL for debugger identification
 * 8. Generate source map
 */
export function transformBlock(
  source: string,
  blockId: string,
  currentEnvKeys: string[],
): TransformResult {
  // 1. Parse — wrap in an async generator function to allow both
  // top-level yield and await. Eval blocks are generator function bodies,
  // so yield* is valid syntax. We use `async function*` so that `await`
  // is also parseable (for mode detection — we detect and reject mixed
  // yield+await later).
  const WRAPPER_PREFIX = "(async function*() {\n";
  const WRAPPER_SUFFIX = "\n})";
  const wrappedSource = `${WRAPPER_PREFIX}${source}${WRAPPER_SUFFIX}`;
  const wrappedAst = parse(wrappedSource, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  });

  // Extract the body of the inner async generator function.
  // The wrapped AST is: ExpressionStatement > FunctionExpression > body
  // AST node positions are offset by WRAPPER_PREFIX.length relative to
  // the original source.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exprStmt = (wrappedAst as any).body[0];
  const funcExpr = exprStmt?.expression;
  const ast = { body: funcExpr?.body?.body ?? [], type: "Program" } as any;
  const offset = WRAPPER_PREFIX.length;

  // 2. Detect mode
  const mode = detectMode(ast);

  // 3. Collect exports from top-level declarations
  const exports = collectExports(ast);

  // 4. Collect imports — free variables present in env
  const envKeySet = new Set(currentEnvKeys);
  const declaredNames = new Set(exports);
  const freeVars = collectFreeVariables(ast, declaredNames);
  const imports = freeVars.filter((name) => envKeySet.has(name));

  // 5–7. Build transformed code
  const s = new MagicString(source);

  // 5. Build preamble
  if (imports.length > 0) {
    const preamble = `const { ${imports.join(", ")} } = env;\n`;
    s.prepend(preamble);
  }

  // 6. Append env-writes after each top-level declaration.
  // AST positions are relative to the wrapped source, so we subtract
  // the wrapper prefix length to get positions in the original source.
  for (const node of ast.body) {
    const names = extractDeclaredNames(node);
    if (names.length > 0) {
      const envWrites = names.map((name) => ` env.${name} = ${name};`).join("");
      s.appendLeft(node.end - offset, envWrites);
    }
  }

  // 7. Append sourceURL
  s.append(`\n//# sourceURL=eval:${blockId}`);

  // 8. Generate source map
  const map = s.generateMap({ source: blockId, hires: true });

  return {
    code: s.toString(),
    map: map.toString(),
    exports,
    imports,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Mode detection (spec §4.4)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

/**
 * Detect execution mode from top-level yield/await in ast.body.
 *
 * Only direct children of ast.body are inspected. yield/await inside
 * nested function bodies do NOT count.
 */
function detectMode(ast: AstNode): "generator" | "async" | "sync" {
  let hasYield = false;
  let hasAwait = false;

  for (const node of ast.body) {
    walkTopLevel(node, (n: AstNode) => {
      if (n.type === "YieldExpression") hasYield = true;
      if (n.type === "AwaitExpression") hasAwait = true;
    });
  }

  if (hasYield && hasAwait) {
    throw new Error(
      `Cannot mix \`yield*\` and \`await\` at the top level. ` +
        `Use \`yield* call(async () => { ... })\` to bridge async code into a generator block.`,
    );
  }

  if (hasYield) return "generator";
  if (hasAwait) return "async";
  return "sync";
}

/**
 * Walk a top-level statement, visiting expressions but NOT descending
 * into nested function/class/arrow bodies.
 */
function walkTopLevel(node: AstNode, visitor: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;

  visitor(node);

  // Do not descend into nested function/class/arrow bodies
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression" ||
    node.type === "MethodDefinition"
  ) {
    return;
  }

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walkTopLevel(item, visitor);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walkTopLevel(child, visitor);
    }
  }
}

// ---------------------------------------------------------------------------
// Export collection (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Collect names exported by top-level declarations.
 *
 * Only direct ast.body children are considered. Nested declarations
 * (inside if/for/etc.) are NOT exported.
 */
function collectExports(ast: AstNode): string[] {
  const names: string[] = [];

  for (const node of ast.body) {
    names.push(...extractDeclaredNames(node));
  }

  return names;
}

/**
 * Extract names declared by a top-level statement node.
 */
function extractDeclaredNames(node: AstNode): string[] {
  if (!node) return [];

  switch (node.type) {
    case "VariableDeclaration": {
      const names: string[] = [];
      for (const decl of node.declarations) {
        if (decl.id) {
          names.push(...extractPatternNames(decl.id));
        }
      }
      return names;
    }
    case "FunctionDeclaration":
      return node.id?.name ? [node.id.name] : [];
    case "ClassDeclaration":
      return node.id?.name ? [node.id.name] : [];
    default:
      return [];
  }
}

/**
 * Recursively extract bound names from a destructuring pattern.
 */
function extractPatternNames(pattern: AstNode): string[] {
  if (!pattern) return [];

  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern": {
      const names: string[] = [];
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          names.push(...extractPatternNames(prop.argument));
        } else {
          names.push(...extractPatternNames(prop.value));
        }
      }
      return names;
    }
    case "ArrayPattern": {
      const names: string[] = [];
      for (const elem of pattern.elements) {
        if (elem) {
          names.push(...extractPatternNames(elem));
        }
      }
      return names;
    }
    case "RestElement":
      return extractPatternNames(pattern.argument);
    case "AssignmentPattern":
      return extractPatternNames(pattern.left);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Free variable collection (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Collect free variable references in the AST.
 *
 * A "free variable" is an Identifier that appears in a read position
 * and is not declared within the block itself. Only names that are in
 * the current env keys set will be injected as imports.
 */
function collectFreeVariables(
  ast: AstNode,
  declaredNames: Set<string>,
): string[] {
  const references = new Set<string>();
  const localDecls = new Set(declaredNames);

  // Also collect names from all top-level variable declarations
  for (const node of ast.body) {
    const names = extractDeclaredNames(node);
    for (const name of names) {
      localDecls.add(name);
    }
  }

  for (const node of ast.body) {
    collectReferences(node, references, localDecls);
  }

  return [...references];
}

/**
 * Walk the AST collecting identifier references that are not local declarations.
 */
function collectReferences(
  node: AstNode,
  references: Set<string>,
  localDecls: Set<string>,
): void {
  if (!node || typeof node !== "object") return;

  if (node.type === "Identifier") {
    if (!localDecls.has(node.name)) {
      references.add(node.name);
    }
    return;
  }

  // Skip property names in member expressions (obj.prop — prop is not a reference)
  if (node.type === "MemberExpression" && !node.computed) {
    collectReferences(node.object, references, localDecls);
    // Skip node.property — it's a property name, not a variable reference
    return;
  }

  // Skip key names in object properties (not computed)
  if (node.type === "Property" && !node.computed) {
    // Only visit the value, not the key
    collectReferences(node.value, references, localDecls);
    return;
  }

  // For variable declarations, skip the declared name(s) and visit init
  if (node.type === "VariableDeclarator") {
    // Don't visit the id (it's a declaration, not a reference)
    collectReferences(node.init, references, localDecls);
    return;
  }

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          collectReferences(item, references, localDecls);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      collectReferences(child, references, localDecls);
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers (spec §6.3)
// ---------------------------------------------------------------------------

/**
 * Check if a value is JSON-serializable.
 */
export function isJson(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(isJson);
  }
  return false;
}

/**
 * Extract the JSON-serializable subset of exports from the env.
 *
 * Non-serializable values are silently omitted. They remain in
 * env.values as live references during this run but are absent from
 * the journal and not restored on replay.
 */
export function serializeExports(
  env: Record<string, unknown>,
  names: string[],
): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const name of names) {
    const value = env[name];
    if (isJson(value)) {
      result[name] = value as Json;
    }
    // Non-serializable values silently omitted.
  }
  return result;
}
