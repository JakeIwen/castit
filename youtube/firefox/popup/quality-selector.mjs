// Options come from receiver capabilities, so old receivers and future choices
// require no duplicated resolution list in the extension.
export class QualitySelector {
  constructor(select, status, retry, change) {
    Object.assign(this, { select, status, retry });
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
    if (quality) this.select.value = quality.selected;
    this.select.disabled = busy || !enabled || !quality;
    this.retry.hidden = !quality?.error;
    this.retry.disabled = this.select.disabled || Boolean(quality?.loading);
    this.select.setAttribute('aria-busy', String(Boolean(quality?.loading)));
    this.status.textContent = !quality ? 'Quality unavailable'
      : quality.loading ? 'Applying…' : quality.error ? 'Quality change failed' : '';
  }
}
