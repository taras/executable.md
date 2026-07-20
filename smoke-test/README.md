---
title: Executable MDX
version: 0.1.0
repo: https://github.com/thefrontside/effectionx
---

<Capture as="introHeading"># {meta.title}</Capture>
{introHeading}

This document is both a guide and a smoke test. Every feature described
here is exercised by the document itself — if it renders correctly,
the system works. Each chapter below is a self-testing feature document:
it captures each demonstrated result at its production site, re-emits
it, and carries a sibling test that inspects the capture.

<Capture as="introVersion">This is version **{meta.version}** of {meta.title}.</Capture>
{introVersion}

<Capture as="introRepo">Built from the source at [{meta.repo}]({meta.repo}).</Capture>
{introRepo}

<Test name="Root frontmatter">
<AssertEquals actual={introHeading} expected={"# Executable MDX"} />
<AssertEquals actual={introVersion} expected={"This is version **0.1.0** of Executable MDX."} />
<AssertEquals actual={introRepo} expected={"Built from the source at [https://github.com/thefrontside/effectionx](https://github.com/thefrontside/effectionx)."} />
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
