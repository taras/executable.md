---
description: >-
  Run one phase attempt, preserve the raw reply and return its validated result. Use <Phase.Run
  phase="review" role="architect" session="ticket-architect" assignment={prepared.assignment}
  attempt="/private/tmp/ticket/review-1" nextRole="planner" as="result" />.
props:
  type: object
  properties:
    phase:
      enum:
        - discovery
        - implementation
        - review
    role:
      enum:
        - architect
        - planner
        - implementor
    session:
      type: string
      minLength: 1
    inputs:
      type: array
      items: {type: object}
      default: []
    responseProfile:
      type: object
      properties:
        kind: {enum: [phase, ticket, delivery-editorial]}
        knownDocuments: {type: array, items: {type: string}}
        establishedPath: {type: string}
        appliedPath: {type: string}
      required: [kind, knownDocuments]
      additionalProperties: false
      default: {kind: phase, knownDocuments: []}
    assignment:
      type: object
    attempt:
      type: string
      minLength: 1
    initialize:
      type: boolean
      default: false
    implementationProvider:
      enum: [claude, codex]
      default: claude
    nextRole:
      anyOf:
        - enum: [architect, planner, implementor]
        - type: 'null'
      default: null
    successor:
      anyOf:
        - enum:
            - discovery
            - implementation
            - review
            - ready
        - type: 'null'
      default: null
  required:
    - phase
    - role
    - session
    - assignment
    - attempt
  additionalProperties: false
returns:
  type: object
---

<If condition={(props.phase === "implementation") !== (props.role === "implementor")}>
<Fail message="Implementation uses its Implementor; Discovery and Review use their Architect or Planner." />
</If>
<If condition={props.responseProfile.kind === "delivery-editorial"}>
<Fail message="PR and issue metadata belong to the Sidekick running Codex. Do not dispatch an editorial assignment to a workflow role." />
</If>
<Phase.Schema as="schemas" />
<Parse schema={schemas.assignment} as="parsed"><Json value={props.assignment} /></Parse>
<ReviewPolicy assessment={parsed.assessment} kind={parsed.reviewKind ?? "feature"} as="policy" />
<SafeParse schema={schemas.result} as="schemaPrepared"><Json value={{}} /></SafeParse>
<Let as="successor" value={props.successor ?? parsed.continuation?.phase ?? (parsed.phase === "discovery" ? "discovery" : "review")} />
<Let as="nextRole" value={successor === "implementation" ? "implementor" : successor === "ready" ? null : props.nextRole ?? parsed.continuation?.role ?? null} />
<If condition={!["discovery","implementation","review","ready"].includes(successor) || props.nextRole !== null && props.nextRole !== nextRole}>
<Fail message="The selected next phase and role are incompatible. Preserve the assignment and select one required gate." />
</If>
<If condition={(successor === "discovery" || successor === "review") && nextRole !== "architect" && nextRole !== "planner"}>
<Fail message="Select nextRole=architect or nextRole=planner for the next required gate before starting this role." />
</If>
<If condition={parsed.recipient !== undefined && parsed.recipient !== null && parsed.recipient !== props.role}>
<Fail message="The prepared handoff belongs to a different recipient. Use its named original role." />
</If>
<If condition={parsed.continuation !== undefined && parsed.continuation !== null && (parsed.continuation.phase !== successor || parsed.continuation.role !== nextRole)}>
<Fail message="The selected successor differs from the prepared continuation gate." />
</If>
<Let as="attempt" value={props.attempt} />
<If condition={!attempt.startsWith("/")}>
<If condition={attempt.split("/").some(part => part === ".." || part === ".")}><Fail message="A relative phase attempt stays beneath the calling workspace." /></If>
```bash exec as="workspace"
pwd -P
```
<If condition={workspace.exitCode !== 0}><Fail message={JSON.stringify(workspace)} /></If>
<Let as="attempt" value={workspace.stdout.slice(0,-1) + "/" + attempt} />
</If>
<Let as="assignment" value={{...parsed,artifactDirectory:attempt,contract:parsed.contract ?? null,continuation:{phase:successor,role:nextRole}}} />
<If condition={assignment.phase !== props.phase}>
<Fail message="The prepared assignment belongs to another phase." />
</If>
<If condition={assignment.phase === "implementation" && successor !== "review" && !(successor === "ready" && policy.reviewers.length === 0) || assignment.phase === "discovery" && successor === "ready"}>
<Fail message="The successor is not an allowed next gate for this phase." />
</If>
<Phase.Preparation phase={assignment.phase} work={assignment.work} repository={assignment.repository} revision={assignment.revision} priorRevision={assignment.priorRevision} request={assignment.request} changedPaths={assignment.changedPaths} artifacts={assignment.artifacts} evidence={assignment.evidence} findings={assignment.findings} issue={assignment.issue} contract={assignment.contract} assessment={assignment.assessment} reviewKind={assignment.reviewKind} recipient={assignment.recipient ?? null} continuation={assignment.continuation} as="checked" />
<Dir path={assignment.repository}>
<Dir path={attempt.slice(0,attempt.lastIndexOf("/")) || "/"}><Let as="artifactParentPrepared" value={true} /></Dir>
<Let as="quotedAttempt" value={"'" + attempt.replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="reservation"
mkdir -- {quotedAttempt}
```
<If condition={reservation.exitCode !== 0}>
<Fail message={"The attempt directory could not be reserved. Preserve it and assign a fresh path. " + reservation.stderr} />
</If>
<Dir path={attempt}><File path="assignment.json"><Json value={assignment} /></File></Dir>
<Phase.Event attempt={attempt} stage="started" assignment={assignment} role={props.role} as="started" />
<Phase.Role inputs={props.inputs} role={props.role} session={props.session} assignment={assignment} initialize={props.initialize} implementationProvider={props.implementationProvider} as="raw" />
<Dir path={attempt}><File path="raw.txt">{raw}</File></Dir>
<Phase.Event attempt={attempt} stage="reply-saved" assignment={assignment} role={props.role} as="replied" />
<Phase.Correct assignment={assignment} raw={raw} role={props.role} session={props.session} attempt={attempt} implementationProvider={props.implementationProvider} inputs={props.inputs} profile={props.responseProfile} as="accepted" />
<Let as="result" value={accepted.result} />
<Dir path={attempt}><File path="result.json"><Json value={result} /></File></Dir>
<Let as="rawQuoted" value={"'" + accepted.rawPath.replaceAll("'","'\"'\"'") + "'"} />
<Let as="resultQuoted" value={"'" + (attempt + "/result.json").replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="hashes"
shasum -a 256 -- {rawQuoted} {resultQuoted}
```
<If condition={hashes.exitCode !== 0}><Fail message="Accepted response hash receipt failed; preserve publication effects." /></If>
<Dir path={attempt}><File path="response-acceptance.json"><Json value={{round:accepted.round,raw:accepted.rawPath,result:attempt + "/result.json",hashes:hashes.stdout,diagnostics:accepted.diagnostics}} /></File></Dir>
<Phase.Event attempt={attempt} stage="result-saved" assignment={assignment} role={props.role} outcome={result.outcome} next={result.next} revision={result.revision} as="finished" />
<Return value={result} />
</Dir>
