// The keyboard route to the Quality menu. A change reloads the video, so
// arrowing across the choices only marks one; Apply (or Enter) sends it.
// The menu stays the source of its options, selection and availability.
export class QualityPicker {
  constructor(dialog, select, change) {
    Object.assign(this, { dialog, select, choices: dialog.querySelector('fieldset') });
    dialog.querySelector('form').addEventListener('submit', () => {
      const chosen = this.choices.querySelector(':checked')?.value;
      if (chosen && chosen !== select.value) change(chosen);
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  }

  get open() { return this.dialog.open; }

  toggle() {
    if (this.dialog.open) this.dialog.close();
    else if (!this.select.disabled) this.show();
  }

  show() {
    const document = this.dialog.ownerDocument;
    const legend = this.choices.querySelector('legend');
    this.choices.replaceChildren(legend, ...[...this.select.options].map(option => {
      const label = document.createElement('label');
      const input = Object.assign(document.createElement('input'), {
        type: 'radio', name: 'quality', value: option.value, checked: option.value === this.select.value,
      });
      label.append(input, option.text);
      if (input.checked) label.append(Object.assign(document.createElement('small'), { textContent: 'current' }));
      return label;
    }));
    this.dialog.showModal();
    this.choices.querySelector(':checked')?.focus();
  }
}
