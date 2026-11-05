---
props:
  type: object
  properties:
    inputs: {type: array, items: {type: object}}
    role: {type: string}
    session: {type: string}
    assignment: {type: object}
    initialize: {type: boolean}
    plannerProvider: {type: string}
    implementationProvider: {type: string}
    correction: {type: [object, 'null'], default: null}
  required: [inputs, role, session, assignment, initialize]
---
The synthetic role answers inside the same confirmed-conversation guard that
production roles use, so retained identity receipts are real.

<Output><Fixture.Session session={{sessionKey:props.session,cwd:props.assignment.repository,identity:{kind:"fixture.native",value:"artifact-" + props.session}}}><Phase.Session directory={props.assignment.identityDirectory} name={props.session} requireExisting={props.assignment.sessionEstablished === true}><Fixture.ArtifactRole role={props.role} session={props.session} initialize={props.initialize} inputs={props.inputs} assignment={props.assignment} /></Phase.Session></Fixture.Session></Output>
