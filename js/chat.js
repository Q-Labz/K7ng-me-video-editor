/* KutLabz Assistant — edit by chatting.
   Two engines:
   1. Local (default, offline): a command parser that maps plain-English requests to the editor's tools.
   2. Claude (opt-in): the user's own Anthropic API key; Claude plans the edit and calls the same tools.
      Only the conversation text and a timeline summary are sent — never media. */
(function () {
  'use strict';

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
  const MODEL = 'claude-opus-5-5';
  const KEY_STORE = 'kutlabz.anthropicKey';
  const $ = (id) => document.getElementById(id);
  const K = () => window.KutLabz;
  const AI_TOOLS = {
    scenes: 'Detect Scene Cuts', deadframes: 'Detect Dead Frames', applysilence: 'Cut Marked Zones', silence: 'Detect Silence',
    loudness: 'Loudness Match', voice: 'Voice Enhance (toggle)', beatcut: 'Cut to Beat', autograde: 'Auto Grade', matchshots: 'Match Shots',
    reframe: 'Smart Reframe', stabilize: 'Stabilize', resetframe: 'Reset Framing', autozoom: 'Auto Zoom', thumbnail: 'Best Thumbnail (downloads a PNG)',
  };

  /* ---------------- UI ---------------- */
  let busy = false, sessionKey = null;
  const history = []; // Claude conversation (append-only, assistant content passed back unchanged)

  let lastReply = null, actionCount = 0; // reported back to callers such as the prompt bar
  function bubble(role, text, cls = '') {
    if (role === 'assistant' && !/pending/.test(cls)) lastReply = { text, error: /err/.test(cls) };
    const el = document.createElement('div');
    el.className = `msg ${role} ${cls}`.trim();
    el.textContent = text;
    $('chatLog').appendChild(el); $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return el;
  }
  function actionChip(name, detail) {
    actionCount++;
    const el = document.createElement('div'); el.className = 'msg act';
    const b = document.createElement('b'); b.textContent = '▸ ' + name; el.appendChild(b);
    if (detail) { const s = document.createElement('span'); s.textContent = detail; el.appendChild(s); }
    $('chatLog').appendChild(el); $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return el;
  }
  function getKey() { if (sessionKey) return sessionKey; try { return localStorage.getItem(KEY_STORE); } catch (e) { return null; } }
  function renderMode() {
    const k = getKey();
    $('chatMode').textContent = k ? `Claude · key …${k.slice(-4)}` : 'Local · offline';
    $('chatConnect').textContent = k ? 'Disconnect' : 'Connect Claude';
  }
  function setBusy(v) { busy = v; $('chatSend').disabled = v; $('chatInput').disabled = v; $('chatSend').textContent = v ? 'Working…' : 'Send'; }

  /* ---------------- shared tool executor ---------------- */
  async function execute(name, input) {
    const api = K();
    switch (name) {
      case 'get_timeline': return JSON.stringify(api.summary());
      case 'run_ai_tool':
        if (!AI_TOOLS[input.tool]) return `Unknown tool. Valid: ${Object.keys(AI_TOOLS).join(', ')}`;
        return api.runTool(input.tool, Number.isInteger(input.clip_index) ? input.clip_index : null);
      case 'highlight_reel': {
        const mark = api.toastLog.length;
        await api.tools.highlight(String([15, 30, 60, 90].includes(+input.seconds) ? +input.seconds : 30));
        while (api.state.busy) await new Promise((r) => setTimeout(r, 100));
        return api.toastLog.slice(mark).map((m) => m.msg).join(' | ') || 'Done';
      }
      case 'set_color': return api.setColor(input, input.mode === 'adjust' ? 'adjust' : 'set');
      case 'set_look': return api.setLook(input.look, typeof input.intensity === 'number' ? input.intensity : undefined);
      case 'set_aspect': return api.setAspect(input.aspect);
      case 'add_text': {
        if (!input.text) return 'add_text needs text';
        await api.tools.title({ text: String(input.text), style: input.style, start: typeof input.start === 'number' ? input.start : api.state.time, duration: input.duration });
        const t = api.state.texts.find((x) => x.text === String(input.text).trim());
        return t ? `Added ${t.style} "${t.text}" at ${t.start}s–${t.end}s` : 'Text not added';
      }
      case 'remove_text': return api.deleteText(input.text_index);
      case 'edit_clip': return api.editClip(input);
      case 'seek': api.seek(+input.time || 0); return `Playhead at ${api.state.time.toFixed(2)}s`;
      case 'undo': { const n = Math.max(1, Math.min(10, input.steps | 0 || 1)); for (let i = 0; i < n; i++) api.undo(); return `Undid ${n} step${n > 1 ? 's' : ''}`; }
      default: return `Unknown tool ${name}`;
    }
  }

  /* ---------------- engine 1: local command parser ---------------- */
  const LOCAL_HELP = 'Try: “cut the silences”, “level the audio”, “make a 30 second highlight reel”, “stabilize”, “vertical for TikTok”, “warmer and brighter”, “use the teal look”, “add title Launch Day”, “auto zoom”, “detect scenes”, “undo”. Connect Claude for free-form requests.';
  function parseLocal(text) {
    const acts = []; let t = text.toLowerCase();
    const push = (name, input, label) => acts.push({ name, input: input || {}, label });
    const quoted = text.match(/["“'‘](.+?)["”'’]/);
    if (/\bundo\b/.test(t)) push('undo', { steps: +(t.match(/undo (\d+)/) || [])[1] || 1 }, 'Undo');
    if (/(title|caption|lower third|text)\b/.test(t) && /(add|put|write|insert|title)/.test(t)) {
      const style = /caption/.test(t) ? 'caption' : /lower/.test(t) ? 'lower' : 'title';
      const body = quoted ? quoted[1] : text.replace(/^.*?\b(?:add|put|insert|write)\b\s*(?:an?|the)?\s*(?:title|caption|lower third|text)\s*(?:that says|saying|reading|:)?\s*/i, '').replace(/\s+(?:at|from)\s+\d.*$/i, '').trim();
      const at = t.match(/(?:at|from)\s+(\d+(?:\.\d+)?)\s*s?/);
      if (body) {
        push('add_text', { text: body, style, start: at ? +at[1] : undefined, duration: style === 'caption' ? 2.5 : 3 }, `Add ${style}`);
        t = t.replace(body.toLowerCase(), ' '); // the title's own words must not trigger other edits
      }
    }
    if (/silen|dead air|pauses/.test(t)) { push('run_ai_tool', { tool: 'silence' }, 'Detect Silence'); if (/(cut|remove|trim|delete|tighten)/.test(t)) push('run_ai_tool', { tool: 'applysilence' }, 'Cut Marked Zones'); }
    if (/black frames?|frozen|dead frames?|idle/.test(t)) { push('run_ai_tool', { tool: 'deadframes' }, 'Detect Dead Frames'); if (/(cut|remove|trim|delete)/.test(t)) push('run_ai_tool', { tool: 'applysilence' }, 'Cut Marked Zones'); }
    if (/scene|shots?\b.*detect|detect.*cuts?/.test(t) && !/match/.test(t)) push('run_ai_tool', { tool: 'scenes' }, 'Detect Scene Cuts');
    const hl = t.match(/(\d+)\s*(?:s\b|sec|second)/);
    if (/highlight|reel|best (bits|moments|parts)|shorten|cut (it )?down/.test(t)) { const sec = [15, 30, 60, 90].reduce((b, v) => (Math.abs(v - (hl ? +hl[1] : 30)) < Math.abs(b - (hl ? +hl[1] : 30)) ? v : b), 30); push('highlight_reel', { seconds: sec }, `Highlight Reel ${sec} s`); }
    if (/loud|level|normali[sz]e|volume/.test(t)) push('run_ai_tool', { tool: 'loudness' }, 'Loudness Match');
    if (/voice|dialog|speech|vocal|clarity of/.test(t)) push('run_ai_tool', { tool: 'voice' }, 'Voice Enhance');
    if (/beat|rhythm|music sync|on the music/.test(t)) push('run_ai_tool', { tool: 'beatcut' }, 'Cut to Beat');
    if (/stabil|shak|smooth (out )?the camera/.test(t)) push('run_ai_tool', { tool: 'stabilize' }, 'Stabilize');
    if (/zoom/.test(t)) push('run_ai_tool', { tool: 'autozoom' }, 'Auto Zoom');
    if (/vertical|9[:x]16|tiktok|reels?|shorts|portrait/.test(t)) { push('set_aspect', { aspect: '9:16' }, 'Aspect 9:16'); push('run_ai_tool', { tool: 'reframe' }, 'Smart Reframe'); }
    else if (/square|1[:x]1|instagram post/.test(t)) { push('set_aspect', { aspect: '1:1' }, 'Aspect 1:1'); push('run_ai_tool', { tool: 'reframe' }, 'Smart Reframe'); }
    else if (/widescreen|16[:x]9|landscape|youtube/.test(t)) push('set_aspect', { aspect: '16:9' }, 'Aspect 16:9');
    if (/auto ?grade|colou?r correct|fix (the )?colou?r|auto colou?r/.test(t)) push('run_ai_tool', { tool: 'autograde' }, 'Auto Grade');
    if (/match (the )?(shots|clips|colou?r)/.test(t)) push('run_ai_tool', { tool: 'matchshots' }, 'Match Shots');
    const adj = {};
    if (/brighter|lighten|too dark/.test(t)) adj.exposure = 0.3; if (/darker|too bright/.test(t)) adj.exposure = -0.3;
    if (/warmer|warm it/.test(t)) adj.temperature = 0.2; if (/cooler|colder/.test(t)) adj.temperature = -0.2;
    if (/more contrast|punchier|punchy/.test(t)) adj.contrast = 0.12; if (/less contrast|flatter/.test(t)) adj.contrast = -0.12;
    if (/more saturat|more colou?r|vivid/.test(t)) adj.saturation = 0.15; if (/less saturat|desaturat|muted/.test(t)) adj.saturation = -0.15;
    if (/vignette/.test(t)) adj.vignette = 0.3; if (/faded|filmic fade/.test(t)) adj.fade = 0.2;
    if (Object.keys(adj).length) push('set_color', { ...adj, mode: 'adjust' }, 'Adjust grade');
    const look = t.match(/(?:look|lut|filter|style)\s*(?:called|named|:)?\s*["“]?([a-z &]+?)["”]?(?:\s+look)?$/) || t.match(/(teal|warm film|bleach|noir|cross|faded matte|cool night|vivid pop)/);
    if (look && !/stabil/.test(t)) push('set_look', { look: look[1].trim() }, 'Set look');
    if (/thumbnail/.test(t)) push('run_ai_tool', { tool: 'thumbnail' }, 'Best Thumbnail');
    if (/reset (the )?fram|remove (the )?zoom|undo reframe/.test(t)) push('run_ai_tool', { tool: 'resetframe' }, 'Reset Framing');
    return acts;
  }
  async function runLocal(text) {
    const acts = parseLocal(text);
    if (!acts.length) { bubble('assistant', `I didn't catch an edit there. ${LOCAL_HELP}`, 'err'); return; }
    for (const a of acts) {
      const chip = actionChip(a.label);
      try { const res = await execute(a.name, a.input); chip.appendChild(Object.assign(document.createElement('span'), { textContent: res })); }
      catch (e) { chip.classList.add('err'); chip.appendChild(Object.assign(document.createElement('span'), { textContent: e.message })); }
    }
    const s = K().summary();
    bubble('assistant', `Done — ${s.clips.length} clip${s.clips.length === 1 ? '' : 's'}, ${s.duration.toFixed(1)} s. Undo (Ctrl+Z) reverts any step.`);
  }

  /* ---------------- engine 2: Claude with tool use ---------------- */
  const TOOLS = [
    { name: 'get_timeline', description: 'Return the current edit as JSON: clips (index, start, duration, source in/out, framing, audio gain, markers), text items, music bed, the global grade and the list of available looks. Call this before editing when you need positions or indices.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'run_ai_tool', description: `Run one of the editor's analysis/edit tools. Detect* tools only add markers; applysilence ("Cut Marked Zones") removes marked silence and dead frames. reframe/stabilize/autozoom replace each other on a clip. Tools: ${Object.entries(AI_TOOLS).map(([k, v]) => `${k} = ${v}`).join('; ')}. Omit clip_index to apply to every clip.`, input_schema: { type: 'object', properties: { tool: { type: 'string', enum: Object.keys(AI_TOOLS) }, clip_index: { type: 'integer', description: '0-based clip index; omit for all clips' } }, required: ['tool'], additionalProperties: false } },
    { name: 'highlight_reel', description: 'Replace the edit with its strongest moments (motion, audio energy, visual interest) at the target length, in original order. Undoable.', input_schema: { type: 'object', properties: { seconds: { type: 'integer', enum: [15, 30, 60, 90] } }, required: ['seconds'], additionalProperties: false } },
    { name: 'set_color', description: 'Set or nudge the global grade. mode "set" uses absolute values; mode "adjust" adds to the current values (contrast and saturation scale by 1+value). Ranges (set): exposure -2..2 stops, contrast 0.5..1.8 (1 neutral), highlights/shadows/temperature/tint/vibrance/vignette -1..1, saturation 0..2 (1 neutral), fade 0..1.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['set', 'adjust'] }, exposure: { type: 'number' }, contrast: { type: 'number' }, highlights: { type: 'number' }, shadows: { type: 'number' }, temperature: { type: 'number' }, tint: { type: 'number' }, saturation: { type: 'number' }, vibrance: { type: 'number' }, vignette: { type: 'number' }, fade: { type: 'number' } }, required: ['mode'], additionalProperties: false } },
    { name: 'set_look', description: 'Apply a creative LUT look by name (see looks_available in get_timeline; "None" removes it) with optional intensity 0..1.', input_schema: { type: 'object', properties: { look: { type: 'string' }, intensity: { type: 'number' } }, required: ['look'], additionalProperties: false } },
    { name: 'set_aspect', description: 'Set the output aspect ratio. Follow with run_ai_tool reframe to keep the subject in frame.', input_schema: { type: 'object', properties: { aspect: { type: 'string', enum: ['source', '16:9', '9:16', '1:1', '4:5'] } }, required: ['aspect'], additionalProperties: false } },
    { name: 'add_text', description: 'Add a title (centred), lower third (name/role bar) or caption (bottom) on the timeline. Times are timeline seconds.', input_schema: { type: 'object', properties: { text: { type: 'string' }, style: { type: 'string', enum: ['title', 'lower', 'caption'] }, start: { type: 'number' }, duration: { type: 'number' } }, required: ['text', 'style'], additionalProperties: false } },
    { name: 'remove_text', description: 'Remove a text item by its index from get_timeline.', input_schema: { type: 'object', properties: { text_index: { type: 'integer' } }, required: ['text_index'], additionalProperties: false } },
    { name: 'edit_clip', description: 'Cut-level edits. split: needs time (timeline seconds). delete: clip_index. trim: clip_index plus in and/or out in SOURCE seconds. move: clip_index and to_index.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['split', 'delete', 'trim', 'move'] }, clip_index: { type: 'integer' }, time: { type: 'number' }, in: { type: 'number' }, out: { type: 'number' }, to_index: { type: 'integer' } }, required: ['action'], additionalProperties: false } },
    { name: 'seek', description: 'Move the playhead (timeline seconds).', input_schema: { type: 'object', properties: { time: { type: 'number' } }, required: ['time'], additionalProperties: false } },
    { name: 'undo', description: 'Undo the last edit steps (clip and text edits; not grade changes).', input_schema: { type: 'object', properties: { steps: { type: 'integer' } }, additionalProperties: false } },
  ];
  const SYSTEM = `You are the editing assistant inside KutLabz, a browser video editor. The user describes what they want; you carry it out with the tools, which act on their open project.

How the editor works:
- One video track of clips played in order, a text lane (titles, lower thirds, captions burned into the export) and an optional music bed.
- Times you pass to add_text, seek and edit_clip split are timeline seconds; edit_clip trim takes source seconds of that clip.
- Analysis tools run locally on the user's footage and report what they found; you never see the pixels or hear the audio, so rely on those reports and on get_timeline.
- Every clip edit is undoable; the global grade is not part of undo, so note the previous values before large grade changes.

Work style: check get_timeline when you need indices, durations or what is already applied. Make the edit, then reply in one to three short sentences with what changed and any numbers worth knowing. If a request is ambiguous in a way that changes the result (which clip, how long), ask one short question instead of guessing. If something can't be done with these tools (exporting, importing new media, effects that aren't listed), say so plainly.`;

  let clientPromise = null;
  async function client() {
    const key = getKey(); if (!key) throw new Error('No API key');
    if (!clientPromise || clientPromise.key !== key) {
      clientPromise = import(SDK_URL).then((m) => new m.default({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }));
      clientPromise.key = key;
    }
    return clientPromise;
  }
  async function runClaude(text) {
    const anthropic = await client();
    history.push({ role: 'user', content: text });
    const thinking = bubble('assistant', 'Thinking…', 'pending');
    try {
      for (let turn = 0; turn < 16; turn++) {
        const response = await anthropic.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM,
          tools: TOOLS,
          messages: history,
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        history.push({ role: 'assistant', content: response.content }); // passed back unchanged, thinking blocks included
        for (const b of response.content) if (b.type === 'text' && b.text.trim()) bubble('assistant', b.text.trim());
        if (response.stop_reason === 'refusal') { bubble('assistant', 'Claude declined this request. Try rephrasing it as an editing instruction.', 'err'); break; }
        if (response.stop_reason === 'pause_turn') continue;
        if (response.stop_reason !== 'tool_use') { if (response.stop_reason === 'max_tokens') bubble('assistant', '(reply cut off at the length limit)', 'err'); break; }
        const results = [];
        for (const b of response.content) {
          if (b.type !== 'tool_use') continue;
          const chip = actionChip(b.name, b.name === 'get_timeline' ? '' : JSON.stringify(b.input));
          let out, isErr = false;
          try { out = await execute(b.name, b.input || {}); } catch (e) { out = `Error: ${e.message}`; isErr = true; }
          if (b.name !== 'get_timeline') chip.appendChild(Object.assign(document.createElement('span'), { textContent: out }));
          if (isErr) chip.classList.add('err');
          results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out), ...(isErr ? { is_error: true } : {}) });
        }
        history.push({ role: 'user', content: results }); // all results in one message
      }
    } catch (e) {
      // keep the conversation valid for the next turn: drop the unanswered user message
      if (history.length && history[history.length - 1].role === 'user' && typeof history[history.length - 1].content === 'string') history.pop();
      const status = e && e.status;
      const msg = status === 401 ? 'The API key was rejected. Check it in Connect Claude.'
        : status === 429 ? 'Rate limited by the API — wait a moment and try again.'
        : status === 529 || status >= 500 ? 'The API is overloaded right now — try again shortly.'
        : /Failed to fetch|NetworkError|import/i.test(String(e && e.message)) ? 'Could not reach the Anthropic API (or load its SDK). Check your connection, or use local commands.'
        : `Claude error: ${e && e.message ? e.message : e}`;
      bubble('assistant', msg, 'err');
    } finally { thinking.remove(); }
  }

  /* ---------------- wiring ---------------- */
  /** Run one prompt. Returns { reply, error, actions } so other surfaces (prompt bar, recipes) can show the outcome. */
  async function send(textArg, opts = {}) {
    const text = (textArg ?? $('chatInput').value).trim();
    if (!text) return { reply: '', error: true, actions: 0 };
    if (busy) return { reply: 'The assistant is still working on the previous prompt.', error: true, actions: 0, busy: true };
    if (textArg == null) $('chatInput').value = '';
    lastReply = null; actionCount = 0;
    bubble('user', text);
    setBusy(true);
    try {
      if (!K().state.clips.length && !/title|caption|text|undo/i.test(text)) bubble('assistant', 'Import some footage first — then tell me what to do with it.', 'err');
      else if (getKey()) await runClaude(text); else await runLocal(text);
    } finally { setBusy(false); if (!opts.quiet) $('chatInput').focus(); }
    return { reply: lastReply ? lastReply.text : '', error: !!(lastReply && lastReply.error), actions: actionCount };
  }
  async function connect() {
    if (getKey()) { sessionKey = null; try { localStorage.removeItem(KEY_STORE); } catch (e) { /* storage blocked */ } history.length = 0; clientPromise = null; renderMode(); bubble('assistant', 'Disconnected — back to local commands.'); return; }
    const box = $('chatKeyBox'); box.hidden = !box.hidden; if (!box.hidden) $('chatKey').focus();
  }
  function saveKey() {
    const k = $('chatKey').value.trim(); if (!k) return;
    sessionKey = k;
    if ($('chatRemember').checked) { try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* storage blocked: keep for this session */ } }
    $('chatKey').value = ''; $('chatKeyBox').hidden = true; history.length = 0; renderMode();
    bubble('assistant', 'Connected to Claude Opus 5.5. Describe the edit you want — for example “turn this into a punchy 30-second vertical teaser with a title”.');
  }
  function init() {
    document.querySelectorAll('.tabs .tab').forEach((t) => (t.onclick = () => {
      document.querySelectorAll('.tabs .tab').forEach((x) => x.classList.toggle('on', x === t));
      $('tabGrade').hidden = t.dataset.tab !== 'grade'; $('chatPanel').hidden = t.dataset.tab !== 'chat';
      if (t.dataset.tab === 'chat') $('chatInput').focus();
    }));
    $('chatSend').onclick = () => send();
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $('chatConnect').onclick = connect;
    $('chatKeySave').onclick = saveKey;
    $('chatKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
    document.querySelectorAll('.chat-suggest button').forEach((b) => (b.onclick = () => send(b.textContent)));
    renderMode();
    bubble('assistant', `I edit while you describe. ${LOCAL_HELP}`);
  }
  window.KutChat = { send, parseLocal, execute, TOOLS, isBusy: () => busy, engine: () => (getKey() ? 'claude' : 'local'), _history: history };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
