import { setAttribute, setProperty, setText } from './dom-state.mjs';

// Options come from receiver capabilities, so old receivers and future choices
// require no duplicated resolution list in the extension.
export class QualitySelector {
  constructor(select, status, retry, change) {
    Object.assign(this, { select, status, retry, title: select.title });
    select.addEventListener('change', () => change(select.value));
    retry.addEventListener('click', () => change(select.value));
  }

  render(quality, enabled, busy) {
    const options = quality?.options ?? [];
    const signature = JSON.stringify(options);
    if (signature !== this.signature) {
      this.signature = signature;
      this.select.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));
      if (!options.length) this.select.add(new Option('Unavailable', ''));
    }
    if (quality) setProperty(this.select, 'value', quality.selected);
    setProperty(this.select, 'disabled', busy || !enabled || !quality);
    setProperty(this.select, 'title', quality ? this.title : 'Quality unavailable on this receiver');
    setProperty(this.retry, 'hidden', !quality?.error);
    setProperty(this.retry, 'disabled', this.select.disabled || Boolean(quality?.loading));
    setAttribute(this.select, 'aria-busy', Boolean(quality?.loading));
    setText(this.status, quality?.loading ? 'Applying…' : quality?.error ? 'Quality change failed' : '');
  }
}
