import { createReceiverClient } from './receiver-client.mjs';
import { createMessageHandler, installCommands, installContextMenus, installRemoteAction, installSidebarShortcut } from './actions.mjs';
import { createVideoDetails } from './video-details.mjs';

const receiver = createReceiverClient();
browser.runtime.onMessage.addListener(createMessageHandler(browser, receiver, createVideoDetails()));
installCommands(browser, receiver);
installRemoteAction(browser);
installSidebarShortcut(browser);
void installContextMenus(browser, receiver).catch(error => {
  console.error('Van TV context menu setup failed', error);
});
