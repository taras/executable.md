import Babel from "@babel/standalone";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Plugin = Extract<
  NonNullable<Parameters<typeof Babel.transform>[1]["plugins"]>[number],
  (...args: never[]) => unknown
>;

/** Emit an ordinary ES module without reading compiler configuration. */
export function componentSource(
  source: string,
  origin: string,
  resolve?: (specifier: string) => string,
): string {
  const typed = Babel.transform(source, {
    filename: fileURLToPath(origin),
    sourceFileName: origin,
    sourceType: "module",
    envName: "production",
    presets: [["typescript", { onlyRemoveTypeImports: true }]],
    sourceMaps: true,
  });
  if (typed?.code === undefined || typed.code === null) {
    throw new Error("TypeScript component transformation produced no module");
  }
  const plugin: Plugin = (api) => {
    const { types: t, template } = api;
    let metadata: Babel.packages.types.Identifier;
    let resolver: Babel.packages.types.Identifier;
    let specifier: Babel.packages.types.Identifier;
    return {
      visitor: {
        Program: {
          enter(path) {
            metadata = path.scope.generateUidIdentifier("componentMeta");
            resolver = path.scope.generateUidIdentifier("componentImport");
            specifier = path.scope.generateUidIdentifier("componentSpecifier");
          },
          exit(path) {
            if (resolve === undefined) {
              path.node.body.unshift(
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.memberExpression(
                      t.metaProperty(t.identifier("import"), t.identifier("meta")),
                      t.identifier("url"),
                    ),
                    t.stringLiteral(origin),
                  ),
                ),
              );
              return;
            }
            const nativeResolve = path.scope.generateUidIdentifier("resolveSync");
            const toURL = path.scope.generateUidIdentifier("pathToFileURL");
            const absolute = path.scope.generateUidIdentifier("isAbsolute");
            const require = path.scope.generateUidIdentifier("createRequire");
            const filename = fileURLToPath(origin);
            const injected = template.program.ast(`
                import { resolveSync as ${nativeResolve.name} } from "bun";
                import { pathToFileURL as ${toURL.name} } from "node:url";
                import { isAbsolute as ${absolute.name} } from "node:path";
                import { createRequire as ${require.name} } from "node:module";
                const ${resolver.name} = (input) => {
                  const resolved = ${nativeResolve.name}(\`\${input}\`, ${JSON.stringify(dirname(filename))});
                  return ${absolute.name}(resolved) ? ${toURL.name}(resolved).href : resolved;
                };
                const ${specifier.name} = (input) => ({
                  [Symbol.toPrimitive]: () => ${resolver.name}(input)
                });
                const ${metadata.name} = Object.assign(Object.create(null), import.meta, {
                  url: ${JSON.stringify(origin)}, filename: ${JSON.stringify(filename)},
                  dirname: ${JSON.stringify(dirname(filename))}, path: ${JSON.stringify(filename)},
                  dir: ${JSON.stringify(dirname(filename))}, file: ${JSON.stringify(basename(filename))},
                  main: false, require: ${require.name}(${JSON.stringify(origin)}),
                  resolve: (input, parent) => parent === undefined ? ${resolver.name}(input) :
                    (() => { const value = ${nativeResolve.name}(input, parent); return ${absolute.name}(value) ? ${toURL.name}(value).href : value; })(),
                  resolveSync: (input, parent = ${JSON.stringify(dirname(filename))}) => ${nativeResolve.name}(input, parent)
                });
              `);
            path.node.body.unshift(...injected.body);
          },
        },
        ImportDeclaration(path) {
          if (resolve !== undefined) {
            path.node.source.value = resolve(path.node.source.value);
          }
        },
        ExportNamedDeclaration(path) {
          if (resolve !== undefined && path.node.source != null) {
            path.node.source.value = resolve(path.node.source.value);
          }
        },
        ExportAllDeclaration(path) {
          if (resolve !== undefined) {
            path.node.source.value = resolve(path.node.source.value);
          }
        },
        ImportExpression(path) {
          if (resolve !== undefined) {
            // Native import coerces the specifier after evaluating its options,
            // and turns coercion/resolution failures into promise rejections.
            path.node.source = t.callExpression(t.cloneNode(specifier), [path.node.source]);
          }
        },
        CallExpression(path) {
          if (resolve !== undefined && t.isImport(path.node.callee)) {
            const argument = path.node.arguments[0];
            if (t.isExpression(argument)) {
              path.node.arguments[0] = t.callExpression(t.cloneNode(specifier), [argument]);
            }
          }
        },
        MetaProperty(path) {
          if (resolve !== undefined && path.node.meta.name === "import") {
            path.replaceWith(t.cloneNode(metadata));
          }
        },
        ReferencedIdentifier(path) {
          if (
            resolve !== undefined &&
            path.node.name === "require" &&
            !path.scope.hasBinding("require")
          ) {
            path.replaceWith(t.memberExpression(t.cloneNode(metadata), t.identifier("require")));
          }
        },
      },
    };
  };
  const transformed = Babel.transform(typed.code, {
    filename: fileURLToPath(origin),
    sourceFileName: origin,
    sourceType: "module",
    envName: "production",
    sourceMaps: true,
    ...(typed.map == null
      ? {}
      : {
          inputSourceMap: {
            file: fileURLToPath(origin),
            version: typed.map.version,
            names: [...typed.map.names],
            sources: typed.map.sources.map((value) => value ?? ""),
            mappings: typed.map.mappings,
            ...(typed.map.sourcesContent == null
              ? {}
              : { sourcesContent: typed.map.sourcesContent.map((value) => value ?? "") }),
          },
        }),
    plugins: [plugin],
  });
  if (transformed?.code === undefined || transformed.code === null) {
    throw new Error("TypeScript component transformation produced no module");
  }
  const map = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(transformed.map)), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
  return `${transformed.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${map}`;
}
