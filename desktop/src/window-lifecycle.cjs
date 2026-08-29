"use strict";

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed());
}

function visibleWindowOrUndefined(window) {
  return isUsableWindow(window) && window.isVisible() ? window : undefined;
}

function focusOrReconnectMainWindow(options) {
  let window = options.getWindow();
  if (!isUsableWindow(window)) {
    window = options.createWindow();
    options.setWindow(window);
    options.reconnect();
    return "reconnect";
  }
  if (!window.isVisible()) {
    options.reconnect();
    return "reconnect";
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return "focus";
}

module.exports = {
  isUsableWindow,
  visibleWindowOrUndefined,
  focusOrReconnectMainWindow,
};
