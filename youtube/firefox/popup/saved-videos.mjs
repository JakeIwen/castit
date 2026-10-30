import '../config.js';
import { downloadActive, savedLibraryModel } from './saved-state.mjs';
import { setProperty, setText } from './dom-state.mjs';

const config = globalThis.VAN_TV_CONFIG;

export class SavedVideos {
  constructor({ before, load, act, onChanged = () => {} }) {
    Object.assign(this, { load, act, onChanged, pending: false, busy: false, destroyed: false });
    this.document = before.ownerDocument;
    this.details = this.make('details', 'saved-videos');
    this.details.append(this.make('summary', '', 'Saved'));
    this.message = this.make('p', 'saved-message');
    this.message.setAttribute('role', 'status');
    this.content = this.make('div', 'saved-content');
    this.details.append(this.message, this.content);
    before.before(this.details);
    this.details.addEventListener('toggle', () => {
      clearTimeout(this.timer);
      if (this.details.open) void this.refresh();
    });
  }

  make(tag, className = '', text = '') {
    const node = this.document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  button(text, title, operation) {
    const button = this.make('button', '', text);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', operation);
    return button;
  }

  setBusy(busy) {
    this.busy = busy;
    for (const button of this.content.querySelectorAll('button')) {
      setProperty(button, 'disabled', busy || this.pending);
    }
  }

  async refresh() {
    clearTimeout(this.timer);
    if (!this.details.open || this.destroyed) return;
    // An action requests another read even if an earlier read is in flight.
    const request = this.request = (this.request ?? 0) + 1;
    try {
      const library = await this.load();
      if (this.destroyed || request !== this.request) return;
      this.render(library);
      if (this.details.open && library.downloads.some(downloadActive)) {
        this.timer = setTimeout(() => void this.refresh(), config.pollIntervalMs);
      }
    } catch (error) {
      if (request === this.request && !this.destroyed) setText(this.message, error.message);
    }
  }

  render(library) {
    const model = savedLibraryModel(library);
    const signature = JSON.stringify(model);
    if (signature !== this.signature) {
      this.signature = signature;
      // Download labels update in place; they must not steal Delete confirmation
      // or keyboard focus from a saved row as a background download advances.
      const structure = JSON.stringify(model.channels);
      if (structure !== this.structure) {
        this.structure = structure;
        this.content.replaceChildren();
        this.downloads = this.make('div', 'saved-downloads');
        this.content.append(this.downloads);
        this.downloadRows = new Map();
        for (const group of model.channels) this.renderChannel(group);
      }
      const ids = new Set(model.downloads.map(item => item.id));
      for (const [id, row] of this.downloadRows) {
        if (!ids.has(id)) { row.remove(); this.downloadRows.delete(id); }
      }
      for (const item of model.downloads) {
        let row = this.downloadRows.get(item.id);
        if (!row) {
          row = this.make('p', 'saved-download');
          this.downloadRows.set(item.id, row);
          this.downloads.append(row);
        }
        setText(row, `${item.title} · ${item.label}`);
      }
    }
    setText(this.message, model.message);
    this.setBusy(this.busy);
  }

  renderChannel(group) {
    const section = this.make('section', 'saved-channel');
    section.append(this.make('h3', '', group.channel));
    const list = this.make('ul');
    for (const video of group.videos) list.append(this.videoRow(video));
    section.append(list);
    this.content.append(section);
  }

  videoRow(video) {
    const row = this.make('li', 'saved-video');
    row.append(this.make('span', 'saved-title', video.title), this.make('small', 'saved-meta', video.detail));
    const actions = this.make('div', 'saved-actions');
    const play = this.button('Play', `Play ${video.title}`, () => void this.perform(config.message.cast,
      { videoId: video.id, position: 0, title: video.title }));
    const queue = this.button('Queue', `Queue ${video.title}`, () => void this.perform(config.message.queue,
      { action: config.queue.add, videoId: video.id, title: video.title }));
    const confirm = this.make('div', 'saved-confirm');
    confirm.hidden = true;
    confirm.append(this.make('span', '', 'Delete saved copy?'));
    const remove = this.button('Delete', `Delete ${video.title}`, () => {
      confirm.hidden = false;
      actions.hidden = true;
      cancel.focus();
    });
    const cancel = this.button('Cancel', 'Keep saved copy', () => {
      confirm.hidden = true;
      actions.hidden = false;
      remove.focus();
    });
    confirm.append(this.button('Delete', `Confirm delete ${video.title}`, () => void this.perform(config.message.control,
      { action: config.control.deleteSaved, id: video.id })), cancel);
    actions.append(play, queue, remove);
    row.append(actions, confirm);
    return row;
  }

  async perform(type, fields) {
    if (this.pending || this.busy) return;
    this.pending = true;
    this.setBusy(this.busy);
    let error;
    try {
      const result = await this.act(type, fields);
      if (result.done === false) throw new Error('Van TV could not complete this action');
    } catch (failure) { error = failure.message; }
    finally {
      await this.refresh();
      this.pending = false;
      this.setBusy(this.busy);
      void this.onChanged();
    }
    if (error) setText(this.message, error);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
  }
}
