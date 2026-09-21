/**
 * Whether a module names a host, a runtime, a storage engine or a provider.
 *
 * A shared contract is neutral because nothing in it names one implementation.
 * That is a property of the source text and of what the source loads, so it is
 * read here rather than asserted: any package with a provider-neutral half can
 * hold its own modules to this rule and name its own surface.
 *
 * The scan reads code rather than prose. These modules explain in their own
 * comments that they name no host, and a substring search of the whole file
 * would find the explanation and report the crossing it describes.
 *
 * `forbiddenNames` is the answer; the rest is exported so a suite can prove the
 * scanner can fail before trusting an empty result from it.
 */

import ts from "typescript";

/**
 * Storage, adapter and provider names that mean a host reached this surface.
 *
 * Distinctive enough to be read as text. Runtime globals are not here — `Bun`
 * is inside `Bundle` and `Deno` inside `Denominator`, so those are recognized
 * as identifiers instead.
 *
 * A Git host's name is on the list for the same reason a database's is. The
 * shared external-effect boundary exists so that any Git host can be adapted to
 * it, and the first adapter naming itself in a shared contract is how a neutral
 * surface quietly becomes one provider's.
 *
 * `Forge` is here for a different reason: it is the retired product noun this
 * boundary was developed under, and #297's correction leaves no alias, no
 * durable `forge_effect`, and no forwarding module behind. The scan reads code
 * with comments stripped, so ordinary English — a token that cannot be forged —
 * is not this vocabulary and is not what this refuses.
 */
const FORBIDDEN = [
  "GitHub",
  "github",
  "Forge",
  "forge_effect",
  "workflow.forge",
  "src/forge/",
  "DatabaseSync",
  "SQLite",
  "sqlite",
  "Cloudflare",
  "DOFS",
  "dofs",
  "savepoint",
  "Savepoint",
  "SAVEPOINT",
  "RunConnection",
  "WorkflowRunConnections",
  "WorkflowRunTransactionToken",
  "ConnectionGeneration",
  "TransactionIdentity",
];

/**
 * The names this repository gives a runtime-specific entry point.
 *
 * Code Rule 12 puts host behavior behind runtime-named modules —
 * `packages/cli/src/{deno,node,bun,compiled}.ts` are the CLI's — so the name of
 * the module is what says a host owns it. `deno` is not the only one, and an
 * adapter rule that knows only `deno` is a rule about the adapter someone
 * happened to write first.
 */
const RUNTIMES = ["deno", "node", "bun", "compiled", "cloudflare", "workerd"];

/**
 * Globals only one host provides.
 *
 * `crypto`, `TextEncoder` and the rest of the cross-runtime Web surface are
 * not here: naming a standard is not naming a host.
 */
const HOST_GLOBALS = [
  "process",
  "Deno",
  "Bun",
  "Buffer",
  "globalThis",
  "navigator",
  "__dirname",
  "__filename",
];

/**
 * A module specifier only one host can resolve.
 *
 * Named by shape rather than one at a time: a list of the host modules anyone
 * thought of is a list of the ones that had already been noticed, and the
 * import that crosses this boundary next is the one nobody wrote down.
 *
 * Segments are compared whole. `nodes/`, `bundle.ts` and `vendors/` contain a
 * runtime's name without being one, and rejecting them would make the rule
 * about spelling rather than about hosts.
 */
function hostModule(specifier: string): boolean {
  if (/^(node|bun|deno|cloudflare|workerd):/.test(specifier)) {
    return true;
  }
  if (specifier === "@effectionx/process") {
    return true;
  }
  const segments = specifier.split("/");
  const last = segments[segments.length - 1].replace(/\.[cm]?[jt]sx?$/, "");
  return (
    segments.includes("vendor") ||
    segments.some((segment) => RUNTIMES.includes(segment)) ||
    RUNTIMES.includes(last)
  );
}

/**
 * Source with its comments removed.
 *
 * These modules describe in prose that they name no host, and a search of the
 * whole file would find that description rather than a boundary crossing.
 */
export function code(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const following = source[index + 1];
    if (character === "/" && following === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && following === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      output += character;
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") {
          output += source[index];
          index += 1;
        }
        output += source[index];
        index += 1;
      }
      output += character;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * What a module this file loads cannot be shown to be.
 *
 * A specifier the file computes names whatever it is handed, so no inspection
 * of this surface can say it is not a host module. It is refused rather than
 * skipped: a boundary that admits what it cannot read is not a boundary.
 */
export const COMPUTED = "a computed module specifier";

/**
 * Every module this source loads, read from the syntax rather than the text.
 *
 * Parsed, because module loading is not a pattern: a specifier can be a
 * template literal, can escape its own characters, can be an expression, and
 * the same characters can appear in a string that loads nothing. Each of those
 * is a different answer, and only a parse tells them apart.
 */
export function moduleSpecifiers(file: ts.SourceFile): string[] {
  const found: string[] = [];

  function record(node: ts.Node | undefined): void {
    if (
      node !== undefined &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      // The parser has already decoded escapes, so `node:crypto` and
      // `node:crypto` arrive here as the same specifier.
      found.push(node.text);
      return;
    }
    found.push(COMPUTED);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      record(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return found;
}

/**
 * The scanned source, and a checker that knows what its names mean.
 *
 * `noLib` and `noResolve` are the point rather than an economy: nothing
 * outside this file is loaded, so a name resolves only to what the file itself
 * declares. Anything left unresolved is ambient — supplied by a host at
 * runtime — which is exactly the question being asked.
 */
export function parse(source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const path = "/scanned.ts";
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const program = ts.createProgram({
    rootNames: [path],
    options: { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
    host: {
      getSourceFile: (name) => (name === path ? file : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => name === path,
      readFile: (name) => (name === path ? source : undefined),
    },
  });
  return { file, checker: program.getTypeChecker() };
}

/**
 * The slots in which the grammar writes a name rather than a reference.
 *
 * TypeScript spells the distinction structurally: an `IdentifierName` fills a
 * `name`, `propertyName` or `label` slot of the node that owns it, and a
 * qualified name's `right` is the same thing in type position. Everywhere else
 * an identifier is an `IdentifierReference`.
 */
const LABEL_SLOTS = ["name", "propertyName", "label"];

/**
 * Whether this identifier refers to a binding at all.
 *
 * Not a scope question — the checker answers those. This asks the grammar
 * instead of listing the node kinds someone remembered: the member in
 * `x.process`, the label in `break process`, the imported member in
 * `{ Deno as portable }`, the key in `{ process: local }`, a named tuple
 * element, an import attribute and every declaration's own name all fill a
 * name slot, and none of them reads the name it spells.
 *
 * A shorthand property is the one name slot that is also a read, because
 * `{ process }` declares a property and reads a binding with one identifier.
 */
function refers(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return true;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  return !LABEL_SLOTS.some((slot) => Reflect.get(parent, slot) === node);
}

/**
 * Host globals this source actually reads.
 *
 * A name is the host's only when nothing in this file declares it, and the
 * checker is what knows that. Value scopes and type scopes, `var` hoisting,
 * `import =`, `namespace`, mapped-type and `infer` type parameters, accessors
 * and shadowing are the language's rules, not a list kept here — every one of
 * them was a false positive while this was a list.
 */
function hostGlobals(parsed: { file: ts.SourceFile; checker: ts.TypeChecker }): string[] {
  const found: string[] = [];

  /**
   * The binding this identifier reads.
   *
   * `{ process }` writes one name in two roles: the property the literal
   * declares and the value it reads. The ordinary symbol is the property — it
   * is declared right there, so asking for it would answer that every host
   * global is locally declared the moment it is put in an object. The value
   * symbol is the one the shorthand refers to.
   */
  function binding(node: ts.Identifier): ts.Symbol | undefined {
    const parent = node.parent;
    if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      return parsed.checker.getShorthandAssignmentValueSymbol(parent);
    }
    return parsed.checker.getSymbolAtLocation(node);
  }

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && HOST_GLOBALS.includes(node.text) && refers(node)) {
      const declared = (binding(node)?.declarations ?? []).some(
        (declaration) => declaration.getSourceFile() === parsed.file,
      );
      if (!declared && !found.includes(node.text)) {
        found.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed.file);
  return found;
}

export function forbiddenNames(source: string): string[] {
  const parsed = parse(source);
  const scanned = code(source);
  const crossings = FORBIDDEN.filter((name) => scanned.includes(name));
  for (const global of hostGlobals(parsed)) {
    if (!crossings.includes(global)) {
      crossings.push(global);
    }
  }
  for (const specifier of moduleSpecifiers(parsed.file)) {
    const refused = specifier === COMPUTED || hostModule(specifier);
    if (refused && !crossings.includes(specifier)) {
      crossings.push(specifier);
    }
  }
  return crossings;
}
