import { noModuleScopedRegistry } from "./oxlint-rules/no-module-scoped-registry.js";
import { noRedundantTestScope } from "./oxlint-rules/no-redundant-test-scope.js";
import { noSectionDividerComments } from "./oxlint-rules/no-section-divider-comments.js";
import { noSyncFilesystem } from "./oxlint-rules/no-sync-filesystem.js";
import { noYieldInFinally } from "./oxlint-rules/no-yield-in-finally.js";
import { preferEffectionOperation } from "./oxlint-rules/prefer-effection-operation.js";
import { preferEffectionResult } from "./oxlint-rules/prefer-effection-result.js";
import { requireScopeBoundEventRegistration } from "./oxlint-rules/require-scope-bound-event-registration.js";

export default {
  meta: { name: "executablemd" },
  rules: {
    "no-module-scoped-registry": noModuleScopedRegistry,
    "no-section-divider-comments": noSectionDividerComments,
    "no-redundant-test-scope": noRedundantTestScope,
    "no-sync-filesystem": noSyncFilesystem,
    "no-yield-in-finally": noYieldInFinally,
    "prefer-effection-operation": preferEffectionOperation,
    "prefer-effection-result": preferEffectionResult,
    "require-scope-bound-event-registration": requireScopeBoundEventRegistration,
  },
};
