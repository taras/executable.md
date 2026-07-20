---
title: Executable MDX
version: 0.1.0
repo: https://github.com/thefrontside/effectionx
---

<Capture as="intro">

# {meta.title}

This document is both a guide and a smoke test. Every feature described
here is exercised by the document itself — if it renders correctly,
the system works. This is version **{meta.version}** of {meta.title},
built from the source at [{meta.repo}]({meta.repo}). Each chapter below
is a self-testing feature document: it captures its own rendered
content, re-emits it, and carries a sibling test that inspects the
capture.

</Capture>

{intro}

<Test name="Root frontmatter">
<AssertStringIncludes actual={intro} expected={"# Executable MDX"} />
<AssertStringIncludes actual={intro} expected={"version **0.1.0**"} />
<AssertStringIncludes actual={intro} expected={"https://github.com/thefrontside/effectionx"} />
</Test>

<Guide.Overview />

<Guide.Components />

<Guide.NestedComponents />

<Guide.Execution />

<Guide.Props />

<Guide.Interpolation />

<Guide.Captures />

<Guide.Healing />

<Guide.Evaluation />

<Guide.Daemons />

<Guide.Sampling />

<Guide.NamedSlots />

<Guide.Instructions />

<Guide.Durability />

<Guide.OutputRegions />

<Guide.Summary />
