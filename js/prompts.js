/* KutLabz prompts: an always-visible prompt bar (Ctrl/⌘+K) and a recipe editor for saved multi-step prompts.
   Both run through the Assistant engine (offline commands, or Claude when connected), so every step is
   listed in the Assistant tab and undoable. Recipes and prompt history live in this browser's storage. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RECIPE_STORE = 'kutlabz.recipes.v1', HISTORY_STORE = 'kutlabz.promptHistory.v1', MAX_HISTORY = 30;
  const STARTERS = [
    { id: 'st-podcast', name: 'Podcast / talking-head clip', desc: 'Tight, level, vertical — for clips of interviews and podcasts.', steps: ['cut the silences', 'level the audio', 'enhance the voice', 'vertical for tiktok'] },
    { id: 'st-teaser', name: 'Product teaser · 15 s', desc: 'Fast cut of the strongest moments with a bold look and a title.', steps: ['detect scenes', 'make a 15 second highlight reel', 'use the vivid pop look', 'add title "New drop" at 0'] },
    { id: 'st-cine', name: 'Cinematic grade', desc: 'Balanced exposure, matched shots, filmic contrast.', steps: ['auto grade', 'match the shots', 'use the teal look', 'more contrast and a vignette'] },
    { id: 'st-tutorial', name: 'Screen tutorial', desc: 'Remove idle stretches, zoom in on the action, even out narration.', steps: ['remove dead frames', 'auto zoom', 'level the audio', 'enhance the voice'] },
    { id: 'st-montage', name: 'Music montage', desc: 'Add a music bed first (Create → Music), then cut on the beat.', steps: ['detect scenes', 'cut to the beat', 'punchier and more saturated'] },
  ];

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked: keep in memory */ } },
  };
  let recipes = store.get(RECIPE_STORE, null);
  if (!Array.isArray(recipes)) { recipes = STARTERS.map((r) => ({ ...r, steps: [...r.steps], starter: true })); store.set(RECIPE_STORE, recipes); }
  let history = store.get(HISTORY_STORE, []);
  let histPos = -1, running = null, selectedId = recipes[0] && recipes[0].id;
  const uid = () => 'r-' + Math.random().toString(36).slice(2, 9);
  const saveRecipes = () => store.set(RECIPE_STORE, recipes);
  const chat = () => window.KutChat;

  /* ---------------- prompt bar ---------------- */
  function buildBar() {
    const bar = document.createElement('form'); bar.className = 'promptbar'; bar.id = 'promptBar'; bar.autocomplete = 'off';
    bar.innerHTML = `
      <span class="pb-label">PROMPT</span>
      <input id="pbInput" type="text" enterkeyhint="go" spellcheck="false" placeholder="Describe an edit — e.g. cut the silences and make it vertical" aria-label="Describe an edit">
      <kbd class="pb-kbd" id="pbKbd"></kbd>
      <button type="button" id="pbRecipes" class="btn small" title="Saved multi-step prompts">Recipes</button>
      <button type="submit" id="pbRun" class="btn small primary">Run</button>`;
    const result = document.createElement('div'); result.className = 'pb-result'; result.id = 'pbResult'; result.hidden = true;
    result.innerHTML = '<span id="pbText"></span><button type="button" id="pbStop" hidden>Stop</button><button type="button" id="pbDetails">Details</button><button type="button" id="pbClose" aria-label="Dismiss">✕</button>';
    const center = document.querySelector('.center');
    center.insertBefore(bar, center.firstChild);
    $('stage').appendChild(result);
    $('pbKbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
    bar.addEventListener('submit', (e) => { e.preventDefault(); runPrompt($('pbInput').value); });
    $('pbRecipes').onclick = () => openEditor();
    $('pbDetails').onclick = showDetails;
    $('pbClose').onclick = () => ($('pbResult').hidden = true);
    $('pbStop').onclick = () => { if (running) { running.stop = true; showResult('Stopping after the current step…', 'busy'); } };
    $('pbInput').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); histPos = Math.min(history.length - 1, histPos + 1); $('pbInput').value = history[histPos]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); histPos = Math.max(-1, histPos - 1); $('pbInput').value = histPos < 0 ? '' : history[histPos]; }
      else if (e.key === 'Escape') { $('pbInput').blur(); }
    });
    // Ctrl/⌘+K focuses the bar from anywhere in the editor
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !(window.ImageStudio && ImageStudio.isOpen())) { e.preventDefault(); $('pbInput').focus(); $('pbInput').select(); }
    }, true);
  }
  function showResult(text, kind = 'done') {
    const r = $('pbResult'); r.hidden = false; r.className = 'pb-result ' + kind; $('pbText').textContent = text;
    $('pbStop').hidden = kind !== 'busy' || !running;
  }
  function showDetails() {
    if (window.KutMobile && KutMobile.isMobile()) KutMobile.setSheet('chat');
    else { const t = document.querySelector('.tabs .tab[data-tab="chat"]'); if (t) t.click(); }
  }
  function remember(text) {
    history = [text, ...history.filter((h) => h !== text)].slice(0, MAX_HISTORY); histPos = -1;
    store.set(HISTORY_STORE, history);
  }
  async function runPrompt(raw) {
    const text = String(raw || '').trim(); if (!text || !chat()) return;
    if (running || chat().isBusy()) return showResult('Still working on the previous prompt…', 'busy');
    remember(text); $('pbInput').value = ''; $('pbInput').blur();
    showResult(`Working: ${text}`, 'busy'); setRunning(true);
    try {
      const res = await chat().send(text, { quiet: true });
      showResult(res.reply || (res.actions ? `Done — ${res.actions} action${res.actions > 1 ? 's' : ''}` : 'Done'), res.error ? 'err' : 'done');
    } finally { setRunning(false); }
  }
  function setRunning(on) { $('pbRun').disabled = on; $('pbRun').textContent = on ? '…' : 'Run'; }

  /* ---------------- recipes ---------------- */
  async function runRecipe(recipe) {
    if (!recipe || !recipe.steps.filter((s) => s.trim()).length) return showResult('That recipe has no steps yet', 'err');
    if (running || chat().isBusy()) return showResult('Still working on the previous prompt…', 'busy');
    closeEditor();
    const steps = recipe.steps.map((s) => s.trim()).filter(Boolean);
    running = { stop: false }; setRunning(true);
    let actions = 0, i = 0;
    try {
      for (; i < steps.length; i++) {
        if (running.stop) break;
        showResult(`${recipe.name} · step ${i + 1}/${steps.length}: ${steps[i]}`, 'busy');
        const res = await chat().send(steps[i], { quiet: true });
        actions += res.actions;
        if (res.error) { showResult(`${recipe.name} stopped at step ${i + 1} (“${steps[i]}”): ${res.reply}`, 'err'); return; }
      }
      if (running.stop && i < steps.length) showResult(`${recipe.name} stopped after step ${i} of ${steps.length}. Undo (Ctrl+Z) reverts any step.`, 'err');
      else showResult(`${recipe.name} done — ${steps.length} step${steps.length > 1 ? 's' : ''}, ${actions} action${actions === 1 ? '' : 's'}. Undo (Ctrl+Z) reverts any step.`, 'done');
    } finally { running = null; setRunning(false); }
  }

  function buildEditor() {
    const el = document.createElement('div'); el.className = 'rx'; el.id = 'recipes'; el.hidden = true;
    el.innerHTML = `
      <div class="rx-card" role="dialog" aria-label="Prompt recipes">
        <header class="rx-head"><h3>PROMPT RECIPES</h3><span class="rx-engine" id="rxEngine"></span><button class="btn small" id="rxClose">Close</button></header>
        <div class="rx-body">
          <aside class="rx-side">
            <div class="rx-list" id="rxList"></div>
            <div class="rx-side-actions"><button class="btn small" id="rxNew">New recipe</button><button class="btn small" id="rxRestore" title="Bring back any deleted starter recipes">Restore starters</button></div>
          </aside>
          <section class="rx-edit" id="rxEdit">
            <label class="dlg-field"><span>Name</span><input id="rxName" type="text" maxlength="60"></label>
            <label class="dlg-field"><span>Notes</span><input id="rxDesc" type="text" maxlength="160" placeholder="What this recipe is for"></label>
            <div class="rx-steps-head"><span>STEPS — each one is a prompt, run in order</span></div>
            <ol class="rx-steps" id="rxSteps"></ol>
            <div class="rx-row">
              <button class="btn small" id="rxAddStep">Add step</button>
              <select id="rxFromHistory" aria-label="Add a step from prompt history"><option value="">Add from history…</option></select>
            </div>
            <p class="rx-hint" id="rxHint"></p>
            <div class="rx-row rx-foot">
              <button class="btn small" id="rxDup">Duplicate</button>
              <button class="btn small" id="rxDel">Delete</button>
              <span class="rx-saved" id="rxSaved">Saved</span>
              <button class="btn small primary" id="rxRun">Run on this edit</button>
            </div>
          </section>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeEditor(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); } });
    $('rxClose').onclick = closeEditor;
    $('rxNew').onclick = () => { const r = { id: uid(), name: 'New recipe', desc: '', steps: [''] }; recipes.unshift(r); selectedId = r.id; changed(); renderEditor(); focusStep(0); };
    $('rxRestore').onclick = () => {
      let added = 0;
      for (const s of STARTERS) if (!recipes.some((r) => r.id === s.id)) { recipes.push({ ...s, steps: [...s.steps], starter: true }); added++; }
      changed(); renderEditor(); flash(added ? `Restored ${added} starter${added > 1 ? 's' : ''}` : 'All starters are already here');
    };
    $('rxName').oninput = (e) => { const r = current(); if (r) { r.name = e.target.value || 'Untitled'; changed(); renderList(); } };
    $('rxDesc').oninput = (e) => { const r = current(); if (r) { r.desc = e.target.value; changed(); } };
    $('rxAddStep').onclick = () => { const r = current(); if (!r) return; r.steps.push(''); changed(); renderSteps(); focusStep(r.steps.length - 1); };
    $('rxFromHistory').onchange = (e) => { const r = current(); if (r && e.target.value) { r.steps.push(e.target.value); changed(); renderSteps(); } e.target.value = ''; };
    $('rxDup').onclick = () => { const r = current(); if (!r) return; const c = { id: uid(), name: r.name + ' copy', desc: r.desc, steps: [...r.steps] }; recipes.splice(recipes.indexOf(r) + 1, 0, c); selectedId = c.id; changed(); renderEditor(); };
    $('rxDel').onclick = () => {
      const r = current(); if (!r) return;
      if (!confirm(`Delete “${r.name}”?`)) return;
      const i = recipes.indexOf(r); recipes.splice(i, 1); selectedId = (recipes[i] || recipes[i - 1] || {}).id; changed(); renderEditor();
    };
    $('rxRun').onclick = () => runRecipe(current());
  }
  const current = () => recipes.find((r) => r.id === selectedId);
  let flashTimer;
  function flash(msg) { const s = $('rxSaved'); s.textContent = msg; s.classList.add('show'); clearTimeout(flashTimer); flashTimer = setTimeout(() => s.classList.remove('show'), 1400); }
  function changed() { saveRecipes(); flash('Saved'); }
  function focusStep(i) { const t = $('rxSteps').querySelectorAll('textarea')[i]; if (t) t.focus(); }
  function renderList() {
    const list = $('rxList'); list.innerHTML = '';
    for (const r of recipes) {
      const b = document.createElement('button'); b.className = 'rx-item' + (r.id === selectedId ? ' on' : '');
      b.innerHTML = '<b></b><small></small>';
      b.querySelector('b').textContent = r.name;
      b.querySelector('small').textContent = `${r.steps.filter((s) => s.trim()).length} step${r.steps.length === 1 ? '' : 's'}${r.starter ? ' · starter' : ''}`;
      b.onclick = () => { selectedId = r.id; renderEditor(); };
      list.appendChild(b);
    }
    if (!recipes.length) list.innerHTML = '<p class="rx-empty">No recipes. Create one, or restore the starters.</p>';
  }
  function renderSteps() {
    const r = current(), ol = $('rxSteps'); ol.innerHTML = ''; if (!r) return;
    r.steps.forEach((step, i) => {
      const li = document.createElement('li'); li.className = 'rx-step';
      li.innerHTML = '<span class="rx-n"></span><textarea rows="1" spellcheck="false"></textarea><span class="rx-step-btns"><button type="button" title="Move up">↑</button><button type="button" title="Move down">↓</button><button type="button" title="Remove step">✕</button></span>';
      li.querySelector('.rx-n').textContent = String(i + 1).padStart(2, '0');
      const ta = li.querySelector('textarea'); ta.value = step; ta.placeholder = 'e.g. cut the silences';
      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.oninput = () => { r.steps[i] = ta.value; grow(); changed(); renderList(); };
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); r.steps.splice(i + 1, 0, ''); changed(); renderSteps(); focusStep(i + 1); } };
      const [up, down, del] = li.querySelectorAll('.rx-step-btns button');
      up.disabled = i === 0; down.disabled = i === r.steps.length - 1;
      up.onclick = () => { [r.steps[i - 1], r.steps[i]] = [r.steps[i], r.steps[i - 1]]; changed(); renderSteps(); };
      down.onclick = () => { [r.steps[i + 1], r.steps[i]] = [r.steps[i], r.steps[i + 1]]; changed(); renderSteps(); };
      del.onclick = () => { r.steps.splice(i, 1); if (!r.steps.length) r.steps.push(''); changed(); renderSteps(); renderList(); };
      ol.appendChild(li); requestAnimationFrame(grow);
    });
  }
  function renderEditor() {
    renderList();
    const r = current(); $('rxEdit').hidden = !r; if (!r) return;
    $('rxName').value = r.name; $('rxDesc').value = r.desc || '';
    renderSteps();
    const sel = $('rxFromHistory'); sel.innerHTML = '<option value="">Add from history…</option>';
    history.forEach((h) => { const o = document.createElement('option'); o.value = h; o.textContent = h.length > 60 ? h.slice(0, 57) + '…' : h; sel.appendChild(o); });
    sel.disabled = !history.length;
    const engine = chat() ? chat().engine() : 'local';
    $('rxEngine').textContent = engine === 'claude' ? 'Runs with Claude' : 'Runs offline · Connect Claude in the Assistant for free-form steps';
    $('rxHint').textContent = engine === 'claude'
      ? 'Steps can be free-form — Claude plans each one against the current edit.'
      : 'Offline, steps use the built-in commands (silences, loudness, voice, highlight reel, vertical, grade, looks, titles, zoom, beat cuts…). A step that isn’t understood stops the recipe.';
  }
  function openEditor() { if (!$('recipes')) buildEditor(); $('recipes').hidden = false; renderEditor(); }
  function closeEditor() { const el = $('recipes'); if (el) el.hidden = true; }

  function init() {
    buildBar();
    // entry points elsewhere: desktop Content tools and the mobile Create sheet
    const content = [...document.querySelectorAll('.tool-group')].find((h) => /content/i.test(h.textContent));
    if (content && content.nextElementSibling) {
      const b = document.createElement('button'); b.className = 'tool'; b.id = 'toolRecipes';
      b.innerHTML = '<b>Prompt Recipes…</b><small>saved multi-step prompts · one-click runs</small>';
      b.onclick = () => openEditor();
      content.nextElementSibling.prepend(b);
    }
    const grid = $('mCreateGrid');
    if (grid) {
      const b = document.createElement('button'); b.className = 'mact';
      b.innerHTML = '<b>Prompt Recipes</b><small>saved multi-step prompts</small>';
      b.onclick = () => { if (window.KutMobile) KutMobile.setSheet(null); openEditor(); };
      grid.prepend(b);
    }
  }
  window.KutPrompts = { run: runPrompt, runRecipe: (idOrName) => runRecipe(recipes.find((r) => r.id === idOrName || r.name === idOrName)), openEditor, closeEditor, recipes: () => recipes, history: () => history };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
