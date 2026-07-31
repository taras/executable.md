/**
 * Move the required marker from the label's text into the stylesheet's reach.
 *
 * The shadcn theme renders a required field's label as `[label, "*"]`, so the
 * marker is a bare text node — and no selector reaches one, which leaves it
 * unable to take the destructive colour the theme calls for. Spending
 * `required` here suppresses that text node and marks the field instead; the
 * stylesheet draws the same marker back on as `::after`.
 *
 * Nothing else in the field template reads the prop. The widgets take their own
 * `required` from the field, which is where the select's unanswered-required
 * styling comes from, so it is unaffected.
 */

import { createElement } from "react";
import type { ComponentType } from "react";
import type { FieldTemplateProps } from "@rjsf/utils";

export const REQUIRED_FIELD_CLASS = "rjsf-field-required";

export interface RequiredMarking {
  required: false;
  classNames: string;
}

/** Pure and free of React, so the substitution is tested rather than rendered. */
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
