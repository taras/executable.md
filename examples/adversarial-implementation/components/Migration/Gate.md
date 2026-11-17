---
props:
  type: object
  properties:
    batch:
      type: object
      properties:
        path: {type: string, pattern: '^/'}
        repository: {type: string, pattern: '^/'}
        repositoryId: {type: string}
        directory: {type: string, pattern: '^/'}
        revision: {type: string, pattern: '^[a-f0-9]{40}$'}
      required: [path, repository, repositoryId, directory, revision]
      additionalProperties: false
  required: [batch]
  additionalProperties: false
returns: {type: object}
---

<Let as="batch" value={props.batch} />
<Migration.Program path={batch.path} repository={batch.repository} repositoryId={batch.repositoryId} directory={batch.directory} as="program" />
<If condition={!program.required}><Return value={{result:null}} /><Else>
<Entry.DiagnosticSolvers as="solvers" />
<Diagnosis.Paths repository={batch.repository} attempt={program.attempt} session={program.session} as="resolved" />
<Let as="resultInput" value={{repository:batch.repository,parent:program.parent,directory:resolved.directory,identities:resolved.identities,session:program.session,name:resolved.name,question:program.question,constraints:program.constraints,inputs:program.inputs,candidates:[solvers.primary,...(solvers.fallback ? [solvers.fallback] : [])].map(({key,provider,models,effort}) => ({key,provider,models,effort}))}} />
<Migration.Result input={resultInput} as="saved" />
<If condition={saved === null}>
<Let as="request" value={{role:"problem-solver",session:program.session,attempt:resolved.directory,inputPaths:program.inputs.map(input => input.path),assignment:{kind:"design",work:program.parent,repository:batch.repository,revision:batch.revision,question:program.question,constraints:program.constraints}}} />
<Ticket.Capture as="assessment"><Diagnosis.Run request={request} solvers={solvers} as="review" /><Json value={review} /></Ticket.Capture>
<If condition={assessment.status !== "completed"}><Fail message={"Reconcile the parent migration design at " + resolved.directory + " before starting this batch. " + assessment.failure} /></If>
<Parse schema={{type:"object"}} as="review">{assessment.output}</Parse>
<If condition={review.status !== "design"}><Fail message={"The parent migration design is held at " + review.attempt + ". " + review.reason} /></If>
<Migration.Result input={resultInput} as="saved" />
<If condition={saved === null}><Fail message={"No validated migration design was retained at " + resolved.directory + "."} /></If>
</If>
<Migration.Program path={batch.path} repository={batch.repository} repositoryId={batch.repositoryId} directory={batch.directory} as="current" />
<If condition={program.fingerprint !== current.fingerprint}><Fail message="The parent migration inputs changed during admission. Re-run the batch with the current program." /></If>
<Return value={{result:saved,parent:program.parent}} />
</Else>
</If>
