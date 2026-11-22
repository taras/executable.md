# Baseline exercise: a loop of Json components

This document counts the function calls a loop of `Json` components makes at two
sizes and compares the calls per iteration with the recorded baseline beside it.
Run it from the root of the checkout, in its own process:

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts run --plugin ./examples/xmd-profile/plugin.ts \
  examples/xmd-profile/baselines/loop-json.md
```

Set `XMD_PROFILE_UPDATE=1` on that command to record the baseline again after an
intended change.

<Profile label="baseline-loop-50" mode="calls" as="small">
<Loop max={50}>
<Json value={1} />
</Loop>
</Profile>

<Profile label="baseline-loop-200" mode="calls" as="large">
<Loop max={200}>
<Json value={1} />
</Loop>
</Profile>

<Output>
<Profile.Baseline
  path="examples/xmd-profile/baselines/loop-json.baseline.md"
  title="Loop of Json components"
  captures={[{calls: small.calls, units: 50}, {calls: large.calls, units: 200}]}
/>
</Output>