import { loadProgressModel } from './state.mjs';
import { setAttribute, setBooleanAttribute, setClass, setProperty, setText } from './dom-state.mjs';

export class LoadProgress {
  constructor({ root, playback, label, bar, fill }) {
    Object.assign(this, { root, playback, label, bar, fill });
    this.loading = null;
    this.sampleTime = 0;
  }

  update(loading, now = performance.now()) {
    this.loading = loading ?? null;
    this.sampleTime = now;
  }

  render(now = performance.now()) {
    const view = loadProgressModel(this.loading, (now - this.sampleTime) / 1000);
    setBooleanAttribute(this.root, 'hidden', !view);
    // Keep the seek/time area's height while removing its controls from focus
    // and accessibility navigation during the load.
    setClass(this.playback, 'is-loading', Boolean(view));
    setAttribute(this.playback, 'aria-hidden', Boolean(view));
    if (!view) return false;
    setText(this.label, view.label);
    setAttribute(this.bar, 'aria-valuetext', view.label);
    setClass(this.bar, 'indeterminate', view.indeterminate);
    if (view.indeterminate) setBooleanAttribute(this.bar, 'aria-valuenow', false);
    else setAttribute(this.bar, 'aria-valuenow', view.percent);
    setProperty(this.fill.style, 'transform', `scaleX(${view.percent === null ? 0.35 : view.percent / 100})`);
    return true;
  }
}
