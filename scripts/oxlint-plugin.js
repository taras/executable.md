import { noRedundantTestScope } from "./oxlint-rules/no-redundant-test-scope.js";
import { noSectionDividerComments } from "./oxlint-rules/no-section-divider-comments.js";
import { noYieldInFinally } from "./oxlint-rules/no-yield-in-finally.js";

export default {
  meta: { name: "executablemd" },
  rules: {
    "no-section-divider-comments": noSectionDividerComments,
    "no-redundant-test-scope": noRedundantTestScope,
    "no-yield-in-finally": noYieldInFinally,
  },
};
