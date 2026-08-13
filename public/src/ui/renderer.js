import { renderMarkdown } from '../markdown.js';
import { prefersReducedMotion, supportsInterpolateSize } from '../state.js';

/**
 * Progressive streaming renderer for assistant bubbles.
 * - rAF-gated: re-renders markdown at most once per animation frame (dirty flag)
 * - caret is a real element appended after the last rendered text (no ::after hack)
 * - smooth growth: `.bubble-grow` min-height eases toward the natural content
 *   height (`.bubble-inner`), so reflow-induced height oscillation breathes
 *   instead of jumping. Uses `interpolate-size`/transition when supported,
 *   else a per-tick lerp (~0.35).
 */
/**
 * Wrap the newly arrived plain-text tail in <span class="tok-in"> for blur-in.
 * Skips text inside code blocks. Survives full markdown re-render each rAF.
 */
function wrapFreshInkTail(root, deltaChars) {
  if (!root || deltaChars <= 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      let p = node.parentElement;
      while (p && p !== root) {
        const tag = p.tagName;
        if (
          tag === 'PRE' ||
          tag === 'CODE' ||
          p.classList.contains('code-block') ||
          p.classList.contains('code-card') ||
          p.classList.contains('code-head')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let remaining = deltaChars;
  for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
    const node = nodes[i];
    const t = node.textContent;
    const take = Math.min(remaining, t.length);
    if (take <= 0) continue;
    if (take >= t.length) {
      const span = document.createElement('span');
      span.className = 'tok-in';
      span.textContent = t;
      node.parentNode.replaceChild(span, node);
    } else {
      const keep = t.slice(0, t.length - take);
      const fresh = t.slice(t.length - take);
      const span = document.createElement('span');
      span.className = 'tok-in';
      span.textContent = fresh;
      node.textContent = keep;
      node.parentNode.insertBefore(span, node.nextSibling);
    }
    remaining -= take;
  }
}

/** One-time diagonal specular highlight across a finished assistant bubble */
function playCompletionSweep(bubble) {
  if (!bubble || prefersReducedMotion.matches) return;
  const sweep = document.createElement('span');
  sweep.className = 'bubble-sweep';
  sweep.setAttribute('aria-hidden', 'true');
  bubble.classList.add('has-sweep');
  bubble.appendChild(sweep);
  const cleanup = () => {
    sweep.remove();
    bubble.classList.remove('has-sweep');
  };
  sweep.addEventListener('animationend', cleanup, { once: true });
  setTimeout(cleanup, 1200);
}

/** One-time top→bottom reveal on fenced code blocks in finalized messages */
function playCodeBlockReveal(container) {
  if (!container || prefersReducedMotion.matches) return;
  // Skip restored history / already-revealed cards
  if (container.closest('.is-restored')) return;
  container.querySelectorAll('.code-card:not(.code-revealed)').forEach((card) => {
    card.classList.add('code-reveal', 'code-revealed');
    const done = () => card.classList.remove('code-reveal');
    card.addEventListener('animationend', done, { once: true });
    setTimeout(done, 600);
  });
}

/** Announce a single status line to screen readers via the live region */
function announceToScreenReader(text) {
  const el = document.getElementById('srAnnounce');
  if (!el) return;
  el.textContent = '';
  // Force a DOM change so polite live regions re-announce identical strings
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

function createStreamRenderer(bubble, { announce = true, sweep = true } = {}) {
  const grow = document.createElement('div');
  grow.className = 'bubble-grow';
  const inner = document.createElement('div');
  inner.className = 'bubble-inner';
  // Incremental pipeline: completed blocks freeze into `stableEl` (rendered
  // exactly once), only the in-progress tail re-renders per frame. Keeps
  // per-frame cost O(tail) instead of O(whole message) on long replies.
  const stableEl = document.createElement('div');
  stableEl.className = 'stream-stable';
  const tailEl = document.createElement('div');
  tailEl.className = 'stream-tail';
  inner.appendChild(stableEl);
  inner.appendChild(tailEl);
  grow.appendChild(inner);
  bubble.textContent = '';
  bubble.appendChild(grow);
  if (supportsInterpolateSize && !prefersReducedMotion.matches) {
    grow.classList.add('smooth-size');
  }

  const caret = document.createElement('span');
  caret.className = 'stream-caret';
  caret.setAttribute('aria-hidden', 'true');

  let raf = 0;
  let dirty = false;
  let content = '';
  let smoothH = 0;
  let done = false;
  let paintedLen = 0;
  let stableLen = 0; // chars of `content` frozen into stableEl
  let lastHeavyPaint = 0;
  // aria-busy while this bubble is actively streaming
  const msgEl = bubble.closest('.msg');
  if (msgEl) msgEl.setAttribute('aria-busy', 'true');

  /**
   * Last safe block boundary at/after `from`: the position just after a blank
   * line that sits OUTSIDE fenced code. `from` is always a previous cut, so
   * scanning starts at a line start with fences closed.
   */
  const findStableCut = (text, from) => {
    let cut = -1;
    let inFence = false;
    let i = from;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      const line = text.slice(i, nl);
      // A fence is closed by its OWN marker: ``` does not close ~~~. Toggling on
      // either one let a ``` inside a ~~~ block read as a close, so a blank line
      // that was really inside code was accepted as a safe cut and froze half a
      // code block into the finished region.
      const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        if (!inFence) inFence = marker;
        else if (inFence === marker) inFence = false;
      } else if (!inFence && line.trim() === '') cut = nl + 1;
      i = nl + 1;
    }
    return cut;
  };

  const placeCaret = () => {
    // Prefer inline placement inside the last text-bearing block of the tail
    // (falling back to the stable region, then the tail container itself)
    const source = tailEl.lastElementChild ? tailEl : stableEl.lastElementChild ? stableEl : tailEl;
    let host = source === tailEl && !tailEl.lastElementChild ? tailEl : source;
    const last = source.lastElementChild;
    if (last) {
      if (/^(P|H2|H3|H4|H5|BLOCKQUOTE)$/.test(last.tagName)) host = last;
      else if ((last.tagName === 'UL' || last.tagName === 'OL') && last.lastElementChild) {
        host = last.lastElementChild;
      } else {
        host = source;
      }
    }
    host.appendChild(caret);
  };

  const applyGrowth = () => {
    if (prefersReducedMotion.matches) return;
    const target = inner.offsetHeight;
    if (!target) return;
    if (supportsInterpolateSize) {
      // transition on min-height smooths both directions
      grow.style.minHeight = target + 'px';
      return;
    }
    if (!smoothH) smoothH = target;
    smoothH += (target - smoothH) * 0.35;
    // growth is instant (content defines height); the floor eases shrink-jitter
    grow.style.minHeight = Math.round(smoothH) + 'px';
  };

  const paint = () => {
    raf = 0;
    if (!dirty || done) return;

    // Reset path (retries): content no longer extends the frozen prefix
    if (content.length < stableLen) {
      stableEl.innerHTML = '';
      stableLen = 0;
      paintedLen = 0;
    }

    // A very large in-progress block (huge unclosed code fence) re-renders at
    // ~10fps instead of every frame; small tails stay per-frame smooth.
    const tailSize = content.length - stableLen;
    if (tailSize > 12_000) {
      const now = performance.now();
      if (now - lastHeavyPaint < 100) {
        if (!raf) raf = requestAnimationFrame(paint);
        return;
      }
      lastHeavyPaint = now;
    }
    dirty = false;

    const prevLen = paintedLen;
    paintedLen = content.length;
    const delta = Math.max(0, paintedLen - prevLen);

    // Freeze newly completed blocks (render once, append, never touch again)
    const cut = findStableCut(content, stableLen);
    if (cut > stableLen) {
      const chunk = content.slice(stableLen, cut).replace(/\n+$/, '');
      if (chunk) stableEl.insertAdjacentHTML('beforeend', renderMarkdown(chunk));
      stableLen = cut;
    }

    tailEl.innerHTML = renderMarkdown(content.slice(stableLen));
    // Fresh-ink blur-in on newly arrived tail (skipped under reduced motion)
    if (!prefersReducedMotion.matches && delta > 0) {
      wrapFreshInkTail(tailEl, Math.min(delta, 80));
    }
    placeCaret();
    applyGrowth();
  };

  const stop = () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    caret.remove();
    grow.style.minHeight = '';
    grow.classList.remove('smooth-size');
    if (msgEl) msgEl.removeAttribute('aria-busy');
  };

  return {
    update(text) {
      if (done) return;
      content = text;
      dirty = true;
      if (!raf) raf = requestAnimationFrame(paint);
    },
    /** Final formatted render (cancels pending frame, removes caret) */
    finish(finalText) {
      stop();
      const final = finalText != null ? finalText : content;
      // One clean full render normalizes any chunk-boundary differences
      inner.innerHTML = renderMarkdown(final);
      if (sweep) playCompletionSweep(bubble);
      playCodeBlockReveal(inner);
      if (announce) announceToScreenReader('Assistant reply finished');
    },
    /** Final plain-text render (placeholder messages) */
    finishPlain(text) {
      stop();
      inner.textContent = text;
      if (announce) announceToScreenReader('Assistant reply finished');
    }
  };
}

export { announceToScreenReader, createStreamRenderer, playCodeBlockReveal, playCompletionSweep, wrapFreshInkTail };
