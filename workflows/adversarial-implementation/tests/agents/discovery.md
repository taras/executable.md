<WhenPrompt
  as="discovery"
  template="{?before}## `workflows/adversarial-implementation/tests/fixtures/AGENTS.md`{?gap}Root instructions: prefer evidence over assertion.{?middle}## `workflows/adversarial-implementation/tests/fixtures/nested/AGENTS.md`{?gap2}Nested instructions: never edit a test to make it pass.{?rest}Add a health endpoint{?tail}"
/>

HANDOFF

Purpose: add a health endpoint.

User decisions: the route is `/health`.

Hypotheses the implementor must test: the router already exposes a mount point.
