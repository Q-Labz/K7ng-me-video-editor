/* KutLabz mobile shell: phone layout for Reels / TikTok / Shorts, bottom sheets, social safe-zone guides. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const K = () => window.KutLabz;
  const MQ = window.matchMedia('(max-width: 820px), (pointer: coarse) and (max-width: 1100px)');

  /* Platform UI that covers a 9:16 frame (fractions of width/height). Approximate; apps change their layouts. */
  const GUIDES = {
    tiktok: { name: 'TikTok', zones: [[0, 0, 1, 0.12, 'header'], [0, 0.79, 1, 0.21, 'caption · sound'], [0.86, 0.38, 0.14, 0.44, 'actions']] },
    reels: { name: 'Reels', zones: [[0, 0, 1, 0.11, 'header'], [0, 0.8, 1, 0.2, 'caption · audio'], [0.86, 0.45, 0.14, 0.36, 'actions']] },
    shorts: { name: 'Shorts', zones: [[0, 0, 1, 0.1, 'header'], [0, 0.78, 1, 0.22, 'title · channel'], [0.85, 0.42, 0.15, 0.38, 'actions']] },
  };
  let guide = null; // key of GUIDES or null

  function drawGuides() {
    const box = $('guides'); if (!box) return;
    const view = $('view'), stage = $('stage');
    const show = !!(guide && K() && K().state.aspect === '9:16');
    box.hidden = !show; if (!show) return;
    const r = view.getBoundingClientRect(), s = stage.getBoundingClientRect();
    Object.assign(box.style, { left: r.left - s.left + 'px', top: r.top - s.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    box.innerHTML = '';
    for (const [x, y, w, h, label] of GUIDES[guide].zones) {
      const z = document.createElement('div'); z.className = 'gz';
      Object.assign(z.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
      z.dataset.label = label; box.appendChild(z);
    }
    const tag = document.createElement('div'); tag.className = 'gtag'; tag.textContent = `${GUIDES[guide].name} safe zones`; box.appendChild(tag);
  }
  function cycleGuides() {
    const order = [null, 'tiktok', 'reels', 'shorts'];
    guide = order[(order.indexOf(guide) + 1) % order.length];
    $('btnGuides').textContent = guide ? GUIDES[guide].name : 'Guides';
    $('btnGuides').classList.toggle('active', !!guide);
    if (guide && K().state.aspect !== '9:16') K().setAspect('9:16');
    drawGuides();
  }

  /* ---------------- sheets ---------------- */
  let openSheet = null;
  function setSheet(name) {
    if (openSheet === name) name = null;
    openSheet = name;
    document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('on', b.dataset.sheet === name));
    const left = document.querySelector('.panel.left'), right = document.querySelector('.panel.right');
    left.classList.toggle('sheet-open', name === 'ai');
    right.classList.toggle('sheet-open', name === 'look' || name === 'chat');
    $('msheetEdit').classList.toggle('sheet-open', name === 'edit');
    $('msheetCreate').classList.toggle('sheet-open', name === 'create');
    if (name === 'look') document.querySelector('.tabs .tab[data-tab="grade"]').click();
    if (name === 'chat') document.querySelector('.tabs .tab[data-tab="chat"]').click();
    $('mscrim').hidden = !name;
  }

  function button(label, sub, fn, cls = '') {
    const b = document.createElement('button'); b.className = 'mact ' + cls;
    b.innerHTML = '<b></b><small></small>'; b.querySelector('b').textContent = label; b.querySelector('small').textContent = sub || '';
    b.onclick = () => { fn(); };
    return b;
  }
  function build() {
    // bottom tab bar
    const bar = document.createElement('nav'); bar.className = 'mtabbar'; bar.id = 'mtabbar';
    [['edit', 'Edit'], ['ai', 'AI'], ['look', 'Look'], ['create', 'Create'], ['chat', 'Assistant']].forEach(([k, t]) => {
      const b = document.createElement('button'); b.className = 'mtab'; b.dataset.sheet = k; b.textContent = t; b.onclick = () => setSheet(k); bar.appendChild(b);
    });
    document.getElementById('app').appendChild(bar);
    const scrim = document.createElement('div'); scrim.className = 'mscrim'; scrim.id = 'mscrim'; scrim.hidden = true; scrim.onclick = () => setSheet(null);
    document.body.appendChild(scrim);

    // Edit sheet: cut-level actions + output format
    const edit = document.createElement('div'); edit.className = 'msheet'; edit.id = 'msheetEdit';
    edit.innerHTML = '<h3>EDIT</h3><div class="mgrid" id="mEditGrid"></div><h3>FORMAT</h3><div class="mgrid" id="mFmtGrid"></div>';
    document.body.appendChild(edit);
    const eg = edit.querySelector('#mEditGrid');
    eg.append(
      button('Make a Reel', 'vertical · tight · level', () => { setSheet(null); K().tools.reel(); }, 'hero'),
      button('Split', 'at playhead', () => $('btnSplit').click()),
      button('Delete', 'selected clip or text', () => $('btnDelete').click()),
      button('Undo', '', () => $('btnUndo').click()),
      button('Redo', '', () => $('btnRedo').click()),
      button('Split at cuts', 'after Detect Scene Cuts', () => $('btnSplitCuts').click()),
      button('Fit timeline', '', () => $('btnFit').click()),
    );
    const fg = edit.querySelector('#mFmtGrid');
    [['9:16', 'Reels · TikTok · Shorts'], ['4:5', 'Instagram feed'], ['1:1', 'Square'], ['16:9', 'YouTube'], ['source', 'Original']].forEach(([a, sub]) => {
      fg.appendChild(button(a === 'source' ? 'Source' : a, sub, () => { K().setAspect(a); syncFmt(); drawGuides(); }));
    });

    // Create sheet: capture, text, music, stills
    const create = document.createElement('div'); create.className = 'msheet'; create.id = 'msheetCreate';
    create.innerHTML = '<h3>CREATE</h3><div class="mgrid" id="mCreateGrid"></div>';
    document.body.appendChild(create);
    const close = (fn) => () => { setSheet(null); fn(); };
    create.querySelector('#mCreateGrid').append(
      button('Add Text', 'title · lower third · caption', close(() => K().tools.title())),
      button('Replace Text', 'swap words in the video', close(() => K().tools.replace())),
      button('Captions', 'import .srt / .vtt', close(() => K().tools.captions())),
      button('Music', 'beat grid · auto duck', close(() => K().tools.music())),
      button('Cut to Beat', 'after adding music', close(() => K().runTool('beatcut'))),
      button('Camera', 'record with live grade', close(() => $('btnCamera').click())),
      button('Screen', 'record a screen', close(() => $('btnScreen').click())),
      button('Image Studio', 'edit a photo or frame', close(() => K().openStudio())),
      button('Thumbnail', 'save the best frame', close(() => K().runTool('thumbnail'))),
    );
  }
  function syncFmt() {
    const a = K() && K().state.aspect;
    document.querySelectorAll('#mFmtGrid .mact').forEach((b) => b.classList.toggle('on', (b.querySelector('b').textContent === 'Source' ? 'source' : b.querySelector('b').textContent) === a));
  }

  function apply() {
    const on = MQ.matches;
    const was = document.body.classList.contains('mobile');
    document.body.classList.toggle('mobile', on);
    if (!on) setSheet(null);
    if (on && !was && K() && K().state.aspect === 'source' && !K().state.clips.length) K().setAspect('9:16'); // phones edit vertical by default
    syncFmt();
    window.dispatchEvent(new Event('resize'));
  }

  function init() {
    // guides button in the transport (desktop and mobile)
    const g = document.createElement('button'); g.id = 'btnGuides'; g.className = 'btn small'; g.textContent = 'Guides';
    g.title = 'Show TikTok / Reels / Shorts safe zones (9:16)';
    g.onclick = cycleGuides;
    $('btnRaw').after(g);
    const gl = document.createElement('div'); gl.id = 'guides'; gl.className = 'guides'; gl.hidden = true; $('stage').appendChild(gl);
    new ResizeObserver(drawGuides).observe($('stage'));
    $('aspect').addEventListener('change', () => { syncFmt(); requestAnimationFrame(drawGuides); });
    setInterval(drawGuides, 1000); // canvas size follows imports and aspect changes
    build();
    MQ.addEventListener('change', apply);
    apply();
    window.KutMobile = { setSheet, cycleGuides, isMobile: () => document.body.classList.contains('mobile') };
    importShared();
  }
  /* files shared into the installed app (Android share sheet → KutLabz) */
  async function importShared() {
    if (!/[?&]shared=/.test(location.search) || !('caches' in window)) return;
    try {
      const box = await caches.open('kutlabz-shared'), reqs = await box.keys(), files = [];
      for (const r of reqs) { const res = await box.match(r); const blob = await res.blob(); files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'shared'), { type: blob.type })); await box.delete(r); }
      history.replaceState(null, '', location.pathname);
      if (files.length) K().importFiles(files);
    } catch (e) { console.warn('shared import failed', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
