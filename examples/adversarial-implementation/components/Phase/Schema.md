---
description: Read the assignment and result contracts. Use <Phase.Schema as="schemas" />.
returns:
  type: object
---

<Discovery.Schema as="discoverySchemas" />
<ReviewPolicy.Schema as="assessmentSchema" />
<ExactCorrection.Schema as="exactCorrectionSchema" />

<Return value={{
  "assignment": {
    "type": "object",
    "properties": {
      "assessment": assessmentSchema,
      "reviewKind": {enum:["feature","correction"],default:"feature"},
      "gate": {
        "type": "string",
        "minLength": 1
      },
      "phase": {
        "enum": [
          "discovery",
          "implementation",
          "review"
        ]
      },
      "work": {
        "type": "string",
        "minLength": 1
      },
      "repository": {
        "type": "string",
        "pattern": "^/"
      },
      "revision": {
        "type": "string",
        "pattern": "^[0-9a-f]{40}$"
      },
      "priorRevision": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[0-9a-f]{40}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "request": {
        "type": "string",
        "minLength": 1
      },
      "changedPaths": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "artifacts": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "revision": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "command": {
              "type": "string",
              "minLength": 1
            },
            "outcome": {
              "enum": [
                "passed",
                "failed",
                "not_run"
              ]
            },
            "artifact": {
              "type": "string",
              "minLength": 1
            },
            "candidate": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "revision",
            "command",
            "outcome",
            "artifact"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "revision": {
                    "type": "null"
                  }
                }
              },
              "then": {
                "required": [
                  "candidate"
                ],
                "properties": {
                  "candidate": {}
                }
              }
            }
          ]
        }
      },
      "findings": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "issue": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "minLength": 1
              },
              "title": {
                "type": "string",
                "minLength": 1
              },
              "description": {
                "type": "string"
              },
              "tags": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "assignee": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "url",
              "title",
              "description",
              "tags",
              "assignee"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "contract": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "work": {
                "type": "string",
                "minLength": 1
              },
              "sourceRevision": {
                "type": "string",
                "pattern": "^[0-9a-f]{40}$"
              },
              "scope": {
                "type": "string",
                "minLength": 1
              },
              "sections": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string",
                      "minLength": 1
                    },
                    "heading": {
                      "type": "string",
                      "minLength": 1
                    },
                    "relevance": {
                      "type": "string",
                      "minLength": 1
                    },
                    "requirements": {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  },
                  "required": [
                    "path",
                    "heading",
                    "relevance",
                    "requirements"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "work",
              "sourceRevision",
              "scope",
              "sections"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "recipient": {
        "anyOf": [
          {
            "enum": [
              "architect",
              "planner",
              "implementor"
            ]
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "continuation": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "phase": {
                "enum": [
                  "discovery",
                  "implementation",
                  "review",
                  "ready"
                ]
              },
              "role": {
                "enum": [
                  "architect",
                  "planner",
                  "implementor",
                  null
                ]
              }
            },
            "required": [
              "phase",
              "role"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "phase": {
                      "enum": [
                        "ready",
                        "hold"
                      ]
                    }
                  }
                },
                "then": {
                  "properties": {
                    "role": {
                      "type": "null"
                    }
                  }
                },
                "else": {
                  "properties": {
                    "role": {
                      "type": "string"
                    }
                  }
                }
              },
              {
                "if": {
                  "properties": {
                    "phase": {
                      "const": "implementation"
                    }
                  }
                },
                "then": {
                  "properties": {
                    "role": {
                      "const": "implementor"
                    }
                  }
                }
              },
              {
                "if": {
                  "properties": {
                    "phase": {
                      "enum": [
                        "discovery",
                        "review"
                      ]
                    }
                  }
                },
                "then": {
                  "properties": {
                    "role": {
                      "enum": [
                        "architect",
                        "planner"
                      ]
                    }
                  }
                }
              }
            ]
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "handoffInputs": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "uniqueItems": true,
        "maxItems": 12,
        "default": []
      },
      "artifactDirectory": {
        "type": "string",
        "pattern": "^/"
      }
    },
    "required": [
      "phase",
      "work",
      "repository",
      "revision",
      "priorRevision",
      "request",
      "changedPaths",
      "artifacts",
      "evidence",
      "findings"
    ],
    "additionalProperties": false
  },
  "result": {
    "type": "object",
    "properties": {
      "apiConflict": {type:"object",properties:{expected:{type:"string",minLength:1},observed:{type:"string",minLength:1},reproducer:{type:"string",minLength:1},artifact:{type:"string",minLength:1}},required:["expected","observed","reproducer","artifact"],additionalProperties:false},
      "exactCorrection": exactCorrectionSchema,
      "assessment": assessmentSchema,
      "schema": {
        "const": "phase-result.v2"
      },
      "phase": {
        "enum": [
          "discovery",
          "implementation",
          "review"
        ]
      },
      "work": {
        "type": "string",
        "minLength": 1
      },
      "outcome": {
        "enum": [
          "complete",
          "pass",
          "changes_required",
          "missing_evidence",
          "needs_discovery",
          "needs_decision",
          "escalate",
          "blocked"
        ]
      },
      "revision": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[0-9a-f]{40}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1200
      },
      "handoff": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1800
      },
      "artifacts": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "revision": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "command": {
              "type": "string",
              "minLength": 1
            },
            "outcome": {
              "enum": [
                "passed",
                "failed",
                "not_run"
              ]
            },
            "artifact": {
              "type": "string",
              "minLength": 1
            },
            "candidate": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "revision",
            "command",
            "outcome",
            "artifact"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "revision": {
                    "type": "null"
                  }
                }
              },
              "then": {
                "required": [
                  "candidate"
                ],
                "properties": {
                  "candidate": {}
                }
              }
            }
          ]
        }
      },
      "findings": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 600
        },
        "maxItems": 8
      },
      "contract": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "work": {
                "type": "string",
                "minLength": 1
              },
              "sourceRevision": {
                "type": "string",
                "pattern": "^[0-9a-f]{40}$"
              },
              "scope": {
                "type": "string",
                "minLength": 1
              },
              "sections": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string",
                      "minLength": 1
                    },
                    "heading": {
                      "type": "string",
                      "minLength": 1
                    },
                    "relevance": {
                      "type": "string",
                      "minLength": 1
                    },
                    "requirements": {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  },
                  "required": [
                    "path",
                    "heading",
                    "relevance",
                    "requirements"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "work",
              "sourceRevision",
              "scope",
              "sections"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "next": {
        "$ref": "#/$defs/route"
      },
      "blocker": {
        "anyOf": [
          {
            "$ref": "#/$defs/blocker"
          },
          {
            "type": "null"
          }
        ],
        "default": null
      },
      "handoffInputs": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "uniqueItems": true,
        "maxItems": 12,
        "default": []
      },
      "discoveryRequests": {type:"array",maxItems:12,items:discoverySchemas.request,default:[]},
      "discoveryGaps": {type:"array",maxItems:12,items:discoverySchemas.gap,default:[]},
      "metadata": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "body": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "title",
              "body"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ],
        "default": null
      }
    },
    "required": [
      "schema",
      "phase",
      "work",
      "outcome",
      "revision",
      "summary",
      "handoff",
      "artifacts",
      "evidence",
      "findings",
      "next"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "phase": {
              "const": "discovery"
            }
          }
        },
        "then": {
          "properties": {
            "outcome": {
              "enum": [
                "complete",
                "needs_discovery",
                "needs_decision",
                "escalate",
                "blocked"
              ]
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "phase": {
              "const": "implementation"
            }
          }
        },
        "then": {
          "properties": {
            "outcome": {
              "enum": [
                "complete",
                "needs_discovery",
                "blocked"
              ]
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "phase": {
              "const": "review"
            }
          }
        },
        "then": {
          "properties": {
            "outcome": {
              "enum": [
                "pass",
                "changes_required",
                "missing_evidence",
                "needs_discovery",
                "needs_decision",
                "escalate",
                "blocked"
              ]
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "outcome": {
              "enum": [
                "complete",
                "pass"
              ]
            },
            "phase": {
              "enum": [
                "implementation",
                "review"
              ]
            }
          }
        },
        "then": {
          "properties": {
            "revision": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "outcome": {
              "const": "blocked"
            }
          }
        },
        "then": {
          "required": [
            "blocker"
          ],
          "properties": {
            "blocker": {
              "$ref": "#/$defs/blocker"
            }
          }
        },
        "else": {
          "properties": {
            "blocker": {
              "type": "null"
            }
          }
        }
      }
    ],
    "$defs": {
      "route": {
        "type": "object",
        "properties": {
          "phase": {
            "enum": [
              "discovery",
              "implementation",
              "review",
              "ready",
              "hold"
            ]
          },
          "role": {
            "enum": [
              "architect",
              "planner",
              "implementor",
              null
            ]
          }
        },
        "required": [
          "phase",
          "role"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "phase": {
                  "enum": [
                    "ready",
                    "hold"
                  ]
                }
              }
            },
            "then": {
              "properties": {
                "role": {
                  "type": "null"
                }
              }
            },
            "else": {
              "properties": {
                "role": {
                  "type": "string"
                }
              }
            }
          },
          {
            "if": {
              "properties": {
                "phase": {
                  "const": "implementation"
                }
              }
            },
            "then": {
              "properties": {
                "role": {
                  "const": "implementor"
                }
              }
            }
          },
          {
            "if": {
              "properties": {
                "phase": {
                  "enum": [
                    "discovery",
                    "review"
                  ]
                }
              }
            },
            "then": {
              "properties": {
                "role": {
                  "enum": [
                    "architect",
                    "planner"
                  ]
                }
              }
            }
          }
        ]
      },
      "blocker": {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "quota",
              "permission",
              "external_dependency",
              "provider_error",
              "missing_input"
            ]
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 600
          },
          "unblockCondition": {
            "type": "string",
            "minLength": 1,
            "maxLength": 600
          },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "kind",
          "reason",
          "unblockCondition",
          "evidence"
        ],
        "additionalProperties": false
      }
    }
  },
  "issue": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1
      },
      "description": {
        "type": "string"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "assignee": {
        "type": [
          "string",
          "null"
        ]
      }
    },
    "required": [
      "url",
      "title",
      "description",
      "tags",
      "assignee"
    ],
    "additionalProperties": false
  },
  "contract": {
    "type": "object",
    "properties": {
      "work": {
        "type": "string",
        "minLength": 1
      },
      "sourceRevision": {
        "type": "string",
        "pattern": "^[0-9a-f]{40}$"
      },
      "scope": {
        "type": "string",
        "minLength": 1
      },
      "sections": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "heading": {
              "type": "string",
              "minLength": 1
            },
            "relevance": {
              "type": "string",
              "minLength": 1
            },
            "requirements": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "required": [
            "path",
            "heading",
            "relevance",
            "requirements"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "work",
      "sourceRevision",
      "scope",
      "sections"
    ],
    "additionalProperties": false
  },
  "route": {
    "type": "object",
    "properties": {
      "phase": {
        "enum": [
          "discovery",
          "implementation",
          "review",
          "ready",
          "hold"
        ]
      },
      "role": {
        "enum": [
          "architect",
          "planner",
          "implementor",
          null
        ]
      }
    },
    "required": [
      "phase",
      "role"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "phase": {
              "enum": [
                "ready",
                "hold"
              ]
            }
          }
        },
        "then": {
          "properties": {
            "role": {
              "type": "null"
            }
          }
        },
        "else": {
          "properties": {
            "role": {
              "type": "string"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "phase": {
              "const": "implementation"
            }
          }
        },
        "then": {
          "properties": {
            "role": {
              "const": "implementor"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "phase": {
              "enum": [
                "discovery",
                "review"
              ]
            }
          }
        },
        "then": {
          "properties": {
            "role": {
              "enum": [
                "architect",
                "planner"
              ]
            }
          }
        }
      }
    ]
  }
}} />
