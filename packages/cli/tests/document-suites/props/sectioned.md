---
props:
  type: object
  properties:
    name: { type: string }
  required: [name]
  additionalProperties: false
---

# Sectioned

## Greeting

Hello, {props.name}!

## Farewell

FAREWELL_MARKER
