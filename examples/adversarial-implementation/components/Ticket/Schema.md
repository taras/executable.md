---
description: >-
  Read the resolved ticket manifest contract. Use <Ticket.Schema as="schema" />.
props: {type: object, additionalProperties: false}
returns: {type: object}
---

<Return value={{
  "type": "object",
  "properties": {
    "schema": {
      "const": "ticket-workflow.v2"
    },
    "work": {
      "type": "string",
      "minLength": 1
    },
    "directory": {
      "type": "string",
      "pattern": "^/"
    },
    "api": {"type": "object"},
    "assignment": {
      "type": "object"
    },
    "maxCorrections": {
      "type": "integer",
      "minimum": 0,
      "maximum": 10
    },
    "roles": {
      "type": "object",
      "properties": {
        "architect": {
          "type": "object",
          "properties": {
            "session": {
              "type": "string",
              "minLength": 1
            },
            "provider": {
              "enum": [
                "codex"
              ]
            },
            "initialized": {
              "type": "boolean"
            }
          },
          "required": [
            "session",
            "provider",
            "initialized"
          ],
          "additionalProperties": false
        },
        "planner": {
          "type": "object",
          "properties": {
            "session": {
              "type": "string",
              "minLength": 1
            },
            "provider": {
              "enum": [
                "claude"
              ]
            },
            "initialized": {
              "type": "boolean"
            }
          },
          "required": [
            "session",
            "provider",
            "initialized"
          ],
          "additionalProperties": false
        },
        "implementor": {
          "type": "object",
          "properties": {
            "session": {
              "type": "string",
              "minLength": 1
            },
            "provider": {
              "enum": [
                "codex",
                "claude"
              ]
            },
            "initialized": {
              "type": "boolean"
            }
          },
          "required": [
            "session",
            "provider",
            "initialized"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "architect",
        "planner",
        "implementor"
      ],
      "additionalProperties": false
    },
    "acceptedInputs": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "pattern": "^/"
          },
          "content": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "content"
        ],
        "additionalProperties": false
      }
    },
    "deliveredInputs": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "uniqueItems": true
      },
      "default": {}
    },
    "roleInputs": {
      "type": "object",
      "properties": {
        "architect": {
          "type": "array",
          "maxItems": 12,
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "pattern": "^/"
              },
              "content": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "planner": {
          "type": "array",
          "maxItems": 12,
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "pattern": "^/"
              },
              "content": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "implementor": {
          "type": "array",
          "maxItems": 12,
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "pattern": "^/"
              },
              "content": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "content"
            ],
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "required": [
    "schema",
    "work",
    "directory",
    "assignment",
    "maxCorrections",
    "roles",
    "acceptedInputs"
  ],
  "additionalProperties": false
}} />
