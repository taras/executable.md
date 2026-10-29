---
description: >-
  Check whether a reviewer can offer exact closure. Use <ExactCorrection.Validate
  assignment={assignment} result={result} role="planner" as="offer" />.
props:
  type: object
  properties:
    assignment: {type: object}
    result: {type: object}
    role: {enum: [architect, planner, implementor]}
  required: [assignment, result, role]
  additionalProperties: false
returns: {type: object}
---
<ExactCorrection.Schema as="schema" />
<Parse schema={schema} as="offer"><Json value={props.result.exactCorrection} /></Parse>
<ReviewPolicy assessment={props.assignment.assessment} kind={props.assignment.reviewKind ?? "feature"} as="before" />
<ReviewPolicy assessment={props.result.assessment} kind="correction" as="after" />
<If condition={props.assignment.phase !== "review" || props.result.phase !== "review" || props.result.outcome !== "changes_required" || offer.baseRevision !== props.assignment.revision || props.result.revision !== offer.baseRevision || props.role === "implementor" || before.effort !== "medium" || after.effort !== "medium" || before.reviewers.length !== 1 || before.reviewers[0] !== props.role || after.reviewers.length !== 1 || after.reviewers[0] !== props.role || !props.result.artifacts.includes(offer.patch) || (props.result.discoveryGaps ?? []).some(gap => gap.status === "open") || offer.checks.some(check => check.argv[0].length === 0 || check.argv.some(arg => arg.includes("\0")))}>
<Fail message="Exact closure requires the sole selected medium reviewer, one exact base, a referenced patch and executable focused checks; other corrections use normal review." />
</If>
<Return value={offer} />
