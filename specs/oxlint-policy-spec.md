# Specification: Oxlint Policy

**Scope**: the repository's built-in Oxlint policy and the gate profile
`deno task lint` runs.

---

## 1. One shared policy, one gate profile

`oxlint.shared.json` at the repository root is the project's whole built-in
Oxlint policy: plugins, categories, the advisory warnings, the denials and the
shared test override. `.oxlintrc.json` is the gate. It names the shared policy
through a native JSON `extends` path resolved relative to its own location, and
adds the local JavaScript plugin, the blocking rules and one further test
override:

```text
oxlint.shared.json   plugins, categories, warnings, denials, test override
└── .oxlintrc.json   gate: local JavaScript plugin and blocking rules
```

The gate declares no built-in rule or category of its own. Oxlint merges from
first to last and the later configuration wins, so a gate entry for an inherited
rule would override it; `scripts/tests/oxlint-policy.test.ts` fails if one
appears.

The gate repeats `"plugins"` because Oxlint reads the plugin set from the entry
configuration alone: an inherited list adds to Oxlint's defaults rather than
replacing them. `oxlint.shared.json` is deliberately not a name Oxlint
discovers on its own, so the file is reachable only through the explicit
`extends`.

```jsonc
// .oxlintrc.json
{
  "extends": ["./oxlint.shared.json"],
  "plugins": ["typescript", "unicorn", "import"],
  "jsPlugins": [{ "name": "local", "specifier": "./scripts/oxlint-plugin.js" }],
  "rules": {
    "eslint/curly": "error",
    "local/no-banned-jsdoc-words": "error",
    "local/no-module-scoped-registry": "error",
    "local/no-section-divider-comments": "error",
    "local/no-sync-filesystem": "error",
    "local/no-yield-in-finally": "error",
    "local/prefer-effection-operation": "error",
    "local/prefer-effection-result": "error",
    "local/require-scope-bound-event-registration": "error"
  },
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/tests/**"],
      "rules": { "local/no-redundant-test-scope": "error" }
    }
  ]
}
```

Oxlint merges inherited override arrays, so the shared test override and the
gate's both apply to test files.

Every local rule belongs to the gate. `local/no-sync-filesystem` is the one
whose escape hatch is itself part of the contract: the only accepted
suppression is a single `oxlint-disable-next-line` carrying an adjacent comment
that names the invariant a suspension would break, and no configuration
override, file-wide directive, or unexplained directive is allowed. Oxlint
suppresses a rule's own diagnostics inside a disabled range, so a rule cannot
report a file-wide disable of itself; `scripts/tests/no-sync-filesystem.test.ts`
audits the configuration and every linted source for that contract instead.

## 2. Rule catalog

The `correctness` and `suspicious` categories are the project-compatible
baseline, at `"warn"`. `pedantic` and `style` are off.

Fourteen rules are enabled one at a time at `"warn"`. They are advisory: the
gate fails on errors, and none of them is an error. Ten need only syntax —
`no-unused-vars` (with `_`-prefixed names ignored), `no-inferrable-types`,
`no-empty-function`, `no-empty-object-type`, `no-useless-empty-export`,
`no-unnecessary-type-constraint`,
`no-unnecessary-parameter-property-assignment`, `no-static-only-class`,
`no-console` (allowing `warn` and `error`) and `no-debugger`. Four —
`no-unnecessary-type-assertion`, `no-redundant-type-constituents`,
`no-unnecessary-type-arguments` and `no-unnecessary-boolean-literal-compare` —
need type information and report only under `--type-aware`, which the lint task
does not pass. The shared test override turns `no-console` and
`no-empty-function` off for test files.

The filename-case, named-export, export-order, function-style, generator-yield,
import-order, key-order, magic-number, and readonly-parameter rules conflict
with the repository's component and generator conventions, and each stays
explicitly `off` so a future category reclassification cannot revive it
silently. The unsafe-access, caught-error, and duplicate-import rules are named
candidates that stay off until adopted individually; no broad category is ever
enabled to obtain one desired rule.

## 3. Toolchain pin

Oxlint is pinned to one exact version in both `deno.json` and `package.json`,
and the binary the gate executes reports that version. Its optional type-aware
backend, `oxlint-tsgolint`, is pinned exactly in `deno.json`. The pins are exact
rather than caret ranges: a range plus a frozen lock would let a routine lock
refresh expand the active rule set, and a policy upgrade is meant to be an
explicit act.

## 4. Test plan

`scripts/tests/oxlint-policy.test.ts` runs under Deno, Node, and Bun. It reads
the configuration sources and executes `oxlint --print-config` against a
production module and a test module.

| # | Test | Verify |
|---|------|--------|
| OP1 | Canonical shared policy | The gate's `extends` resolves to `oxlint.shared.json` |
| OP2 | Catalog ownership | Shared owns plugins, categories, denials and the test override; the gate repeats none of it |
| OP3 | Inheritance resolves | `--print-config` succeeds on both paths |
| OP4 | Denials hold | Every conflict and named candidate is off in the merged gate |
| OP5 | Gate blocking rules | `curly` and the local rules stay errors |
| OP6 | Overrides survive | Both test overrides reach the gate |
| OP7 | Override applies | A `tests/` file reports no `no-console`; its sibling does |
| OP8 | Version agreement | `deno.json`, `package.json`, and the executed binary name one version |
| OP9 | Broken inheritance | A missing inherited file fails the invocation instead of printing an empty policy |
