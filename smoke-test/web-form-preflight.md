# WebForm preflight

`<WebForm>` is registered by the CLI, and everything it can judge without opening
a port it judges first. A schema that is not an object cannot generate a form, so
this document fails before a listener exists — which is what makes it safe to run
where there is no browser and no display.

The failure is the point: a compiled binary that had not registered `<WebForm>`
would report an unresolved component instead, and one that opened a port before
checking would hang here.

<WebForm schema="[]" as="never">
This body is never served.
</WebForm>
