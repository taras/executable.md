<Capture as="rendered">

<Section title="What is Executable MDX?">

Executable MDX treats markdown files as **durable workflows**. A document
can contain component invocations that expand other markdown files, and
code blocks that execute shell commands. Every I/O operation is recorded
in a journal so that execution survives crashes and replays from where
it left off.

</Section>

</Capture>

{rendered}

<Test name="Overview">
<AssertStringIncludes actual={rendered} expected={"\u00a7 What is Executable MDX?"} />
</Test>
