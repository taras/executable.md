<WhenPrompt as="v1" template="{?a}PLAN-V1{?b}Review the plan against the handoff{?c}" />

{"passed": false, "review": "REVIEW-FAIL the plan cites no evidence for the mount point.", "revisionPrompt": "REVISE-EXACTLY cite the file and line that exposes the mount point."}

<WhenPrompt as="v2" template="{?a}PLAN-V2{?b}Review the plan against the handoff{?c}" />

{"passed": true, "review": "REVIEW-PASS the revised plan cites router.ts line 40.", "revisionPrompt": ""}
