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
