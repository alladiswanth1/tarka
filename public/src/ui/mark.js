import { isStreaming, prefersReducedMotion } from '../state.js';

/* ============================================================
   THE MARK — "Council". Three seats around one core; the lit seat
   is whoever's turn it is. The CSS drives the mount / streaming /
   consensus / hover states off classes; this block owns the two
   things CSS cannot: dropping the one-shot intro class, and the
   favicon, which deliberates in the tab while you are elsewhere.
   ============================================================ */
const MARK_SVG =
  '<svg class="tk-mark is-intro" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
  '<circle class="tk-ring" cx="16" cy="16" r="10.6" transform="rotate(-90 16 16)"/>' +
  '<circle class="tk-seat tk-seat-1 is-lead" cx="16" cy="5.4" r="2.5"/>' +
  '<circle class="tk-seat tk-seat-2" cx="25.18" cy="21.3" r="2.5"/>' +
  '<circle class="tk-seat tk-seat-3" cx="6.82" cy="21.3" r="2.5"/>' +
  '<path class="tk-core" d="M16 12.2 19.8 16 16 19.8 12.2 16Z"/>' +
  '</svg>';

/**
 * The build-in must be one-shot. If `.is-intro` stayed on the element, then
 * every time `body.is-streaming` cleared, the base rule would re-apply and the
 * mark would replay its intro after every single reply.
 */
function primeMarks(root = document) {
  root.querySelectorAll('.tk-mark.is-intro').forEach((el) => {
    setTimeout(() => el.classList.remove('is-intro'), 1100);
  });
}

/** One-shot "the team agreed" flash on every visible mark, and on the tab icon. */
let faviconAgreedFlashUntil = 0;

function flashMarkAgreed() {
  document.querySelectorAll('.tk-mark').forEach((el) => {
    el.classList.remove('is-agreed');
    void el.offsetWidth; // restart the one-shot
    el.classList.add('is-agreed');
    setTimeout(() => el.classList.remove('is-agreed'), 1000);
  });
  if (prefersReducedMotion.matches) return;
  faviconAgreedFlashUntil = performance.now() + 1000;
  setFaviconLead('all');
  setTimeout(() => {
    faviconAgreedFlashUntil = 0;
    if (!isStreaming) setFaviconLead(0);
  }, 1000);
}

/* ---------- favicon: the same mark, deliberating in the tab ---------- */
const FAVICON_STEP_MS = 520;

let faviconTimer = 0;

let faviconLead = 0;

/**
 * Raw SVG source — colours written as literal `#rrggbb`, NOT pre-escaped.
 * setFaviconLead() runs this through encodeURIComponent; a `%23` here would be
 * re-encoded to `%2523`, and the browser would decode back to the literal text
 * "%2314171f", which is not a colour — the whole mark renders black.
 */
function faviconSvg(lead) {
  const op = (i) => (lead === 'all' || lead === i ? '1' : '.38');
  return (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<rect width='32' height='32' rx='7' fill='#14171f'/>" +
    "<g transform='translate(16 16) scale(.92) translate(-16 -16)'>" +
    "<circle cx='16' cy='16' r='10.6' fill='none' stroke='#818cf8' stroke-width='1.6' stroke-opacity='.5'/>" +
    "<circle cx='16' cy='5.4' r='2.5' fill='#818cf8' fill-opacity='" + op(0) + "'/>" +
    "<circle cx='25.18' cy='21.3' r='2.5' fill='#818cf8' fill-opacity='" + op(1) + "'/>" +
    "<circle cx='6.82' cy='21.3' r='2.5' fill='#818cf8' fill-opacity='" + op(2) + "'/>" +
    "<path d='M16 12.2 19.8 16 16 19.8 12.2 16Z' fill='#818cf8'/>" +
    "</g></svg>"
  );
}

function setFaviconLead(lead) {
  const link = document.getElementById('favicon');
  if (!link) return;
  link.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(faviconSvg(lead)));
}

/** While a turn runs, the lit seat walks the ring about twice a second. */
function setFaviconThinking(on) {
  if (faviconTimer) {
    clearInterval(faviconTimer);
    faviconTimer = 0;
  }
  if (!on) {
    faviconLead = 0;
    // The debate engine's finally calls this synchronously right after
    // flashMarkAgreed() — resetting here wiped the "all seats lit" consensus
    // favicon before the browser ever painted it. Let the flash's own
    // timeout do the reset.
    if (performance.now() < faviconAgreedFlashUntil) return;
    setFaviconLead(0);
    return;
  }
  if (prefersReducedMotion.matches) return;
  faviconTimer = setInterval(() => {
    faviconLead = (faviconLead + 1) % 3;
    setFaviconLead(faviconLead);
  }, FAVICON_STEP_MS);
}

export { FAVICON_STEP_MS, MARK_SVG, faviconLead, faviconSvg, faviconTimer, flashMarkAgreed, primeMarks, setFaviconLead, setFaviconThinking };
