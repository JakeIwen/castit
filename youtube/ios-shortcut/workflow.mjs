import { action, attachment, condition, conditional, dictionary, menu, output, text } from './workflow-format.mjs';

const name = 'Van TV';
const messages = Object.freeze({
  prompt: 'YouTube link (paste or use the clipboard suggestion)',
  noUrl: 'No URL found. Share a YouTube link or paste one when running Van TV directly.',
  queueFull: 'The Van TV queue is full',
  unexpected: 'Van TV returned an unexpected response',
  networkHelp: 'If Get Contents of URL stops with a connection error: Van TV unreachable — are you on the van Wi-Fi? Shortcuts cannot catch network errors. The phone cannot be its own hotspot.',
});
const commands = Object.freeze([
  { title: 'Cast', path: '/api/cast', body: {}, resultKey: 'videoId', success: 'Casting on Van TV' },
  { title: 'Add to Queue', path: '/api/queue', body: { action: 'add' }, resultKey: 'done', success: 'Added to the Van TV queue' },
]);

function notify(body) {
  return action('notification', {
    WFNotificationActionTitle: name, WFNotificationActionBody: text(body), WFNotificationActionSound: false,
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

function requestActions(baseUrl, url, command) {
  const request = action('downloadurl', {
    WFURL: `${baseUrl}${command.path}`, WFHTTPMethod: 'POST', WFHTTPBodyType: 'JSON',
    Advanced: true, ShowHeaders: true,
    WFHTTPHeaders: dictionary({ 'Content-Type': 'application/json' }),
    WFJSONValues: dictionary({ ...command.body, url }),
  });
  return [request, ...responseActions(request, command)];
}

// Links live in a named variable: an If block's "If Result" output didn't
// resolve on the phone, so shared links reached URL detection empty.
const links = attachment({ Type: 'Variable', VariableName: 'Links' });

function setLinks(urls) {
  return action('setvariable', { WFVariableName: 'Links', WFInput: output(urls, 'URLs') });
}

// Share-sheet links first; asking (prefilled from the clipboard) only when
// nothing usable was shared, e.g. when run directly.
function inputActions() {
  const shared = action('detect.link', { WFInput: attachment({ Type: 'ExtensionInput' }) });
  const clipboard = action('getclipboard');
  const ask = action('ask', {
    WFAskActionPrompt: messages.prompt, WFInputType: 'Text', WFAllowsMultilineText: true,
    WFAskActionDefaultAnswer: text(output(clipboard, 'Clipboard')),
  });
  const typed = action('detect.link', { WFInput: output(ask, 'Provided Input') });
  return [shared, setLinks(shared),
    ...conditional(links, condition.isEmpty, [clipboard, ask, typed, setLinks(typed)])];
}

export function createWorkflow(baseUrl) {
  const inputs = inputActions();
  const first = action('getitemfromlist', { WFInput: links, WFItemSpecifier: 'First Item' });
  return {
    WFWorkflowName: name,
    WFWorkflowClientVersion: '4711',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59851 },
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowInputContentItemClasses: ['WFURLContentItem', 'WFStringContentItem', 'WFRichTextContentItem', 'WFSafariWebPageContentItem'],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowImportQuestions: [],
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowNoInputBehavior: {},
    WFWorkflowActions: [
      action('comment', { WFCommentActionText: messages.networkHelp }),
      ...inputs,
      ...conditional(links, condition.isEmpty, [
        action('alert', {
          WFAlertActionTitle: name, WFAlertActionMessage: messages.noUrl, WFAlertActionCancelButtonShown: false,
        }),
        action('exit'),
      ]),
      first,
      ...menu(name, commands.map(command => ({
        title: command.title, actions: requestActions(baseUrl, output(first, 'Item from List'), command),
      }))),
    ],
  };
}
