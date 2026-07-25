import { noRedundantTestScope } from "./oxlint-rules/no-redundant-test-scope.js";
import { noSectionDividerComments } from "./oxlint-rules/no-section-divider-comments.js";

export default {
  meta: { name: "executablemd" },
  rules: {
    "no-section-divider-comments": noSectionDividerComments,
    "no-redundant-test-scope": noRedundantTestScope,
  },
};
