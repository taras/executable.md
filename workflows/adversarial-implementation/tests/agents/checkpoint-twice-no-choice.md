<WhenPrompt as="a1" template="{?a}Material to assess:{?b}PLAN-V1{?c}REVIEW-FAIL the plan cites no evidence for the mount point.{?d}Revision prompt:{?e}REVISE-EXACTLY cite the file and line that exposes the mount point.{?f}" />

{"requiresUser": false, "assessment": "ASSESSED-NO-CHOICE the verdict passed and the plan is unchanged.", "question": "", "options": [], "recommendation": "Continue."}

<WhenPrompt as="a2" template="{?a}Material to assess:{?b}PLAN-V2{?c}REVIEW-PASS the revised plan cites router.ts line 40.{?d}" />

{"requiresUser": false, "assessment": "ASSESSED-NO-CHOICE the verdict passed and the plan is unchanged.", "question": "", "options": [], "recommendation": "Continue."}
