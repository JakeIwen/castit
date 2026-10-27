import { action, attachment, condition, conditional, dictionary, output, text } from './workflow-format.mjs';

// One Shortcut per command, each a straight line of actions with no menu,
// prompt or alert: a dialog-free Shortcut can be run and checked headlessly on
// the Mac (`shortcuts run <name> -i <file>`) before it is tried on the phone.
export const commands = Object.freeze([
  { name: 'Van TV Cast', path: '/api/cast', body: {}, resultKey: 'videoId', success: 'Casting on Van TV' },
  { name: 'Van TV Queue', path: '/api/queue', body: { action: 'add' }, resultKey: 'done', success: 'Added to the Van TV queue' },
]);

const title = 'Van TV';
const messages = Object.freeze({
  queueFull: 'The Van TV queue is full',
  unexpected: 'Van TV returned an unexpected response',
  networkHelp: 'If Get Contents of URL stops with a connection error: Van TV unreachable — are you on the van Wi-Fi? Shortcuts cannot catch network errors. The phone cannot be its own hotspot.',
});

function notify(body) {
  return action('notification', {
    WFNotificationActionTitle: title, WFNotificationActionBody: text(body), WFNotificationActionSound: false,
  });
}

function value(response, key) {
  return action('getvalueforkey', {
    WFInput: response, WFDictionaryKey: key, WFGetDictionaryValueType: 'Value',
  });
}

function responseActions(request, command) {
  const response = output(request, 'Contents of URL');
  const error = value(response, 'error');
  const result = value(response, command.resultKey);
  const resultOutput = output(result, 'Dictionary Value');
  const success = [notify(command.success)];
  const outcome = command.resultKey === 'done'
    ? conditional(resultOutput, condition.equals, success, [notify(messages.queueFull)], { WFNumberValue: 1 })
    : success;
  return [
    error,
    ...conditional(output(error, 'Dictionary Value'), condition.hasValue,
      [notify(output(error, 'Dictionary Value')), action('exit')]),
    result,
    ...conditional(resultOutput, condition.hasValue, outcome, [notify(messages.unexpected)]),
  ];
}

// "Get Text from Input" reading Shortcut Input comes first on purpose: it gets
// the shared item whichever way Shortcuts delivers it, through the Shortcut
// Input variable or as the first action's input. The receiver finds the
// YouTube link inside whatever text arrives, so the Shortcut detects nothing
// itself; a link-detection step here is what failed on the phone before.
function sharedText() {
  return action('detect.text', { WFInput: attachment({ Type: 'ExtensionInput' }) });
}

function request(baseUrl, shared, command) {
  return action('downloadurl', {
    WFURL: `${baseUrl}${command.path}`, WFHTTPMethod: 'POST', WFHTTPBodyType: 'JSON',
    Advanced: true, ShowHeaders: true,
    WFHTTPHeaders: dictionary({ 'Content-Type': 'application/json' }),
    WFJSONValues: dictionary({ ...command.body, url: output(shared, 'Text') }),
  });
}

export function createWorkflow(baseUrl, command) {
  const shared = sharedText();
  const post = request(baseUrl, shared, command);
  return {
    WFWorkflowName: command.name,
    WFWorkflowClientVersion: '4711',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59851 },
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowInputContentItemClasses: ['WFURLContentItem', 'WFStringContentItem'],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowImportQuestions: [],
    WFWorkflowHasShortcutInputVariables: true,
    // Run directly (no share), the Shortcut takes the link from the clipboard.
    WFWorkflowNoInputBehavior: { Name: 'WFWorkflowNoInputBehaviorGetClipboard' },
    WFWorkflowActions: [
      shared,
      action('comment', { WFCommentActionText: messages.networkHelp }),
      post,
      ...responseActions(post, command),
    ],
  };
}

export function createWorkflows(baseUrl) {
  return commands.map(command => createWorkflow(baseUrl, command));
}
