import { projectMode } from './project/state.js';
import { messages } from './state.js';
import { exportProjectJournal } from './ui/inspector.js';
import { flashStatus } from './ui/transcript.js';

function stampExportName(ext) {
  return `chat-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${ext}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox ignores click() on a detached anchor, and revoking the object URL
  // in the same tick cancels the download it just started — the save has to
  // outlive this function.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function exportChat(fmt = 'txt') {
  if (typeof projectMode !== 'undefined' && projectMode.enabled) {
    exportProjectJournal(fmt);
    return;
  }
  if (!messages.length) {
    flashStatus('Nothing to export', 1200);
    return;
  }
  const stamp = stampExportName(fmt === 'md' ? 'md' : fmt === 'json' ? 'json' : 'txt');

  // Debate answers export with their team transcript, not just the final text
  const debateMeta = (d) => {
    const by = d.finalAnswerMode === 'judge' ? `Judge (${d.judgeModel || 'judge'})` : d.presenter;
    return `Team debate · ${d.rounds} round${d.rounds === 1 ? '' : 's'} · final by ${by || 'team'}`;
  };

  if (fmt === 'json') {
    const payload = messages.map((m) => {
      const o = { role: m.role, content: m.content };
      if (m.debate) o.debate = m.debate;
      return o;
    });
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      stamp
    );
    flashStatus('Exported JSON ✓');
    return;
  }

  if (fmt === 'md') {
    const md = messages
      .map((m) => {
        const label = m.role === 'user' ? '**User:**' : '**Assistant:**';
        let block = `${label}\n\n${m.content}`;
        const turns = m.debate?.turns;
        if (turns && turns.length) {
          const body = turns
            .map((t) => `**${t.name}${t.round ? ` · round ${t.round}` : ''}:**\n\n${t.text}`)
            .join('\n\n');
          block += `\n\n<details>\n<summary>${debateMeta(m.debate)}</summary>\n\n${body}\n\n</details>`;
        }
        return block;
      })
      .join('\n\n---\n\n');
    downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), stamp);
    flashStatus('Exported Markdown ✓');
    return;
  }

  const text = messages
    .map((m) => {
      let block = `${m.role.toUpperCase()}:\n${m.content}`;
      const turns = m.debate?.turns;
      if (turns && turns.length) {
        const body = turns
          .map((t) => `— ${t.name}${t.round ? ` (round ${t.round})` : ''}:\n${t.text}`)
          .join('\n\n');
        block += `\n\n[${debateMeta(m.debate)}]\n${body}`;
      }
      return block;
    })
    .join('\n\n────────────────\n\n');
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), stamp);
  flashStatus('Exported ✓');
}

export { downloadBlob, exportChat, stampExportName };
