---
description: 'Save a deterministic delivery report from current validated status. Use <Delivery.Closeout delivery={delivery} number={123} as="status" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Status delivery={props.delivery} number={props.number} as="status" />
<Let as="reportRevision" value={status.revision ?? "Implementation feedback pending"} />
<Dir path={props.delivery.directory}>
<File path="closeout.json"><Json value={status} /></File>
<File path="closeout.md">
# Delivery {props.delivery.work}

Status: {status.status}

Revision: {reportRevision}

Next action: {status.nextAction}

<Each in={status.required} let="gate">
- {gate.gate}: {gate.state}
</Each>

<If condition={status.review != null}>
Independent review: {status.review.result.verdict}

{status.review.result.summary}

<Each in={status.review.result.findings} let="finding">
<Let as="findingKind" value={finding.blocking ? "Blocking" : "Non-blocking"} />
- {findingKind}: {finding.description}
</Each>
</If>

<If condition={status.reviewAttempts != null}>
Review selection: {status.reviewAttempts.chain}

<Each in={status.reviewAttempts.attempts} let="attempt">
<Let as="attemptRole" value={attempt.position === 0 ? "Primary reviewer" : "Replacement reviewer"} />
<Let as="attemptModel" value={attempt.model ?? "not configured"} />
<Let as="attemptEffort" value={attempt.reviewer.effort ?? "provider default"} />
<Let as="attemptEvidence" value={attempt.evidence.join(", ")} />
- {attemptRole}: {attempt.reviewer.provider}, requested model {attempt.reviewer.model}, configured model {attemptModel}, effort {attemptEffort}, conversation {attempt.reviewer.session}. {attempt.state}: {attempt.reason} Evidence: {attemptEvidence}
</Each>
</If>

Evidence: closeout.json retains the complete status, selected CI and main-health evidence, and review references.

This report starts no model call, publishes nothing and grants no merge permission.
</File>
</Dir>
<Return value={status} />
