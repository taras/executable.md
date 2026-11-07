---
props:
  type: object
  properties:
    manifest: {type: string}
  required: [manifest]
---
<Ticket.Run manifest={props.manifest} maxSteps={1} as="firstReturn" />
<Ticket.Load record={firstReturn} as="first" />
<Ticket.Continue record={firstReturn} maxSteps={1} as="againReturn" />
<Ticket.Load record={againReturn} as="again" />
<Output><Json value={{first,again,firstReturn,againReturn}} /></Output>
