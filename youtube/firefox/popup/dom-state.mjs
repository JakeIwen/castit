// Avoid replacing unchanged text and attributes in the auto-sized popup.
// Background polls should leave layout and accessibility state undisturbed.
export function setProperty(node, name, value) {
  if (node[name] !== value) node[name] = value;
}

export function setAttribute(node, name, value) {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

export function setClass(node, name, enabled) {
  if (node.classList.contains(name) !== enabled) node.classList.toggle(name, enabled);
}

export function setBooleanAttribute(node, name, enabled) {
  if (node.hasAttribute(name) !== enabled) node.toggleAttribute(name, enabled);
}

export const setText = (node, text) => setProperty(node, 'textContent', text);
