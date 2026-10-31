import { keymap } from './keyboard-shortcuts.mjs';

// The help lists the same keymap the shortcuts run from, so the two can't drift.
export class KeyboardHelp {
  constructor(dialog) {
    this.dialog = dialog;
    const document = dialog.ownerDocument;
    dialog.querySelector('dl').replaceChildren(...keymap.flatMap(entry => {
      const keys = document.createElement('dt');
      keys.append(...entry.names.map(name => Object.assign(document.createElement('kbd'), { textContent: name })));
      const label = document.createElement('dd');
      label.textContent = entry.label;
      return [keys, label];
    }));
  }

  get open() { return this.dialog.open; }

  toggle() {
    if (this.dialog.open) this.dialog.close();
    else this.dialog.showModal();
  }
}
