# Recover an independent review

Try the primary reviewer and, after an ordinary failure has cleanly released its
resources, ask an independent fallback reviewer. You need both Agent providers
installed in your run host. Catch keeps the readable failure before the fallback
reply; Finally reports completion.

This example handles any ordinary failure leaving its attempted region. A workflow
that permits fallback only for attributed provider or verified configuration
conditions retains that policy separately. Error names and messages do not prove
provider origin. Native release, partial streamed text and retained configuration
observations remain their existing owners' responsibilities.

<Output>
<Try>
  <Agent name="claude">
    <Session name="primary-review">
      <Prompt throwOnError={true}>Review the proposed change. Return PASS or findings.</Prompt>
    </Session>
  </Agent>
  <Catch as="error">
    Primary review failed: {error.message}
    <Agent name="codex">
      <Session name="fallback-review">
        <Prompt throwOnError={true}>Independently review the proposed change. Return PASS or findings.</Prompt>
      </Session>
    </Agent>
  </Catch>
  <Finally>
    Review attempt finished.
  </Finally>
</Try>
</Output>
