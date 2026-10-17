<Development.Architect session="capture-architect" request={"Inspect the design.\nKeep the structural checklist finite."} as="architect" />
<Development.Planner session="capture-planner" request={"Plan the feature.\nFreeze its evidence."} as="planner" />
<Development.Implementor session="capture-implementor" model="fixture-explicit-model" request={"Implement the slice.\nReturn its evidence."} as="implementor" />

<AssertEquals actual={architect} expected={"# Architect reply\n\n**Structure** stays scoped.\n\n- first finding\n- second finding"} />
<AssertEquals actual={planner} expected={"## Planner reply\n\nUse `focused evidence`.\n\n1. Implement\n2. Review"} />
<AssertEquals actual={implementor} expected={"# Implementor reply\n\n**Delivered** the slice.\n\n```text\nfixture evidence\n```"} />

<Output><Development.Architect session="render-architect" request="Render the complete reply." /></Output>
