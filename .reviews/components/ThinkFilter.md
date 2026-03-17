---
inputs: {}
---

```ts persist eval
import { remark } from "npm:remark@15";
import remarkMdx from "npm:remark-mdx@3";
import { visit } from "npm:unist-util-visit@5";

yield* Sample.around({
  *sample([context], next) {
    const result = yield* next(context);
    const file = yield* call(() =>
      remark()
        .use(remarkMdx)
        .use(() => (tree) => {
          visit(tree, (node, index, parent) => {
            if (
              (node.type === "mdxJsxFlowElement" ||
                node.type === "mdxJsxTextElement") &&
              node.name === "think"
            ) {
              parent.children.splice(index, 1);
              return index;
            }
          });
        })
        .process(result)
    );
    return String(file).trim();
  },
});
```

<Content />
