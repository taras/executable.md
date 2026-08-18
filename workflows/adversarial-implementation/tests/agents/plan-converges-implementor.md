<WhenPrompt
  as="plan"
  template="{?a}Root instructions: prefer evidence over assertion.{?b}Nested instructions: never edit a test to make it pass.{?c}HANDOFF{?d}amend the implementation theory against that material{?e}"
/>

PLAN-V1

Add `/health` to the existing router mount point. Evidence: the router already
exposes one. Validation: a route test. No environmental effects.
