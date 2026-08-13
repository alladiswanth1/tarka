import { DEBATE_DEFAULT_PERSONA, DEBATE_MAX_SEATS, debateSeatRangeLabel } from '../debate/protocol.js';
import { debateSettings, markDebateCustom, scheduleDebateSave, updateDebateTeamsUi } from '../debate/settings.js';
import { attachModelPicker, updateModelWarnings } from '../models.js';
import { activeProviderId, providerAccessIssue, providers } from '../providers.js';
import { $ } from '../state.js';

// ========== DEBATE MODE — sidebar seats editor & composer toggle ==========
/**
 * Every seat must have an explicit model and a resolvable provider (API key, or a signed-in local CLI).
 * Judge seat validated only when finalAnswerMode === 'judge'.
 * Soft catalog mismatches are advisory only (see updateModelWarnings).
 * Returns a human-readable issue string, or null when the setup is valid.
 */
function validateDebateSetup() {
  if (debateSettings.experts.length < 2) {
    return 'a debate needs at least 2 experts.';
  }
  for (const e of debateSettings.experts) {
    const name = (e.name || 'an expert').trim() || 'an expert';
    if (!(e.model || '').trim()) {
      return `${name} has no model — pick one in the Debate Mode section.`;
    }
    const prov =
      providers.length === 1 ? providers[0] : providers.find((p) => p.id === e.providerId);
    if (!prov) {
      return `${name} has no provider selected — pick one in the Debate Mode section.`;
    }
    const access = providerAccessIssue(prov, name);
    if (access) return access;
  }
  if (debateSettings.finalAnswerMode === 'judge') {
    const j = debateSettings.judge || {};
    if (!(j.model || '').trim()) {
      return 'the neutral judge has no model — pick one in the Debate Mode section.';
    }
    const prov =
      providers.length === 1 ? providers[0] : providers.find((p) => p.id === j.providerId);
    if (!prov) {
      return 'the neutral judge has no provider selected — pick one in the Debate Mode section.';
    }
    const access = providerAccessIssue(prov, 'the judge');
    if (access) return access;
  }
  return null;
}

function debateCostHintText() {
  const e = debateSettings.experts.length;
  const r = debateSettings.maxRounds;
  const finalLabel =
    debateSettings.finalAnswerMode === 'judge' ? '1 judge' : '1 presenter';
  return `One debate ≈ (${e} experts × ${r} rounds) + ${finalLabel} = up to ${e * r + 1} API calls (excluding automatic retries). Round 1 is blind and runs in parallel. Each expert runs its own model & provider. By default every expert AND the final answer run at your global reasoning effort — switch Expert Reasoning to Off to trade quality for speed.`;
}

function updateDebateCostHint() {
  const el = $('#debateCostHint');
  if (el) el.textContent = debateCostHintText();
}

/**
 * Build a model picker field (shared by seats + judge).
 * Returns the .model-picker wrapper (append this to the form).
 */

/**
 * Build a model picker field (shared by seats + judge).
 * Returns the .model-picker wrapper (append this to the form).
 */
function buildSeatModelField(target, { getProviderId, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'model-picker';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.className = 'seat-model-input model-picker-input';
  modelInput.value = target.model || '';
  modelInput.placeholder = 'model id — required';
  wrap.appendChild(modelInput);
  const flagMissing = () =>
    modelInput.classList.toggle('missing', !modelInput.value.trim());
  flagMissing();
  modelInput.addEventListener('input', () => {
    target.model = modelInput.value;
    flagMissing();
    markDebateCustom();
    onChange?.(modelInput.value);
  });
  attachModelPicker(modelInput, {
    getProviderId,
    onChange: (v) => {
      target.model = v;
      flagMissing();
      markDebateCustom();
      onChange?.(v);
      updateModelWarnings();
    }
  });
  return wrap;
}

function renderDebateSeats() {
  const wrap = $('#debateSeats');
  if (!wrap || !debateSettings) return;
  wrap.innerHTML = '';
  const multiProvider = providers.length >= 2;

  debateSettings.experts.forEach((e, i) => {
    const card = document.createElement('div');
    card.className = 'debate-seat';
    card.dataset.seatIndex = String(i);
    card.style.setProperty('--seat-c', `var(--debate-c${i % 5})`);

    const head = document.createElement('div');
    head.className = 'debate-seat-head';
    head.innerHTML =
      '<i class="seat-dot" aria-hidden="true"></i><span class="seat-title"></span>' +
      '<button type="button" class="icon-btn small seat-remove" title="Remove expert" aria-label="Remove expert">✕</button>';
    head.querySelector('.seat-title').textContent = `Expert ${i + 1}`;
    const removeBtn = head.querySelector('.seat-remove');
    removeBtn.hidden = debateSettings.experts.length <= 2;
    removeBtn.addEventListener('click', () => {
      debateSettings.experts.splice(i, 1);
      markDebateCustom();
      renderDebateSeats();
      updateDebateCostHint();
    });
    card.appendChild(head);

    const addField = (labelText, el) => {
      const label = document.createElement('label');
      label.appendChild(document.createTextNode(labelText));
      label.appendChild(el);
      card.appendChild(label);
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = e.name;
    nameInput.placeholder = 'Name';
    nameInput.addEventListener('input', () => {
      e.name = nameInput.value;
      markDebateCustom();
    });
    addField('Name', nameInput);

    // Provider first when multi — so model picker can scope immediately
    if (providers.length) {
      if (!providers.some((p) => p.id === e.providerId)) {
        e.providerId = activeProviderId || providers[0].id;
        scheduleDebateSave();
      }
      if (multiProvider) {
        const sel = document.createElement('select');
        sel.className = 'seat-provider-select';
        providers.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          sel.appendChild(opt);
        });
        sel.value = e.providerId;
        sel.addEventListener('change', () => {
          e.providerId = sel.value;
          markDebateCustom();
          const mi = card.querySelector('.seat-model-input');
          if (mi && mi._modelPickerRefresh) mi._modelPickerRefresh();
          updateModelWarnings();
        });
        addField('Provider', sel);
      }
    }

    const modelWrap = buildSeatModelField(e, {
      getProviderId: () =>
        providers.length === 1
          ? providers[0]?.id
          : e.providerId || activeProviderId
    });
    addField('Model', modelWrap);

    // Persona is OPTIONAL and stays out of the way: no visible box, just a
    // small toggle that reveals the editor on demand. Empty means the
    // engine's default persona; a seat that has one set shows "✎" so the
    // customization stays discoverable while hidden.
    const personaInput = document.createElement('textarea');
    personaInput.rows = 2;
    personaInput.value = e.persona;
    personaInput.placeholder = `Optional — defaults to “${DEBATE_DEFAULT_PERSONA}”`;
    const personaLabel = document.createElement('label');
    personaLabel.className = 'seat-persona-editor';
    personaLabel.appendChild(document.createTextNode('Custom persona'));
    personaLabel.appendChild(personaInput);
    personaLabel.hidden = true;

    const personaBtn = document.createElement('button');
    personaBtn.type = 'button';
    personaBtn.className = 'text-btn seat-persona-toggle';
    const syncPersonaBtn = () => {
      personaBtn.textContent = !personaLabel.hidden
        ? '－ Hide persona'
        : (e.persona || '').trim()
          ? '✎ Persona (custom)'
          : '＋ Custom persona (optional)';
    };
    syncPersonaBtn();
    personaBtn.addEventListener('click', () => {
      personaLabel.hidden = !personaLabel.hidden;
      syncPersonaBtn();
      if (!personaLabel.hidden) personaInput.focus();
    });
    personaInput.addEventListener('input', () => {
      e.persona = personaInput.value;
      markDebateCustom();
    });
    card.appendChild(personaBtn);
    card.appendChild(personaLabel);

    wrap.appendChild(card);
  });

  const addBtn = $('#addSeatBtn');
  if (addBtn) {
    addBtn.hidden = debateSettings.experts.length >= DEBATE_MAX_SEATS;
    addBtn.textContent = `＋ Add expert (${debateSeatRangeLabel()})`;
  }
  const rounds = $('#debateMaxRounds');
  if (rounds) rounds.value = debateSettings.maxRounds;
  const reasoning = $('#debateReasoning');
  if (reasoning) reasoning.value = debateSettings.expertReasoning;
  const finalMode = $('#debateFinalMode');
  if (finalMode) finalMode.value = debateSettings.finalAnswerMode === 'judge' ? 'judge' : 'nominated';
  updateDebateCostHint();
  updateJudgeRowVisibility();
  updateDebateTeamsUi();
  updateModelWarnings();
}

function updateJudgeRowVisibility() {
  const row = $('#debateJudgeRow');
  if (!row) return;
  const on = debateSettings.finalAnswerMode === 'judge';
  row.hidden = !on;
  if (!on) {
    row.innerHTML = '';
    return;
  }
  // Rebuild judge editor
  if (!debateSettings.judge) debateSettings.judge = { model: '', providerId: '' };
  const j = debateSettings.judge;
  // Prefill from active provider/model when empty (never a hidden default in engine)
  if (!j.providerId && (activeProviderId || providers[0])) {
    j.providerId = activeProviderId || providers[0].id;
    scheduleDebateSave();
  }
  if (!j.model) {
    const main = $('#model')?.value?.trim();
    if (main) {
      j.model = main;
      scheduleDebateSave();
    }
  }

  row.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'debate-seat debate-judge-seat';
  card.style.setProperty('--seat-c', 'var(--accent)');

  const head = document.createElement('div');
  head.className = 'debate-seat-head';
  head.innerHTML =
    '<i class="seat-dot" aria-hidden="true"></i><span class="seat-title">Neutral judge</span>';
  card.appendChild(head);

  const addField = (labelText, el) => {
    const label = document.createElement('label');
    label.appendChild(document.createTextNode(labelText));
    label.appendChild(el);
    card.appendChild(label);
  };

  const multiProvider = providers.length >= 2;
  if (providers.length) {
    if (!providers.some((p) => p.id === j.providerId)) {
      j.providerId = activeProviderId || providers[0].id;
      scheduleDebateSave();
    }
    if (multiProvider) {
      const sel = document.createElement('select');
      providers.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      sel.value = j.providerId;
      sel.addEventListener('change', () => {
        j.providerId = sel.value;
        markDebateCustom();
        const mi = card.querySelector('.seat-model-input');
        if (mi && mi._modelPickerRefresh) mi._modelPickerRefresh();
        updateModelWarnings();
      });
      addField('Provider', sel);
    }
  }

  const modelWrap = buildSeatModelField(j, {
    getProviderId: () =>
      providers.length === 1 ? providers[0]?.id : j.providerId || activeProviderId
  });
  addField('Model', modelWrap);

  row.appendChild(card);
  updateModelWarnings();
}

export { buildSeatModelField, debateCostHintText, renderDebateSeats, updateDebateCostHint, updateJudgeRowVisibility, validateDebateSetup };
