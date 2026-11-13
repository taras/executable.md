interface DocumentSuite {
  worker?: true;
  shim?: "syntax" | "verbose";
  deadline?: number;
}

/** The documents whose TypeScript launchers used the ordinary CLI profile. */
export const DOCUMENT_SUITES: ReadonlyMap<string, DocumentSuite> = new Map([
  ["packages/cli/tests/document-suites/evaluate/Evaluate.test.md", {}],
  ["packages/cli/tests/document-suites/inline/Inline.test.md", {}],
  ["packages/cli/tests/document-suites/plan/Plan.test.md", { worker: true }],
  ["packages/cli/tests/document-suites/props/Props.test.md", {}],
  ["packages/cli/tests/document-suites/syntax/Syntax.test.md", { shim: "syntax" }],
  ["packages/cli/tests/document-suites/targets/Targets.test.md", {}],
  ["packages/cli/tests/document-suites/verbose/Verbose.test.md", { shim: "verbose" }],
  ["packages/test-agent/src/SessionConfiguration.test.md", { worker: true, deadline: 120_000 }],
]);
