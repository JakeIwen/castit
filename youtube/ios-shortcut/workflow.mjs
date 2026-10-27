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

// Reads one response key and branches on whether it has a value. Every check
// is "has any value": comparing a value (the queue's boolean `done` against 1)
// stopped the Shortcut with "Please choose a value for each parameter".
function check(response, key, actions, otherwise = []) {
  const item = value(response, key);
  const found = output(item, 'Dictionary Value');
  return [item, ...conditional(found, condition.hasValue, actions(found), otherwise)];
}

function responseActions(request, command) {
  const response = output(request, 'Contents of URL');
  const tell = found => [notify(found), action('exit')];
  return [
    ...check(response, 'error', tell),
    // The receiver's own wording, when the response carries one (queue add
    // says whether the video was added or the queue was full).
    ...check(response, 'message', tell),
    ...check(response, command.resultKey, () => [notify(command.success)], [notify(messages.unexpected)]),
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
