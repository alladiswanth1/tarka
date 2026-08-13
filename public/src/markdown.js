/**
 * Markdown renderer and the zero-dependency syntax highlighter.
 *
 * SAFETY CONTRACT: every path that reaches innerHTML goes through escapeHtml
 * first. Fenced code is pulled out on the RAW text (so the highlighter sees
 * real characters), highlighted with escaped output, and re-inserted through
 * \x00CODE<n>\x00 placeholders; everything else is escaped before any inline
 * transform runs. Links are restricted to http(s). Model output is untrusted
 * input — keep it that way when editing this file.
 *
 * Pure: no DOM reads, no app state. Safe to unit test in plain Node.
 */

// ========== Markdown (lightweight, safe) ==========
function escapeHtml(str) {
  // null/undefined render as empty, not as the literal "null" — matches
  // escapeHtmlText() on the server side.
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Zero-dependency syntax highlighter (safe: output is fully escaped) ----
const HL_ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', python3: 'py',
  shell: 'sh', bash: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh',
  yml: 'yaml',
  'c++': 'c', cpp: 'c', h: 'c', hpp: 'c', cc: 'c', java: 'c', kotlin: 'c', kt: 'c',
  'c#': 'c', cs: 'c', csharp: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c',
  swift: 'c', dart: 'c', scala: 'c', php: 'c',
  xml: 'html', svg: 'html', vue: 'html',
  scss: 'css', less: 'css',
  rb: 'ruby'
};

const HL_KEYWORDS = {
  js: 'abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|private|protected|public|readonly|return|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield',
  ts: 'abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|never|new|number|of|private|protected|public|readonly|return|satisfies|set|static|string|super|switch|this|throw|try|type|typeof|unknown|var|void|while|yield',
  py: 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case|self',
  c: 'abstract|auto|base|bool|break|case|catch|chan|char|class|const|constexpr|continue|crate|def|default|defer|delete|do|double|dyn|else|enum|extern|final|float|fn|for|func|go|goto|if|impl|import|in|inline|int|interface|internal|let|long|loop|map|match|mod|move|mut|namespace|new|nil|operator|out|override|package|private|protected|pub|public|range|ref|return|select|self|short|signed|sizeof|static|struct|super|switch|template|this|throw|throws|trait|try|type|typedef|typename|uint|union|unsafe|unsigned|use|using|var|virtual|void|volatile|where|while',
  sh: 'alias|break|case|cd|continue|do|done|echo|elif|else|esac|exit|export|fi|for|function|if|in|local|printf|read|return|set|shift|source|then|trap|until|while',
  sql: 'ADD|ALL|ALTER|AND|AS|ASC|BETWEEN|BY|CASE|CHECK|COLUMN|CONSTRAINT|CREATE|CROSS|DATABASE|DEFAULT|DELETE|DESC|DISTINCT|DROP|ELSE|END|EXISTS|FOREIGN|FROM|FULL|GROUP|HAVING|IF|IN|INDEX|INNER|INSERT|INTO|IS|JOIN|KEY|LEFT|LIKE|LIMIT|NOT|NULL|OFFSET|ON|OR|ORDER|OUTER|PRIMARY|REFERENCES|RIGHT|SELECT|SET|TABLE|THEN|UNION|UNIQUE|UPDATE|VALUES|VIEW|WHEN|WHERE|WITH',
  ruby: 'alias|and|begin|break|case|class|def|defined\\?|do|else|elsif|end|ensure|for|if|in|module|next|not|or|raise|redo|require|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield'
};

const HL_BOOLEANS = 'true|false|null|undefined|None|True|False|nil|NULL|NaN|Infinity';

/** Build [regexSource, cssClass] alternation for one language family. */
function hlParts(lang) {
  const kw = HL_KEYWORDS[lang];
  const num = '\\b(?:0[xXbBoO][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';
  switch (lang) {
    case 'py':
      return [
        ['(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')', 'hl-s'],
        ['#.*', 'hl-c'],
        ['(?:[rbfu]{0,2}"(?:\\\\.|[^"\\\\\\n])*"|[rbfu]{0,2}\'(?:\\\\.|[^\'\\\\\\n])*\')', 'hl-s'],
        [num, 'hl-n'],
        [`\\b(?:${HL_BOOLEANS})\\b`, 'hl-b'],
        [`\\b(?:${kw})\\b`, 'hl-k'],
        ['@[A-Za-z_][\\w.]*', 'hl-t'],
        ['\\b[A-Za-z_]\\w*(?=\\s*\\()', 'hl-f']
      ];
    case 'sh':
      return [
        ['#.*', 'hl-c'],
        ['(?:"(?:\\\\.|[^"\\\\])*"|\'[^\']*\')', 'hl-s'],
        ['\\$\\{?[A-Za-z_@#?*!$][\\w]*\\}?', 'hl-v'],
        [num, 'hl-n'],
        [`\\b(?:${kw})\\b`, 'hl-k'],
        ['(?:^|(?<=[|&;]\\s?))\\s*[a-z][\\w.-]*(?=\\s|$)', 'hl-f']
      ];
    case 'html':
      return [
        ['&lt;!--[\\s\\S]*?--&gt;|<!--[\\s\\S]*?-->', 'hl-c'],
        ['(?:"[^"]*"|\'[^\']*\')', 'hl-s'],
        ['(?<=&lt;\\/?|<\\/?)[a-zA-Z][\\w.-]*', 'hl-k'],
        ['\\b[a-zA-Z-]+(?==)', 'hl-t'],
        [num, 'hl-n']
      ];
    case 'css':
      return [
        ['\\/\\*[\\s\\S]*?\\*\\/', 'hl-c'],
        ['(?:"[^"]*"|\'[^\']*\')', 'hl-s'],
        ['#[\\da-fA-F]{3,8}\\b', 'hl-n'],
        ['@[a-z-]+', 'hl-k'],
        ['(?:\\d+(?:\\.\\d+)?)(?:px|em|rem|vh|vw|dvh|s|ms|deg|fr|%)?\\b', 'hl-n'],
        ['[a-z-]+(?=\\s*:)', 'hl-p'],
        ['\\.[A-Za-z_-][\\w-]*', 'hl-t']
      ];
    case 'sql':
      return [
        ['--.*|\\/\\*[\\s\\S]*?\\*\\/', 'hl-c'],
        ["'(?:''|[^'])*'", 'hl-s'],
        [num, 'hl-n'],
        [`\\b(?:${kw})\\b`, 'hl-k'],
        ['\\b[A-Za-z_]\\w*(?=\\s*\\()', 'hl-f']
      ];
    case 'json':
      return [
        ['"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', 'hl-p'],
        ['"(?:\\\\.|[^"\\\\])*"', 'hl-s'],
        [num, 'hl-n'],
        ['\\b(?:true|false|null)\\b', 'hl-b']
      ];
    case 'yaml':
      return [
        ['#.*', 'hl-c'],
        ['(?:"(?:\\\\.|[^"\\\\])*"|\'[^\']*\')', 'hl-s'],
        ['^\\s*-?\\s*[\\w.-]+(?=\\s*:)', 'hl-p'],
        [num, 'hl-n'],
        [`\\b(?:${HL_BOOLEANS})\\b`, 'hl-b'],
        ['[&*][\\w-]+', 'hl-t']
      ];
    case 'ruby':
      return [
        ['#.*', 'hl-c'],
        ['(?:"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')', 'hl-s'],
        [':[\\w?!]+', 'hl-t'],
        ['@{1,2}[\\w]+', 'hl-v'],
        [num, 'hl-n'],
        [`\\b(?:${kw})\\b`, 'hl-k'],
        ['\\b[A-Za-z_]\\w*(?=\\s*\\()', 'hl-f']
      ];
    default: {
      // C-like family (js/ts share it with their own keyword lists)
      const k = kw || HL_KEYWORDS.js;
      return [
        ['\\/\\/.*|\\/\\*[\\s\\S]*?\\*\\/', 'hl-c'],
        ['`(?:\\\\.|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'', 'hl-s'],
        [num, 'hl-n'],
        [`\\b(?:${HL_BOOLEANS})\\b`, 'hl-b'],
        [`\\b(?:${k})\\b`, 'hl-k'],
        ['\\b[A-Z][\\w$]*\\b', 'hl-t'],
        ['\\b[A-Za-z_$][\\w$]*(?=\\s*\\()', 'hl-f']
      ];
    }
  }
}

const hlRegexCache = {};

/**
 * Highlight raw (unescaped) code → escaped HTML with token spans.
 * Any failure falls back to plain escaped code; never throws.
 */
function highlightCode(code, lang) {
  const raw = String(code);
  try {
    let l = String(lang || '').toLowerCase();
    l = HL_ALIASES[l] || l;
    // Plain-text-ish languages render unhighlighted; unknown code langs get
    // the generic C-like pass (strings/comments/numbers still light up).
    if (!l || ['text', 'txt', 'plain', 'plaintext', 'md', 'markdown', 'output', 'log', 'diff', 'csv'].includes(l)) {
      return escapeHtml(raw);
    }
    const known = ['js', 'ts', 'py', 'sh', 'html', 'css', 'sql', 'json', 'yaml', 'ruby', 'c'];
    if (!known.includes(l)) l = 'c';
    if (raw.length > 100_000) return escapeHtml(raw);

    let entry = hlRegexCache[l];
    if (!entry) {
      const parts = hlParts(l);
      entry = {
        re: new RegExp(parts.map(([src]) => `(${src})`).join('|'), 'gm'),
        classes: parts.map(([, cls]) => cls)
      };
      hlRegexCache[l] = entry;
    }

    let out = '';
    let last = 0;
    entry.re.lastIndex = 0;
    let m;
    while ((m = entry.re.exec(raw)) !== null) {
      if (m.index > last) out += escapeHtml(raw.slice(last, m.index));
      let cls = '';
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          cls = entry.classes[g - 1];
          break;
        }
      }
      out += cls ? `<span class="${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
      last = m.index + (m[0].length || 1);
      if (!m[0].length) entry.re.lastIndex++; // zero-width safety
    }
    if (last < raw.length) out += escapeHtml(raw.slice(last));
    return out;
  } catch {
    return escapeHtml(raw);
  }
}

/** Code card chrome shared by closed and still-streaming fences */
function codeCardHtml(lang, rawCode) {
  const langLabel = escapeHtml((lang || 'text').toLowerCase());
  const body = highlightCode(rawCode.replace(/\n$/, ''), lang);
  return (
    `<div class="code-card">` +
    `<div class="code-head">` +
    `<span class="code-lang">${langLabel}</span>` +
    `<button type="button" class="code-copy" aria-label="Copy code">` +
    `<span class="ic" aria-hidden="true">` +
    `<svg class="ic-copy" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
    `<svg class="ic-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>` +
    `</span>` +
    `<span class="code-copy-label">Copy</span>` +
    `</button>` +
    `</div>` +
    `<pre class="code-block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${body}</code></pre>` +
    `</div>`
  );
}

/** GitHub-style pipe tables → <table>, applied to escaped text line-runs */
function transformTables(s, pushBlock) {
  const lines = s.split('\n');
  const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const rowRe = /\|/;
  const out = [];
  let i = 0;

  const splitCells = (line) => {
    let l = line.replace(/\\\|/g, '\x01').trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|')) l = l.slice(0, -1);
    return l.split('|').map((c) => c.replace(/\x01/g, '|').trim());
  };

  while (i < lines.length) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (
      rowRe.test(header) &&
      sep != null &&
      sepRe.test(sep) &&
      sep.includes('-') &&
      splitCells(header).length >= 2
    ) {
      const headCells = splitCells(header);
      const aligns = splitCells(sep).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? ' class="al-c"' : right ? ' class="al-r"' : '';
      });
      const bodyRows = [];
      let j = i + 2;
      while (j < lines.length && rowRe.test(lines[j]) && lines[j].trim() !== '') {
        bodyRows.push(splitCells(lines[j]));
        j++;
      }
      let html = '<div class="table-wrap"><table class="md-table"><thead><tr>';
      headCells.forEach((c, k) => {
        html += `<th${aligns[k] || ''}>${c}</th>`;
      });
      html += '</tr></thead><tbody>';
      for (const row of bodyRows) {
        html += '<tr>';
        for (let k = 0; k < headCells.length; k++) {
          html += `<td${aligns[k] || ''}>${row[k] != null ? row[k] : ''}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      out.push(pushBlock(html));
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** Nested list builder: consumes a run of tagged <li> lines, emits ul/ol tree */
function wrapListRun(run) {
  const items = [];
  const re = /<li data-list="(ul|ol)" data-d="(\d+)"(?: data-start="(\d+)")?( data-task="1")?>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(run)) !== null) {
    items.push({ t: m[1], d: Math.min(3, +m[2]), start: m[3] ? +m[3] : null, task: !!m[4], body: m[5] });
  }
  if (!items.length) return run;
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length > it.d + 1) html += `</${stack.pop()}>`;
    while (stack.length < it.d + 1) {
      const startAttr = it.t === 'ol' && it.start && it.start > 1 ? ` start="${it.start}"` : '';
      html += `<${it.t}${startAttr}>`;
      stack.push(it.t);
    }
    if (stack[stack.length - 1] !== it.t) {
      html += `</${stack.pop()}><${it.t}>`;
      stack.push(it.t);
    }
    html += `<li${it.task ? ' class="task"' : ''}>${it.body}</li>`;
  }
  while (stack.length) html += `</${stack.pop()}>`;
  return html;
}

function renderMarkdown(text) {
  if (!text) return '';
  // Strip raw NULs first: a literal "\x00CODE0\x00" in model output would be
  // indistinguishable from a generated placeholder at restore time, letting
  // output forge/duplicate protected blocks. NUL has no legitimate use in text.
  // \x01 goes with it — transformTables borrows it to shield escaped pipes, so
  // a literal \x01 in a table row came back out as a "|" it never contained.
  text = String(text).replace(/[\x00\x01]/g, '');

  // Protect fenced code + inline code from later transforms via placeholders
  const blocks = [];
  const pushBlock = (html) => {
    const i = blocks.length;
    blocks.push(html);
    return `\x00CODE${i}\x00`;
  };

  // Fenced code blocks FIRST, on the RAW text, so the highlighter sees real
  // characters instead of HTML entities. A fence is closed by its OWN marker
  // (the \1 backreference): ``` does not close ~~~, which is what lets a
  // tilde-fenced block legitimately contain backtick fences. Tilde fences are
  // CommonMark, and src/ui/renderer.js already treats them as code when it
  // decides where to freeze — without them here the two disagreed and a
  // ~~~-wrapped "# Heading" rendered as a real heading instead of code.
  let s = String(text).replace(
    /(`{3,}|~{3,})([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)\1/g,
    (_, _fence, lang, code) => pushBlock(codeCardHtml(lang, code))
  );
  // A remaining unpaired fence streams live as a code card (CommonMark treats
  // an unclosed fence as code to end-of-input, so the final render matches).
  s = s.replace(/(?:^|\n)(`{3,}|~{3,})([\w+#.-]*)[^\S\n]*\n?([\s\S]*)$/, (m, _fence, lang, code) => {
    const lead = m.startsWith('\n') ? '\n' : '';
    return lead + pushBlock(codeCardHtml(lang, code));
  });

  s = escapeHtml(s);

  // Inline code (after fences so backticks inside fences are already removed)
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    return pushBlock(`<code class="inline-code">${code}</code>`);
  });

  // Bold / italic / strikethrough (after escape — input is inert HTML)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Links
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Horizontal rules (before lists so "---" never reads as an empty item)
  s = s.replace(/^ {0,3}([-*_])(?: *\1){2,} *$/gm, () => pushBlock('<hr>'));

  // Tables (before headings/lists; consumes whole line runs into placeholders)
  s = transformTables(s, pushBlock);

  // Headings (#### and beyond → h5)
  s = s.replace(/^#{4,6} (.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Unordered lists — up to 3 nesting levels (2-space or tab indent),
  // GitHub-style task items ("- [ ]" / "- [x]") become checkboxes
  s = s.replace(/^([ \t]*)[-*+] (.+)$/gm, (_, ind, item) => {
    const depth = Math.min(3, Math.floor(ind.replace(/\t/g, '  ').length / 2));
    const task = item.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
    if (task) {
      const done = task[1].toLowerCase() === 'x';
      const body =
        `<span class="task-box${done ? ' done' : ''}" aria-hidden="true"></span>` +
        `<span class="task-text${done ? ' done' : ''}">${task[2]}</span>`;
      return `<li data-list="ul" data-d="${depth}" data-task="1">${body}</li>`;
    }
    return `<li data-list="ul" data-d="${depth}">${item}</li>`;
  });
  // Ordered lists: "1. " or "1) " (start number preserved)
  s = s.replace(/^([ \t]*)(\d+)[.)] (.+)$/gm, (_, ind, n, item) => {
    const depth = Math.min(3, Math.floor(ind.replace(/\t/g, '  ').length / 2));
    return `<li data-list="ol" data-d="${depth}" data-start="${n}">${item}</li>`;
  });
  // Wrap consecutive <li> runs into (possibly nested) lists
  s = s.replace(/(?:<li data-list="(?:ul|ol)" data-d="\d+"[^>]*>.*?<\/li>\n?)+/g, (run) =>
    wrapListRun(run)
  );

  // Blockquotes: ">" becomes "&gt;" after escapeHtml — merge consecutive lines
  s = s.replace(/((?:^|\n)(?:&gt; ?.*(?:\n|$))+)/g, (m) => {
    const body = m
      .replace(/^\n/, '')
      .split('\n')
      .map((line) => line.replace(/^&gt; ?/, ''))
      .filter((line, i, arr) => line.length || i < arr.length - 1)
      .join('<br>');
    // Preserve leading newline so paragraph splitting stays intact
    const lead = m.startsWith('\n') ? '\n' : '';
    return `${lead}<blockquote>${body}</blockquote>`;
  });

  // Paragraphs / line breaks — skip placeholder tokens (restore code later)
  s = s
    .split(/(\x00CODE\d+\x00)/g)
    .map((part) => {
      if (/^\x00CODE\d+\x00$/.test(part)) return part;
      return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
    })
    .join('');

  // Restore protected code blocks / inline spans. Blocks nest — a table cell
  // holding inline code becomes a table block whose HTML still contains that
  // code's placeholder — and String.replace never rescans replacement text,
  // so loop until none remain. Input NULs were stripped above, so every token
  // present is one this function minted; the bound is sheer paranoia.
  for (let pass = 0; pass < 10 && /\x00CODE\d+\x00/.test(s); pass++) {
    s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => blocks[Number(i)] || '');
  }

  // Tidy: block elements separate themselves — drop the stray <br>/empty-<p>
  // debris the line-based paragraph pass leaves at block edges.
  s = s
    .replace(/(?:<br>\s*)+(<(?:div|table|ul|ol|pre|hr|h[2-5]|blockquote)\b)/g, '$1')
    .replace(/(<\/(?:div|table|ul|ol|pre|h[2-5]|blockquote)>|<hr>)(?:\s*<br>)+/g, '$1')
    .replace(/<p>(?=<(?:div|table|ul|ol|pre|hr|h[2-5]|blockquote)\b)/g, '')
    .replace(/(<\/(?:div|table|ul|ol|pre|h[2-5]|blockquote)>|<hr>)<\/p>/g, '$1')
    .replace(/<p>(?:\s|<br>)*<\/p>/g, '');

  if (!s.startsWith('<')) s = `<p>${s}</p>`;
  return s;
}

export { escapeHtml, highlightCode, codeCardHtml, renderMarkdown };
