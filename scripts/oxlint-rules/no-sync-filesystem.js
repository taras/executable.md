/**
 * `local/no-sync-filesystem` — the filesystem is somebody else's turn.
 *
 * Effection runs every operation in this repository on one interpreter. A
 * synchronous filesystem call holds that interpreter for the whole duration of
 * the call, so nothing else in the process observes a cancellation, runs a
 * destructor, or makes progress until the host returns. For a single small
 * read that is invisible. For work proportional to a checkout — a recursive
 * export, a tree walk, an import of every byte a clone produced — it is the
 * difference between a run that stops when asked and a run that finishes what
 * it started first.
 *
 * So the rule reports synchronous filesystem work and directs the author to
 * the asynchronous form: the matching `@effectionx/fs` operation where that
 * package has one, and a runtime-specific asynchronous capability expressed as
 * an Effection operation where it does not.
 *
 * Recognition is by binding, not by spelling. A name ending in `Sync` says
 * nothing on its own — `outputSync`, `transactionSync` and `processSync` are
 * not filesystem calls, and an `exampleSync()` a module declares itself is
 * whatever that module made it. What the rule resolves instead is:
 *
 * - a filesystem member of the `Deno` global, reached as `Deno` or as
 *   `globalThis.Deno`, covering files, directories, links, metadata,
 *   canonical paths, temporary paths and descriptors;
 * - a synchronous member of `Deno.stdin`, `Deno.stdout` or `Deno.stderr`, and
 *   of a descriptor a `Deno.openSync` or `Deno.createSync` call bound directly;
 * - anything imported from `node:fs`, whether as a named import, an aliased
 *   named import, or a member of a default or namespace import; and
 * - the synchronous filesystem functions the vendored Cloudflare DOFS
 *   filesystem exports, which are the repository's own equivalents.
 *
 * A member may be named by a string literal — `fs["readFileSync"]` reads the
 * same binding `fs.readFileSync` does.
 *
 * Identifiers are resolved through the scope they appear in, so a parameter or
 * a local declaration wearing an imported name is a different value and is
 * accepted, as is a `Deno` of somebody's own. Type-only imports bind no value
 * and are accepted. `node:fs/promises` is the destination, not the problem.
 *
 * The exception is narrow. Synchrony is allowed to remain only where losing it
 * would lose a correctness property — acquiring a resource and registering its
 * cleanup with no suspension between them, a byte sink the process's output
 * would fall behind, or mutating a path synchronously because the test is about
 * what happens when nothing yields. Such a site carries an
 * `oxlint-disable-next-line local/no-sync-filesystem` on the line above it and
 * a comment naming the invariant. A file-wide or directory-wide exemption
 * states no invariant and is not one of these; because Oxlint suppresses a
 * rule's own diagnostics inside a disabled range, that form is rejected by the
 * directive audit in `scripts/tests/no-sync-filesystem.test.ts` rather than
 * here.
 */
const NODE_FS = new Set(["fs", "node:fs"]);

const DOFS = "vendor/cloudflare-computer-dofs/generated/fs/";

/** Filesystem members of the `Deno` global, by the surface each one touches. */
const DENO_MEMBERS = new Set([
  "chmodSync",
  "chownSync",
  "copyFileSync",
  "createSync",
  "lstatSync",
  "linkSync",
  "makeTempDirSync",
  "makeTempFileSync",
  "mkdirSync",
  "openSync",
  "readDirSync",
  "readFileSync",
  "readLinkSync",
  "readTextFileSync",
  "realPathSync",
  "removeSync",
  "renameSync",
  "statSync",
  "symlinkSync",
  "truncateSync",
  "utimeSync",
  "writeFileSync",
  "writeTextFileSync",
]);

/** The `Deno` members that are descriptors rather than operations. */
const DENO_STDIO = new Set(["stdin", "stdout", "stderr"]);

/** The `Deno` calls whose result a binding can hold as a descriptor. */
const DENO_OPENERS = new Set(["openSync", "createSync"]);

/** Synchronous members of a Deno file descriptor. */
const DESCRIPTOR_MEMBERS = new Set([
  "lockSync",
  "readSync",
  "seekSync",
  "statSync",
  "syncDataSync",
  "syncSync",
  "truncateSync",
  "unlockSync",
  "utimeSync",
  "writeSync",
]);

/** The synchronous exports of `node:fs`. */
const NODE_MEMBERS = new Set([
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "globSync",
  "lchmodSync",
  "lchownSync",
  "linkSync",
  "lstatSync",
  "lutimesSync",
  "mkdirSync",
  "mkdtempSync",
  "opendirSync",
  "openSync",
  "readFileSync",
  "readSync",
  "readdirSync",
  "readlinkSync",
  "readvSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "statfsSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "writeSync",
  "writevSync",
]);

/** The synchronous filesystem functions the vendored DOFS filesystem exports. */
const DOFS_MEMBERS = new Set([
  "createFileSync",
  "openWriteBufferForCreateSync",
  "openWriteBufferSync",
  "readRangeSync",
  "releaseWriteBufferSync",
  "truncateFileSync",
  "writeFileRangesSync",
  "writeFileSync",
  "writeRangeSync",
]);

/** The member set a module specifier's synchronous filesystem surface belongs to, or null. */
function surfaceOf(source) {
  if (NODE_FS.has(source)) {
    return NODE_MEMBERS;
  }

  if (source.includes(DOFS)) {
    return DOFS_MEMBERS;
  }

  return null;
}

/** The property a member expression reads, whether named or spelled out. */
function memberName(node) {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }

  return typeof node.property.value === "string" ? node.property.value : null;
}

/** Whether a specifier's declaration binds a value rather than a type. */
function bindsValue(specifier, declaration) {
  return declaration.importKind !== "type" && specifier.importKind !== "type";
}

export const noSyncFilesystem = {
  meta: {
    type: "problem",
    messages: {
      forbidden:
        "{{name}} blocks the Effection interpreter for the length of the filesystem call. Use the matching @effectionx/fs operation, or a runtime-specific asynchronous capability expressed as an Effection operation when that package has no equivalent.",
    },
  },

  create(context) {
    const source = context.sourceCode;
    const reports = [];

    /** The declaration an identifier resolves to, or null when it names a global. */
    function variableOf(node) {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const found = scope.variables.find((variable) => variable.name === node.name);

        if (found) {
          return found;
        }
      }

      return null;
    }

    /**
     * Whether an identifier still names what the host put there. The scope
     * manager records an unresolved reference as a global variable carrying no
     * definition, so a declaration of its own is what makes a name somebody's.
     */
    function isGlobal(node, name) {
      if (node.type !== "Identifier" || node.name !== name) {
        return false;
      }

      const variable = variableOf(node);
      return variable === null || variable.defs.length === 0;
    }

    /** Whether `node` is the `Deno` global rather than somebody's own binding. */
    function isDenoGlobal(node) {
      if (node.type === "MemberExpression") {
        return memberName(node) === "Deno" && isGlobal(node.object, "globalThis");
      }

      return isGlobal(node, "Deno");
    }

    /** What an identifier's declaration makes it, among the sources the rule knows. */
    function bindingOf(node) {
      if (node.type !== "Identifier") {
        return null;
      }

      const variable = variableOf(node);

      if (!variable) {
        return null;
      }

      for (const definition of variable.defs) {
        if (definition.type === "ImportBinding") {
          const members = surfaceOf(definition.parent.source.value);

          if (!members || !bindsValue(definition.node, definition.parent)) {
            continue;
          }

          if (definition.node.type === "ImportSpecifier") {
            return members.has(definition.node.imported.name)
              ? { kind: "operation", name: definition.node.imported.name }
              : null;
          }

          return { kind: "namespace", members };
        }

        // A descriptor is whatever the opener returned, so the binding has to
        // hold that call directly for the rule to know what it is.
        const initializer = definition.node?.init;

        if (
          initializer?.type === "CallExpression" &&
          initializer.callee.type === "MemberExpression" &&
          isDenoGlobal(initializer.callee.object) &&
          DENO_OPENERS.has(memberName(initializer.callee) ?? "")
        ) {
          return { kind: "descriptor" };
        }
      }

      return null;
    }

    function report(node, name) {
      reports.push({ node, messageId: "forbidden", data: { name } });
    }

    return {
      MemberExpression(node) {
        const name = memberName(node);

        if (!name) {
          return;
        }

        if (isDenoGlobal(node.object)) {
          if (DENO_MEMBERS.has(name)) {
            report(node, `Deno.${name}`);
          }
          return;
        }

        // `Deno.stdout.writeSync` and friends: a descriptor the global exposes.
        if (
          node.object.type === "MemberExpression" &&
          isDenoGlobal(node.object.object) &&
          DENO_STDIO.has(memberName(node.object) ?? "") &&
          DESCRIPTOR_MEMBERS.has(name)
        ) {
          report(node, `Deno.${memberName(node.object)}.${name}`);
          return;
        }

        const binding = bindingOf(node.object);

        if (binding?.kind === "namespace" && binding.members.has(name)) {
          report(node, `${node.object.name}.${name}`);
          return;
        }

        if (binding?.kind === "descriptor" && DESCRIPTOR_MEMBERS.has(name)) {
          report(node, `${node.object.name}.${name}`);
        }
      },

      CallExpression(node) {
        const binding = bindingOf(node.callee);

        if (binding?.kind === "operation") {
          report(node.callee, binding.name);
        }
      },

      "Program:exit"() {
        // An import is not necessarily the first statement, so a call can be
        // visited before the declaration that names its binding.
        reports.sort((left, right) => left.node.range[0] - right.node.range[0]);

        for (const entry of reports) {
          context.report(entry);
        }
      },
    };
  },
};
