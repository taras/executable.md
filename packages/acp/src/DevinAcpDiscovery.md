# Discovering Devin's ACP session boundary

Executable.md can already initialize `devin acp` through ACPX's narrow
Windsurf compatibility shim. What it cannot yet know is when Devin's backend
has accepted the first turn and which provider identity names the conversation
that accepted it.

This document spends one real Devin turn and records the shape and order of the
ACP exchange around it. It replaces request identifiers and session identifiers
with stable local tokens and retains no prompt text, model text, paths,
environment values, credentials, raw stderr, or raw identifiers. The known
prompt asks only for the fixed text `DEVIN-ACP-DISCOVERY-OK` and runs with every
tool permission denied.

The trace identifies candidates for these architecture questions:

- which notification or response could explicitly report that Devin accepted
  the turn;
- whether that evidence arrives before anything produced by the turn;
- whether Devin reports a provider-native session identity distinct from the
  ACP session identifier;
- which metadata namespaces Devin sends on session creation, updates, and the
  completed prompt; and
- whether ACPX supplied the required Windsurf client identity and handled
  Devin's extension traffic.

It does not prove native `Session.Launch`. That requires a second, interactive
gate for Devin's native create or resume command, prepared instruction layer,
zero-turn exit, and continuity after a separate invocation.

One successful trace is discovery evidence, not an acceptance proof. A
candidate signal still needs paired failed and cancelled turns showing that it
is absent when the backend did not accept the turn before XMD can translate it
into durable session materialization.

## Cost and authorization

The discovery is opt-in twice. Without `XMD_DEVIN_ACP_DISCOVERY=1`, no Devin
process starts. Without the separate
`XMD_DEVIN_MODEL_TURNS_AUTHORIZED=1`, no model turn starts. Run it without a
journal: the rendered report already contains everything intended for review,
while a journal adds process bookkeeping and cannot reveal the acceptance event
that the provider did not publish.

```sh
XMD_DEVIN_ACP_DISCOVERY=1 XMD_DEVIN_MODEL_TURNS_AUTHORIZED=1 \
  deno task xmd run packages/acp/src/DevinAcpDiscovery.md --raw
```

If `devin` is not on `PATH`, supply its exact executable path as
`XMD_DEVIN_EXECUTABLE`. The value is used only to start the process and has no
field in the report.

Run this document from the root of a prepared Executable.md checkout. One
command prepares both dependency layouts and the browser bundle:

```sh
deno task setup
```

The checked-in helper uses the repository's pinned ACPX runtime and dependency
graph. It downloads nothing of its own and leaves registry and certificate
configuration entirely with the repository setup.

## Running the probe

The helper owns only the transparent process relay and filtered protocol
observation that Markdown cannot express. A nonzero exit means the helper
itself failed; a Devin refusal is returned inside the structured verdict.

```sh timeout=7min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/devin-acp-discovery.ts
```

<If condition={run.exitCode !== 0}>
<Fail message="The Devin discovery helper failed before it could return a structured verdict." />
</If>

<Let as="verdictSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema", "verdict", "authorized", "ran", "refusal", "detail",
    "devinVersion", "platform", "architecture", "modelTurns",
    "runtimeStatus", "stopReason", "replyExact",
    "agentSessionIdentityReported", "journalSufficient", "trace",
    "privateContentReported"
  ],
  "properties": {
    "schema": { "const": "devin-acp-discovery.v1" },
    "verdict": {
      "enum": ["PASS", "REFUSED", "ENVIRONMENT_BLOCKED", "PRODUCT_FAILED"]
    },
    "authorized": { "type": "boolean" },
    "ran": { "type": "boolean" },
    "refusal": { "type": "string" },
    "detail": { "type": "string" },
    "devinVersion": { "type": "string" },
    "platform": { "type": "string" },
    "architecture": { "type": "string" },
    "modelTurns": { "type": "integer", "minimum": 0, "maximum": 1 },
    "runtimeStatus": { "type": "string" },
    "stopReason": { "type": "string" },
    "replyExact": { "type": "boolean" },
    "agentSessionIdentityReported": { "type": "boolean" },
    "journalSufficient": { "const": false },
    "privateContentReported": { "const": false },
    "trace": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schema", "entries", "nonJsonLines", "agentStderr", "agentExit"],
      "properties": {
        "schema": { "const": "devin-acp-wire.v1" },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["sequence", "direction", "kind"],
            "properties": {
              "sequence": { "type": "integer" },
              "direction": { "enum": ["client-to-agent", "agent-to-client"] },
              "kind": { "enum": ["request", "response", "notification", "unknown"] },
              "rpc": { "type": "string" },
              "method": { "type": "string" },
              "parameterKeys": { "type": "array", "items": { "type": "string" } },
              "resultKeys": { "type": "array", "items": { "type": "string" } },
              "errorCode": { "type": "string" },
              "stopReason": { "type": "string" },
              "sessionUpdate": { "type": "string" },
              "metadata": {
                "type": "object",
                "additionalProperties": {
                  "type": "array",
                  "items": { "type": "string" }
                }
              },
              "identities": {
                "type": "object",
                "additionalProperties": { "type": "string" }
              },
              "clientInfo": {
                "type": "object",
                "additionalProperties": false,
                "required": ["name", "version"],
                "properties": {
                  "name": { "type": "string" },
                  "version": { "type": "string" }
                }
              }
            },
            "additionalProperties": false
          }
        },
        "nonJsonLines": {
          "type": "object",
          "additionalProperties": false,
          "required": ["clientToAgent", "agentToClient"],
          "properties": {
            "clientToAgent": { "type": "integer" },
            "agentToClient": { "type": "integer" }
          }
        },
        "agentStderr": {
          "type": "object",
          "additionalProperties": false,
          "required": ["bytes", "classification"],
          "properties": {
            "bytes": { "type": "integer" },
            "classification": { "type": "string" }
          }
        },
        "agentExit": {
          "type": "object",
          "additionalProperties": false,
          "required": ["code", "signal"],
          "properties": {
            "code": { "type": "integer" },
            "signal": { "type": "string" }
          }
        }
      }
    }
  }
}
```

</Let>

<Parse schema={verdictSchema} as="proof">
{run.stdout}
</Parse>

## What the run found

The report below is the complete disclosure surface. It is safe to attach to an
architecture issue: identifiers are relational tokens, content is absent, and
stderr is represented only by byte count and a broad classification.

```json
{run.stdout}
```

<If condition={proof.journalSufficient}>
<Fail message="The discovery incorrectly claimed that an XMD journal contains the ACP acceptance evidence." />
</If>

<If condition={proof.privateContentReported}>
<Fail message="The discovery report crossed its private-content disclosure boundary." />
</If>

<If condition={proof.ran}>

The probe contacted Devin and captured {proof.trace.entries.length} filtered ACP
messages while spending exactly {proof.modelTurns} turn.

<If condition={proof.modelTurns !== 1}>
<Fail message="A live discovery must spend exactly one authorized model turn." />
</If>

<Else>

No Devin process was contacted and no model turn was spent. The refusal above
names the missing authorization or environment prerequisite.

<If condition={proof.modelTurns !== 0}>
<Fail message="A refused discovery must spend no model turns." />
</If>

</Else>
</If>
