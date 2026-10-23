import '../config.js';
import { watchUrl } from '../youtube/video-url.mjs';
import { queueDropIndex, queueListModel, queueRowKind, reorderUpcoming } from './state.mjs';
import { setAttribute, setClass, setProperty } from './dom-state.mjs';

const { queue } = globalThis.VAN_TV_CONFIG;
const dragThreshold = 5;
const scrollEdge = 28;
const scrollSpeed = 8;
// Enough of the newest played row to show part of its title, not just padding,
// so the list visibly continues upward.
const historyPeek = 0.55;
const minHistoryPeek = 20;
const iconPaths = Object.freeze({
  open: 'M14 4h6v6m0-6L10 14m0-10H4v16h16v-6',
  remove: 'M6 6l12 12M18 6 6 18',
  drag: 'M8 6h1m6 0h1M8 12h1m6 0h1M8 18h1m6 0h1',
});

function iconButton(name, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button queue-${name}`;
  button.dataset.control = name;
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name]);
  svg.append(path);
  button.append(svg);
  return button;
}

export class QueueList {
  constructor({ list, section, jumpButton, onAction, onOpen }) {
    this.list = list;
    this.section = section;
    this.jumpButton = jumpButton;
    this.onAction = onAction;
    this.onOpen = onOpen;
    this.model = queueListModel(null);
    this.latestModel = this.model;
    this.signature = '';
    this.anchored = false;
    this.busy = false;
    this.drag = null;
    this.pendingMove = false;
    this.frame = null;
    this.onScroll = () => this.updateFade();
    this.onPointerMove = event => this.pointerMove(event);
    this.onPointerUp = event => {
      if (event.pointerId === this.drag?.pointerId) this.finishDrag(true);
    };
    this.onPointerCancel = event => {
      if (event.pointerId === this.drag?.pointerId) this.finishDrag(false);
    };
    this.onKeyDown = event => {
      if (event.key === 'Escape' && this.drag) {
        event.preventDefault();
        this.finishDrag(false);
      }
    };
    list.addEventListener('scroll', this.onScroll);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    this.resizeObserver = new ResizeObserver(() => {
      this.sizeAnchorSpace();
      this.updateFade();
    });
    this.resizeObserver.observe(list);
  }

  render(model) {
    this.latestModel = model;
    // Keep pointer geometry and the optimistic order stable until the write settles.
    if (this.drag || this.pendingMove) return;
    this.apply(model);
  }

  apply(model) {
    const signature = JSON.stringify(model);
    if (signature === this.signature) return;
    const anchor = !this.anchored || model.currentId !== this.model.currentId;
    const focused = this.list.contains(document.activeElement) ? document.activeElement : null;
    const focusedRow = focused?.closest('li')?.dataset.row;
    const focusedControl = focused?.dataset.control;
    const scrollTop = this.list.scrollTop;
    this.signature = signature;
    this.model = model;
    this.section.hidden = model.rows.length === 0;
    this.list.replaceChildren(...model.rows.map(entry => this.createRow(entry)));
    this.sizeAnchorSpace();
    this.list.scrollTop = scrollTop;
    if (anchor) this.anchor();
    if (focusedRow) {
      const row = [...this.list.children].find(item => item.dataset.row === focusedRow);
      const control = focusedControl && [...(row?.querySelectorAll('[data-control]') ?? [])]
        .find(item => item.dataset.control === focusedControl);
      (control || row)?.focus({ preventScroll: true });
    }
    this.setBusy(this.busy);
    this.updateFade();
  }

  anchorGeometry() {
    const target = this.list.children[this.model.anchorIndex];
    if (!target) return null;
    const previous = target.previousElementSibling;
    const height = previous?.dataset.kind === queueRowKind.played ? previous.getBoundingClientRect().height : 0;
    const peek = height && Math.min(height, Math.max(minHistoryPeek, height * historyPeek));
    return { target, peek };
  }

  sizeAnchorSpace() {
    const geometry = this.anchorGeometry();
    const last = this.list.lastElementChild;
    const contentHeight = last ? last.offsetTop + last.offsetHeight : 0;
    let padding = 0;
    // Only an overflowing list needs space to anchor near its end. Short lists
    // should show every row, including history, without creating a scrollbar.
    if (geometry && contentHeight > this.list.clientHeight) {
      const below = contentHeight - geometry.target.offsetTop;
      padding = Math.max(0, this.list.clientHeight - below - geometry.peek);
    }
    setProperty(this.list.style, 'paddingBottom', `${padding}px`);
  }

  anchor() {
    const geometry = this.anchorGeometry();
    this.anchored = Boolean(geometry);
    if (!geometry) return;
    this.list.scrollTop = Math.max(0, geometry.target.offsetTop - geometry.peek);
  }

  updateFade() {
    setClass(this.list, 'is-scrolled', this.list.scrollTop > 1);
    if (this.jumpButton) setProperty(this.jumpButton, 'disabled', this.list.scrollTop >= this.endScrollTop() - 1);
  }

  // The anchoring spacer pads the list's tail, so "the end" is where the last
  // row's bottom meets the viewport's, not the scrollable maximum.
  endScrollTop() {
    const last = this.list.lastElementChild;
    if (!last) return 0;
    return Math.max(0, last.offsetTop + last.offsetHeight - this.list.clientHeight);
  }

  jumpToEnd() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.list.scrollTo({ top: this.endScrollTop(), behavior: reduced ? 'auto' : 'smooth' });
  }

  setBusy(busy) {
    this.busy = busy;
    for (const button of this.list.querySelectorAll('.queue-remove')) setProperty(button, 'disabled', busy);
    for (const handle of this.list.querySelectorAll('.queue-drag')) {
      // Keep keyboard focus on the grip across its own move request.
      setAttribute(handle, 'aria-disabled', busy);
    }
    for (const link of this.list.querySelectorAll('.queue-play')) {
      setAttribute(link, 'aria-disabled', busy);
    }
  }

  createRow(entry) {
    const row = document.createElement('li');
    row.className = `queue-row queue-${entry.kind}`;
    row.dataset.kind = entry.kind;
    row.dataset.row = entry.kind === queueRowKind.current ? `current-${entry.id}` : String(entry.key);
    if (entry.kind === queueRowKind.upcoming) {
      row.tabIndex = 0;
      const handle = iconButton('drag', 'Drag to reorder; Alt+ArrowUp/Down moves one place');
      handle.addEventListener('pointerdown', event => this.startDrag(event, entry, row, handle));
      handle.addEventListener('lostpointercapture', () => this.finishDrag(false));
      row.append(handle);
      row.addEventListener('keydown', event => this.keyboardMove(event, entry));
    }
    if (entry.kind === queueRowKind.current) {
      row.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'queue-current-title';
      const label = document.createElement('small');
      label.textContent = 'Now playing';
      const text = document.createElement('span');
      text.textContent = entry.title;
      title.append(label, text);
      row.append(title);
    } else row.append(this.createTitle(entry));
    const open = iconButton('open', 'Open on YouTube');
    open.addEventListener('click', () => void this.onOpen(watchUrl(entry.id), false));
    row.append(open);
    if (entry.kind === queueRowKind.upcoming) {
      const remove = iconButton('remove', `Remove from queue: ${entry.title}`);
      remove.addEventListener('click', () => {
        if (!this.busy) void this.onAction({ action: queue.remove, key: entry.key });
      });
      row.append(remove);
    }
    return row;
  }

  createTitle(entry) {
    const link = document.createElement('a');
    link.className = 'queue-play';
    link.dataset.control = 'title';
    link.href = watchUrl(entry.id);
    link.draggable = false;
    link.textContent = entry.title;
    const action = entry.kind === queueRowKind.played ? 'Play again' : 'Play now';
    link.title = `${action}: ${entry.title}\n⌘/Ctrl-click or middle-click opens YouTube in a background tab`;
    link.addEventListener('click', event => {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) void this.onOpen(link.href, true);
      else if (!this.busy && !this.drag) void this.onAction({ action: queue.play, key: entry.key });
    });
    link.addEventListener('auxclick', event => {
      if (event.button !== 1) return;
      event.preventDefault();
      void this.onOpen(link.href, true);
    });
    return link;
  }

  keyboardMove(event, entry) {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (this.busy || this.drag || this.pendingMove) return;
    const rows = this.model.rows.filter(row => row.kind === queueRowKind.upcoming);
    const index = rows.findIndex(row => row.key === entry.key);
    void this.move(entry.key, index + (event.key === 'ArrowUp' ? -1 : 1));
  }

  startDrag(event, entry, row, handle) {
    if (event.button !== 0 || this.busy || this.drag || this.pendingMove) return;
    this.drag = { key: entry.key, row, handle, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, y: event.clientY, active: false, index: 0 };
    handle.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < dragThreshold) return;
    event.preventDefault();
    drag.active = true;
    drag.row.classList.add('is-dragging');
    this.list.classList.add('is-dragging');
    this.updateDrop();
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  clearDrop() {
    for (const row of this.list.children) row.classList.remove('drop-before', 'drop-after');
  }

  updateDrop() {
    this.clearDrop();
    const rows = [...this.list.children].filter(row => row.dataset.kind === queueRowKind.upcoming
      && row !== this.drag.row);
    const centers = rows.map(row => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    this.drag.index = queueDropIndex(centers, this.drag.y);
    if (rows[this.drag.index]) rows[this.drag.index].classList.add('drop-before');
    else rows.at(-1)?.classList.add('drop-after');
  }

  autoScroll() {
    this.frame = null;
    if (!this.drag?.active) return;
    const rect = this.list.getBoundingClientRect();
    const above = Math.max(0, Math.min(1, (rect.top + scrollEdge - this.drag.y) / scrollEdge));
    const below = Math.max(0, Math.min(1, (this.drag.y - rect.bottom + scrollEdge) / scrollEdge));
    this.list.scrollTop += (below - above) * scrollSpeed;
    this.updateDrop();
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  finishDrag(commit) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    drag.row.classList.remove('is-dragging');
    this.list.classList.remove('is-dragging');
    this.clearDrop();
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    if (commit && drag.active) void this.move(drag.key, drag.index);
    else this.render(this.latestModel);
  }

  async move(key, index) {
    if (this.busy) { this.render(this.latestModel); return; }
    const optimistic = reorderUpcoming(this.model, key, index);
    if (optimistic === this.model) {
      this.render(this.latestModel);
      return;
    }
    const finalIndex = optimistic.rows.filter(row => row.kind === queueRowKind.upcoming)
      .findIndex(row => row.key === key);
    this.pendingMove = true;
    this.apply(optimistic);
    try { await this.onAction({ action: queue.move, key, index: finalIndex }); }
    finally {
      this.pendingMove = false;
      this.render(this.latestModel);
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.finishDrag(false);
    this.list.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
