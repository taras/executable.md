---
title: Executable MDX
version: 0.1.0
repo: https://github.com/thefrontside/effectionx
---

# {meta.title}

This document is both a guide and a smoke test. Each chapter explains a
feature in prose and carries atomic tests that run the demonstrated
scenario end to end — setup, action, capture, and assertion live inside
each test, so regular execution renders the guide while `xmd test` runs
every scenario. This is version **{meta.version}** of {meta.title},
built from the source at [{meta.repo}]({meta.repo}).

<Test name="Root frontmatter interpolates into the heading">
<Capture as="heading"># {meta.title}</Capture>
<AssertEquals actual={heading} expected={"# Executable MDX"} />
</Test>

<Test name="Root frontmatter interpolates into prose">
<Capture as="versionLine">This is version **{meta.version}** of {meta.title}, built from the source at [{meta.repo}]({meta.repo}).</Capture>
<AssertEquals actual={versionLine} expected={"This is version **0.1.0** of Executable MDX, built from the source at [https://github.com/thefrontside/effectionx](https://github.com/thefrontside/effectionx)."} />
</Test>

<Guide.Overview />

<Guide.Components />

<Guide.NestedComponents />

<Guide.Execution />

<Guide.Props />

<Guide.TypedInputs />

<Guide.Interpolation />

<Guide.Each />

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
