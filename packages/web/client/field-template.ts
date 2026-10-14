/**
 * The shadcn label's bare `"*"` text node cannot be styled by a selector. Suppress
 * it with `required: false` and let the field class draw a `::after` marker.
 * Widgets receive their own `required` prop and keep their validation styling.
 */

import { createElement } from "react";
import type { ComponentType } from "react";
import type { FieldTemplateProps } from "@rjsf/utils";

export const REQUIRED_FIELD_CLASS = "rjsf-field-required";

export interface RequiredMarking {
  required: false;
  classNames: string;
}

export function markingFor(classNames: string | undefined): RequiredMarking {
  return {
    required: false,
    classNames: [classNames, REQUIRED_FIELD_CLASS].filter(Boolean).join(" "),
  };
}

export function markRequired(
  Field: ComponentType<FieldTemplateProps>,
): ComponentType<FieldTemplateProps> {
  return function RequiredMarkedField(props: FieldTemplateProps) {
    if (!props.required) {
      return createElement(Field, props);
    }
    return createElement(Field, { ...props, ...markingFor(props.classNames) });
  };
}
