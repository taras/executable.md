---
props:
  type: object
  properties:
    record: {type: object}
  required: [record]
  additionalProperties: false
returns: {type: object}
---
<Ticket.LoadState record={props.record} as="saved" />
<Ticket.Schema as="manifestSchema" />
<Ticket.SnapshotSchema as="snapshotSchema" />
<Let as="metadataSchema" value={{...manifestSchema,properties:{...manifestSchema.properties,acceptedInputs:{...manifestSchema.properties.acceptedInputs,items:snapshotSchema},roleInputs:{...manifestSchema.properties.roleInputs,properties:Object.fromEntries(Object.entries(manifestSchema.properties.roleInputs.properties).map(([role,schema]) => [role,{...schema,items:snapshotSchema}]))}}}} />
<Parse schema={metadataSchema} as="manifest"><Json value={saved.manifest} /></Parse>
<ReviewPolicy.Schema as="assessmentSchema" /><Parse schema={assessmentSchema} as="assessment"><Json value={saved.checkpoint.reviewPolicy.assessment} /></Parse>
<Phase.Schema as="phases" />
<Parse schema={phases.assignment} as="assignment"><Json value={saved.checkpoint.assignment} /></Parse>
<Let as="index" value={0} />
<If condition={saved.calls.length !== 0}>
<Loop max={saved.calls.length}>
<Parse schema={phases.assignment} as="assignment"><Json value={saved.calls[index].assignment} /></Parse>
<Let as="index" value={index + 1} />
</Loop>
</If>
<Return value={saved} />
