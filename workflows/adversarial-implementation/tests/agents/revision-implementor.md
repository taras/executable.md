<WhenPrompt as="plan1" template="{?a}Investigate the registered checkout.{?b}" />

PLAN-V1

The first plan, which the planner rejects.

<WhenPrompt
  as="revision"
  template="{?a}Revise the implementation plan using this review:{?b}REVIEW-FAIL the plan cites no evidence for the mount point.{?c}Focused revision prompt:{?d}REVISE-EXACTLY cite the file and line that exposes the mount point.{?e}User involvement record:{?f}ASSESSED-NO-CHOICE the verdict passed and the plan is unchanged.{?g}User response: continue{?h}Rationale: The assessing agent found no material choice, so this transition needs no user decision.{?i}"
/>

Acknowledged.

<WhenPrompt as="plan2" template="{?a}Investigate the registered checkout.{?b}" />

PLAN-V2

The revised plan, citing router.ts line 40.
