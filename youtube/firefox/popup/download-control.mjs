import { downloadControlModel } from './saved-state.mjs';
import { setAttribute, setProperty, setText } from './dom-state.mjs';

const { downloadState } = globalThis.VAN_TV_CONFIG;
const statePaths = Object.freeze({
  [downloadState.saved]: 'm5 12 4 4L19 6',
  [downloadState.finalizing]: 'M7 3h10v4l-5 5 5 5v4H7v-4l5-5-5-5ZM7 3h10M7 21h10',
  [downloadState.error]: 'm12 3 10 18H2Zm0 6v5m0 3v.1',
});

export class DownloadControl {
  constructor(button, progress, onDownload) {
    Object.assign(this, { button, progress });
    this.icon = button.querySelector('path');
    this.downloadPath = this.icon.getAttribute('d');
    button.addEventListener('click', onDownload);
  }

  render(status, busy = false) {
    const view = downloadControlModel(status, busy);
    setProperty(this.button, 'hidden', view.hidden);
    setProperty(this.button, 'disabled', view.disabled);
    setProperty(this.button, 'title', view.label);
    setAttribute(this.button, 'aria-label', view.label);
    setAttribute(this.button, 'data-state', view.state);
    setAttribute(this.icon, 'd', statePaths[view.state] ?? this.downloadPath);
    setText(this.progress, view.progress);
  }
}
