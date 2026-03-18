// deno-lint-ignore-file no-explicit-any
const plugin: Deno.lint.Plugin = {
  name: "no-scheme-specifiers",
  rules: {
    "no-scheme-specifiers": {
      create(context) {
        function checkSource(
          node: any,
        ) {
          if (!node.source) return;
          const source = node.source.value;
          if (
            typeof source === "string"
            && (source.startsWith("jsr:")
              || source.startsWith("npm:"))
          ) {
            const bare = source
              .replace(/^jsr:/, "")
              .replace(/^npm:/, "")
              .replace(/@[\d^~>=<.*]+$/, "");

            context.report({
              node: node.source,
              message:
                `Use bare specifier "${bare}" instead of `
                + `"${source}". Add "${bare}": "${source}" `
                + `to deno.json "imports".`,
              fix(fixer) {
                return fixer.replaceText(
                  node.source,
                  `"${bare}"`,
                );
              },
            });
          }
        }

        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
        };
      },
    },
  },
};

export default plugin;
