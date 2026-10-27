import { randomUUID } from 'node:crypto';

export const condition = Object.freeze({ hasValue: 100 });

export function action(identifier, parameters = {}) {
  return {
    WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
    WFWorkflowActionParameters: { UUID: randomUUID(), ...parameters },
  };
}

export function attachment(value) {
  return { Value: value, WFSerializationType: 'WFTextTokenAttachment' };
}

export function output(action, name) {
  return attachment({
    Type: 'ActionOutput', OutputUUID: action.WFWorkflowActionParameters.UUID, OutputName: name,
  });
}

export function text(value) {
  // Text fields embed variables at UTF-16 ranges, rather than storing an attachment directly.
  const content = typeof value === 'string'
    ? { string: value, attachmentsByRange: {} }
    : { string: '￼', attachmentsByRange: { '{0, 1}': value.Value } };
  return { Value: content, WFSerializationType: 'WFTextTokenString' };
}

export function dictionary(entries) {
  return {
    Value: {
      WFDictionaryFieldValueItems: Object.entries(entries).map(([key, value]) => ({
        WFItemType: 0, WFKey: text(key), WFValue: text(value),
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  };
}

export function conditional(input, comparison, yes, no = [], parameters = {}) {
  const GroupingIdentifier = randomUUID();
  return [
    action('conditional', {
      GroupingIdentifier, WFControlFlowMode: 0, WFCondition: comparison,
      WFInput: { Type: 'Variable', Variable: input }, ...parameters,
    }),
    ...yes,
    ...(no.length ? [action('conditional', { GroupingIdentifier, WFControlFlowMode: 1 }), ...no] : []),
    action('conditional', { GroupingIdentifier, WFControlFlowMode: 2 }),
  ];
}
