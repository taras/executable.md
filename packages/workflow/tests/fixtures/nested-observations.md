# Two observations inside a content-bearing parent

`<Frame>` renders what is written inside it, so its own invocation stays open
for as long as these two sites are running. Neither site is named after it: an
ancestor's invocation is live and unspent throughout its content, and that is
precisely why being live is not the same as being the one doing the naming.

<Frame>
<Evaluate source={'<File path="alpha.md" />'} as="first" />

<Json value={first} />

<Evaluate source={'<Fetch url="https://api.example.test/admitted" />'} as="second" />

<Json value={second} />
</Frame>
