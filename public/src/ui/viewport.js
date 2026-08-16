/**
 * Keep the composer above the on-screen keyboard. iOS/Android often leave
 * `100dvh` covering the keyboard; visualViewport reports the visible height.
 */
function applyKeyboardInset() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
}

function initViewportInsets() {
  applyKeyboardInset();
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', applyKeyboardInset);
  vv.addEventListener('scroll', applyKeyboardInset);
}

export { applyKeyboardInset, initViewportInsets };
