/* Khair Mart — "type to find" picker (v50, owner 2026-10-15: «في الخانات المخصصة للتعبئة واختيار العناصر يجب أن يكون إمكانية كتابة
   الكلمة كاملة ليس الحرف فقط … لا يمكن كتابة شيء بعد كلمة توبليس أو ستيكر … فهي تكون عنصر للاختيار بس وليس مكان للكتابة»).
   Replaces a <select>: type any part of the name — whole words, several words in any order — and tap (or Enter) one of the matches.
   The value is only ever one of the items: once chosen it shows as a fixed chip (nothing can be typed after it); tapping the chip
   searches again, ✕ clears it. Text typed but not chosen is dropped when the field is left (an exact name is taken).
     const pk = KPick.mount(host, { id, items: [{ id, label, sub, keys?, rank? }], value, placeholder, empty, extra: [{ id, label, sub }], onChange(id, item, typed) })
       extra: always offered (e.g. "＋ Kemasan baru"); `typed` = what was typed when it was chosen
     pk.value · pk.item · pk.set(id) · pk.setItems(items) · pk.focus() · pk.open()
   Test hooks: the host gets id + data-value; the search box is #<id>-q, the chip #<id>-v, each option [data-pick="<item id>"]. */
(function () {
  'use strict';
  if (window.KPick) return;
  const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}.,]+/gu, ' ').trim();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const MAX = 60;
  function css() {
    if (document.getElementById('kpick-css')) return;
    const st = document.createElement('style'); st.id = 'kpick-css';
    st.textContent = '.kpick{position:relative}.kpick .kp-chip{display:flex;align-items:center;gap:8px;width:100%;text-align:start;cursor:pointer;font:inherit}'
      + '.kpick .kp-chip .kp-l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}.kpick .kp-chip .kp-x{flex:none;opacity:.6;padding:0 4px}'
      + '.kpick .kp-list{position:absolute;inset-inline:0;top:calc(100% + 4px);z-index:60;max-height:280px;overflow:auto;background:var(--card,#fff);color:var(--text,#111);'
      + 'border:1px solid var(--border,#d6dae3);border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.18);padding:4px}'
      + '.kpick .kp-opt{display:block;width:100%;text-align:start;background:none;border:0;border-radius:8px;padding:9px 10px;font:inherit;color:inherit;cursor:pointer}'
      + '.kpick .kp-opt small{display:block;opacity:.7;font-size:12px;margin-top:1px}.kpick .kp-opt.on,.kpick .kp-opt:hover{background:var(--hover,rgba(30,64,175,.09))}'
      + '.kpick .kp-opt.kp-extra{font-weight:700;color:var(--primary,#1E40AF)}.kpick .kp-none{padding:9px 10px;opacity:.7}.kpick mark{background:rgba(250,204,21,.45);color:inherit;border-radius:3px;padding:0}';
    (document.head || document.documentElement).appendChild(st);
  }
  function hl(label, toks) {
    let s = esc(label);
    toks.forEach(t => { if (t.length < 2) return; const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i'); s = s.replace(re, '<mark>$1</mark>'); });
    return s;
  }
  function mount(host, o) {
    css();
    const id = o.id || host.id || ('kp' + Math.random().toString(36).slice(2, 8));
    let items = (o.items || []).slice(), value = '', item = null, active = 0, shown = [], typedAtPick = '';
    host.classList.add('kpick'); host.id = id; host.setAttribute('data-value', '');
    host.innerHTML = `<button type="button" class="input kp-chip" id="${esc(id)}-v" hidden><span class="kp-l"></span><span class="kp-x" aria-hidden="true">✕</span></button>`
      + `<input class="input kp-q" id="${esc(id)}-q" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${esc(id)}-list" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(o.placeholder || '')}">`
      + `<div class="kp-list" id="${esc(id)}-list" role="listbox" hidden></div>`;
    const chip = host.querySelector('.kp-chip'), q = host.querySelector('.kp-q'), list = host.querySelector('.kp-list');
    if (o.label) q.setAttribute('aria-label', o.label);
    const extras = () => (o.extra || []).slice();
    function match(text) {
      const toks = norm(text).split(' ').filter(Boolean);
      if (!toks.length) return { toks, rows: items.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0)).slice(0, MAX) };
      const scored = [];
      items.forEach(it => {
        const hay = ' ' + norm(it.label + ' ' + (it.sub || '') + ' ' + (it.keys || '')) + ' ';
        if (!toks.every(t => hay.indexOf(t) >= 0)) return;
        const lab = norm(it.label);
        const sc = (lab.indexOf(toks.join(' ')) === 0 ? 0 : toks.every(t => (' ' + lab).indexOf(' ' + t) >= 0) ? 1 : 2);
        scored.push([sc, it]);
      });
      scored.sort((a, b) => a[0] - b[0] || (a[1].rank || 0) - (b[1].rank || 0) || String(a[1].label).localeCompare(String(b[1].label)));
      return { toks, rows: scored.slice(0, MAX).map(x => x[1]) };
    }
    function draw() {
      const m = match(q.value), ex = extras();
      shown = m.rows.concat(ex.map(x => Object.assign({ _extra: true }, x)));
      if (active >= shown.length) active = 0;
      list.innerHTML = (m.rows.length ? '' : `<div class="kp-none">${esc(o.empty || '—')}</div>`)
        + shown.map((it, i) => `<button type="button" role="option" tabindex="-1" id="${esc(id)}-o${i}" class="kp-opt ${it._extra ? 'kp-extra' : ''} ${i === active ? 'on' : ''}" data-pick="${esc(it.id)}" aria-selected="${i === active}">`
          + `${it._extra ? esc(it.label) : hl(it.label, m.toks)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('');
      q.setAttribute('aria-activedescendant', shown.length ? id + '-o' + active : '');
    }
    function openList() { if (q.hidden) return; list.hidden = false; q.setAttribute('aria-expanded', 'true'); draw(); }
    function closeList() { list.hidden = true; q.setAttribute('aria-expanded', 'false'); }
    function show() {
      host.setAttribute('data-value', value);
      if (item) { chip.hidden = false; q.hidden = true; chip.querySelector('.kp-l').textContent = item.label; chip.title = item.label + (item.sub ? ' — ' + item.sub : ''); closeList(); }
      else { chip.hidden = true; q.hidden = false; }
    }
    function choose(it, silent) {
      typedAtPick = q.value.trim();
      value = it ? String(it.id) : ''; item = it || null; q.value = ''; active = 0;
      show();
      if (!silent && o.onChange) o.onChange(value, item, typedAtPick);
    }
    list.addEventListener('mousedown', e => e.preventDefault()); // keep the focus in the box while tapping an option
    list.addEventListener('click', e => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      const it = shown.find(x => String(x.id) === b.getAttribute('data-pick')); if (it) choose(it._extra ? Object.assign({}, it, { _extra: undefined }) : it);
    });
    q.addEventListener('focus', openList);
    q.addEventListener('input', () => { active = 0; openList(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) openList(); else if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; draw(); const el = document.getElementById(id + '-o' + active); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } }
      else if (e.key === 'Enter') { if (!list.hidden && shown[active]) { e.preventDefault(); choose(shown[active]); } }
      else if (e.key === 'Escape') { if (item || !list.hidden) { e.preventDefault(); closeList(); if (item) show(); } }
    });
    q.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === q) return;
        closeList();
        const t = norm(q.value);
        if (t) { const exact = items.find(it => norm(it.label) === t); if (exact) { choose(exact); return; } q.value = ''; } // only a name from the list
        if (item) show();
      }, 120);
    });
    chip.addEventListener('click', e => {
      if (e.target.closest('.kp-x')) { choose(null); q.focus(); return; }
      chip.hidden = true; q.hidden = false; q.value = ''; q.focus();
    });
    const api = {
      get value() { return value; }, get item() { return item; }, get typed() { return typedAtPick; },
      set(v, silent) { const it = v === '' || v == null ? null : items.concat(extras()).find(x => String(x.id) === String(v)) || null; choose(it, silent !== false); },
      setItems(arr) { items = (arr || []).slice(); if (value && !items.concat(extras()).some(x => String(x.id) === value)) choose(null, true); else if (!list.hidden) draw(); },
      setExtra(arr) { o.extra = arr || []; if (!list.hidden) draw(); },
      focus() { if (item) { chip.hidden = true; q.hidden = false; } q.focus(); },
      open: openList, host
    };
    host._kpick = api;
    if (o.value !== undefined && o.value !== '' && o.value !== null) api.set(o.value, true);
    return api;
  }
  window.KPick = { mount, norm };
})();
