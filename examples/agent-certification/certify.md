---
props:
  config: { type: string }
  report: { type: string }
required: [config, report]
---
# Qualify a local ACP agent

You authorize the scenarios listed in your local configuration when you run this
example. Read README.md first. Your command uses its existing local credentials.

<LoadConfiguration path={props.config} as="local" />
<Let as="configuration" value={local.configuration} />

<Output>
<Qualify configuration={configuration} configFingerprint={local.fingerprint} report={props.report}>
<RunSequence />
</Qualify>
</Output>
