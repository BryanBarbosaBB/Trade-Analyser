/* Interface: painel (scanner), detalhe do ativo, configurações. */
(function (MA) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const state = {
    settings: MA.settings.load(),
    results: {}, errors: {}, busy: false,
    current: null, tf: 'M15', userPlan: null, ai: {},
  };
  const enabled = () => state.settings.assets.filter((a) => a.enabled);
  const assetBy = (name) => state.settings.assets.find((a) => a.name === name);
  const fmt = (x, d) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
  const arrow = (dir) => dir === 'alta' ? '<span class="up" title="alta">▲</span>' : dir === 'baixa' ? '<span class="down" title="baixa">▼</span>' : '<span class="neutral" title="neutro">▬</span>';
  const badge = (st) => '<span class="badge b-' + (st === 'SEM SETUP' ? 'SEM' : st) + '">' + esc(st) + '</span>';

  const LABELS = { alinhamento: 'Alinhamento D1/H4', zona: 'Qualidade da zona/nível', momento: 'Momento (RSI/MACD)', rr: 'R:R até nível contrário', volatilidade: 'Volatilidade (ATR)', sessao: 'Sessão' };
  const MAXP = { alinhamento: 30, zona: 20, momento: 15, rr: 15, volatilidade: 10, sessao: 10 };

  // ---------------- navegação ----------------
  function show(view) {
    for (const v of ['painel', 'detalhe', 'config']) $('v-' + v).classList.toggle('hidden', v !== view);
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === (view === 'detalhe' ? 'painel' : view)));
    if (view !== 'detalhe') MA.chart.destroy();
    window.scrollTo(0, 0);
  }

  // ---------------- análise ----------------
  async function analyze(asset, { force = false, cacheOnly = false } = {}) {
    try {
      const data = await MA.data.getAll(asset, state.settings, (s) => setStatus('Limite grátis da API (8/min): aguardando ' + s + 's…'), force, cacheOnly);
      state.results[asset.name] = MA.setups.analyzeAsset(asset, data, state.settings);
      delete state.errors[asset.name];
    } catch (e) {
      if (!cacheOnly) state.errors[asset.name] = e.message;
    }
  }

  function setStatus(t) { $('scan-status').textContent = t; }

  // ---------------- alertas (ntfy) ----------------
  async function sendNtfy(title, message, priority = 4) {
    const topic = (state.settings.ntfyTopic || '').trim();
    if (!topic) return false;
    const res = await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic, title, message, priority, tags: ['chart_with_upwards_trend'] }) });
    return res.ok;
  }

  /* Avisa cada ENTRADA uma única vez (por ativo, setup, direção e vela). */
  function alertIfEntry(r) {
    const b = r && r.best;
    if (!b || b.status !== 'ENTRADA' || !state.settings.ntfyTopic) return;
    const key = 'ma.alert.' + r.asset + '.' + b.name + '.' + b.dir + '.' + r.updated;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) { /* sem storage: avisa mesmo assim */ }
    const d = r.digits, p = b.plan;
    sendNtfy('ENTRADA ' + b.dir.toUpperCase() + ' ' + r.asset + ' (score ' + b.score + ')',
      [b.dir.toUpperCase() + ' ' + r.asset + ' @ ' + fmt(p.entry, d),
        'SL ' + fmt(p.sl, d) + ' | TP1 ' + fmt(p.tp1, d) + ' | TP2 ' + fmt(p.tp2, d),
        b.name, location.href.split('#')[0]].join('\n'), 5).catch(() => {});
  }

  async function scanAll() {
    if (state.busy) return;
    if (!state.settings.tdKey) { show('config'); $('save-status').textContent = 'Informe a chave do Twelve Data primeiro.'; return; }
    state.busy = true; $('btn-scan').disabled = true;
    const list = enabled();
    for (let i = 0; i < list.length; i++) {
      setStatus('Analisando ' + list[i].name + ' (' + (i + 1) + '/' + list.length + ')…');
      await analyze(list[i]);
      alertIfEntry(state.results[list[i].name]);
      renderList();
    }
    const n = Object.keys(state.errors).length;
    setStatus('Concluído ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + (n ? ' — ' + n + ' com erro' : ''));
    state.busy = false; $('btn-scan').disabled = false;
  }

  // ---------------- painel ----------------
  function renderList() {
    const rows = enabled().map((a) => ({ a, r: state.results[a.name], e: state.errors[a.name] }));
    rows.sort((x, y) => (y.r ? y.r.score : -1) - (x.r ? x.r.score : -1));
    $('list').innerHTML = rows.map(({ a, r, e }) => {
      if (!r) {
        return '<div class="row" data-asset="' + a.name + '"><div class="c-name"><div class="name">' + a.name + '</div><div class="price">' + esc(a.td) + '</div></div>' +
          '<div class="c-arrows muted">—</div><div class="c-setup">' + (e ? '<span class="err">' + esc(e) + '</span>' : '<span class="muted">Não analisado</span>') + '</div>' +
          '<div class="c-score"></div><div class="c-status">' + (e ? '<span class="badge b-ERRO">ERRO</span>' : '') + '</div><div class="c-time"></div></div>';
      }
      const b = r.best;
      const setup = b ? esc(b.name) + ' — <b class="' + (b.dir === 'compra' ? 'up' : 'down') + '">' + b.dir + '</b><small>' +
        (b.triggered ? 'Gatilho confirmado' : 'Área a ' + fmt(b.area.distAtr, 1) + ' ATR(H1)') + '</small>' : '<span class="muted">Nenhum setup</span>';
      return '<div class="row" data-asset="' + a.name + '">' +
        '<div class="c-name"><div class="name">' + a.name + '</div><div class="price">' + fmt(r.price, r.digits) + (a.proxy ? ' · ' + esc(a.td) : '') + '</div></div>' +
        '<div class="c-arrows arrows">' + ['D1', 'H4', 'H1', 'M15'].map((k) => arrow(r.bias[k].dir)).join('') + '</div>' +
        '<div class="c-setup setup-txt">' + setup + (e ? '<small class="err">' + esc(e) + '</small>' : '') + '</div>' +
        '<div class="c-score score">' + r.score + '<span class="bar"><i style="width:' + r.score + '%"></i></span></div>' +
        '<div class="c-status">' + badge(r.status) + '</div>' +
        '<div class="c-time time">' + MA.chart.fmtTime(r.updated + MA.data.TF_SEC.M15) + '</div></div>';
    }).join('');
    const hint = $('setup-hint');
    const missing = [];
    if (!state.settings.tdKey) missing.push('a chave do <b>Twelve Data</b> (cotações)');
    if (!state.settings.geminiKey) missing.push('a chave do <b>Gemini</b> (IA)');
    hint.classList.toggle('hidden', !missing.length);
    hint.innerHTML = MA.auth.hasVault()
      ? 'Chaves bloqueadas neste aparelho. <a href="#" id="go-login">Entrar</a> para desbloquear.'
      : 'Para começar, informe ' + missing.join(' e ') + ' em <a href="#" id="go-config">Configurações</a>. As duas são gratuitas.';
  }

  async function rankAI() {
    const box = $('rank-box');
    const results = Object.values(state.results);
    box.classList.remove('hidden');
    if (!results.length) { box.innerHTML = '<p class="muted">Faça uma varredura primeiro.</p>'; return; }
    box.innerHTML = '<p class="muted">Consultando a IA…</p>';
    try {
      const out = await MA.ai.rank(results, state.settings);
      box.innerHTML = '<h2>Ranking da IA</h2>' +
        (out.ranking && out.ranking.length ? '<ol class="tight">' + out.ranking.map((x) => '<li><b>' + esc(x.ativo) + '</b> — ' + esc(x.motivo) + '</li>').join('') + '</ol>' : '') +
        '<p>' + esc(out.comentario_geral || '') + '</p>';
    } catch (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
  }

  // ---------------- detalhe ----------------
  async function openAsset(name) {
    state.current = name; state.userPlan = null;
    show('detalhe');
    $('d-title').textContent = name;
    if (!state.results[name]) {
      $('d-status').innerHTML = '<span class="muted">Carregando…</span>';
      await analyze(assetBy(name));
    }
    renderDetail();
  }

  function renderDetail() {
    const name = state.current, r = state.results[name], asset = assetBy(name);
    if (!r) {
      $('d-status').innerHTML = '<span class="err">' + esc(state.errors[name] || 'Sem dados') + '</span>';
      MA.chart.destroy();
      ['c-setup', 'c-ai', 'c-trend', 'c-calc'].forEach((id) => { $(id).innerHTML = ''; });
      return;
    }
    const d = r.digits, b = r.best;
    $('d-status').innerHTML = badge(r.status) + ' <span class="muted">score ' + r.score + ' · ' + fmt(r.price, d) + ' · ' + esc(r.session.label) + '</span>';
    document.querySelectorAll('#tf-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tf === state.tf));
    const plan = state.userPlan ? state.userPlan.plan : b && b.status !== 'SEM SETUP' ? b.plan : null;
    MA.chart.render(r, state.tf, plan, { zones: $('opt-zones').checked, levels: $('opt-levels').checked, ema: $('opt-ema').checked });

    // card setup
    if (b) {
      const p = b.plan, pips = (x) => fmt(Math.abs(x - p.entry) / asset.pip, 1);
      $('c-setup').innerHTML = '<h2>' + esc(b.name) + ' — <span class="' + (b.dir === 'compra' ? 'up' : 'down') + '">' + b.dir + '</span> ' + badge(b.status) + '</h2>' +
        '<p class="muted">' + (b.triggered ? 'Gatilho confirmado agora (entrada a mercado).' : 'Aguardando: entrada sugerida na área (ordem limite / alerta de preço).') + '</p>' +
        '<table><tr><th></th><th>Preço</th><th class="num">pips</th><th class="num">R:R</th></tr>' +
        '<tr><td>Entrada</td><td>' + fmt(p.entry, d) + '</td><td></td><td></td></tr>' +
        '<tr><td class="down">SL</td><td>' + fmt(p.sl, d) + '</td><td class="num">' + pips(p.sl) + '</td><td class="num">−1</td></tr>' +
        '<tr><td class="up">TP1</td><td>' + fmt(p.tp1, d) + '</td><td class="num">' + pips(p.tp1) + '</td><td class="num">1.0</td></tr>' +
        '<tr><td class="up">TP2</td><td>' + fmt(p.tp2, d) + '</td><td class="num">' + pips(p.tp2) + '</td><td class="num">' + fmt(p.rr.tp2, 2) + '</td></tr>' +
        '<tr><td class="up">TP3 ★</td><td>' + fmt(p.tp3, d) + '</td><td class="num">' + pips(p.tp3) + '</td><td class="num">' + fmt(p.rr.tp3, 2) + '</td></tr></table>' +
        '<p class="muted">★ Saída sugerida pelo backtest: <b>TP3</b> com o stop original (deixar o lucro correr). TP1/TP2 são só referência.</p>' +
        (asset.proxy
          ? '<p class="muted"><b>Lote:</b> não calculado — dados do ' + esc(asset.proxy) + '. Use os níveis como referência de estrutura.</p>'
          : '<p><b>Lote:</b> ' + fmt(b.size.lots, 2) + ' (risco US$ ' + fmt(b.size.riskUsd, 0) + ' = ' + state.settings.riskPct + '% de US$ ' + state.settings.accountSize + ')</p>') +
        '<h3>Score ' + b.score + '/100</h3><div class="kv">' + Object.entries(b.breakdown).map(([k, v]) => '<span>' + (LABELS[k] || k) + '</span><span>' + v + ' / ' + MAXP[k] + '</span>').join('') + '</div>' +
        '<h3>Confirmações</h3><ul class="tight">' + b.confirmations.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        (b.warnings.length ? '<h3>Atenção</h3><ul class="tight">' + b.warnings.map((x) => '<li class="down">' + esc(x) + '</li>').join('') + '</ul>' : '') +
        (r.candidates.length > 1 ? '<h3>Outros setups</h3><ul class="tight">' + r.candidates.slice(1).map((c) => '<li>' + esc(c.name) + ' — ' + c.dir + ' · score ' + c.score + ' · ' + c.status + '</li>').join('') + '</ul>' : '');
    } else {
      $('c-setup').innerHTML = '<h2>Sem setup</h2><p class="muted">Nenhuma área de pullback ou rompimento relevante perto do preço. Use a calculadora abaixo se tiver uma entrada própria.</p>';
    }

    // card tendência / níveis
    $('c-trend').innerHTML = '<h2>Tendência e níveis</h2><table><tr><th>TF</th><th>Viés</th><th>Estrutura</th><th class="num">ADX</th><th class="num">RSI</th></tr>' +
      ['D1', 'H4', 'H1', 'M15'].map((k) => '<tr><td>' + k + '</td><td>' + arrow(r.bias[k].dir) + ' ' + r.bias[k].dir + '</td><td>' + r.bias[k].structure + '</td><td class="num">' + fmt(r.bias[k].adx, 0) +
        '</td><td class="num">' + fmt(MA.an.lastValid(r.tf[k].ind.rsi), 0) + '</td></tr>').join('') + '</table>' +
      '<h3>Máx/mín</h3><div class="kv"><span>Dia anterior</span><span>' + fmt(r.period.pdh, d) + ' / ' + fmt(r.period.pdl, d) + '</span>' +
      '<span>Semana anterior</span><span>' + fmt(r.period.pwh, d) + ' / ' + fmt(r.period.pwl, d) + '</span>' +
      '<span>ATR H1 / M15</span><span>' + fmt(r.atr.H1, d) + ' / ' + fmt(r.atr.M15, d) + '</span>' +
      '<span>Divergência RSI</span><span>H1: ' + (r.divergence.H1 || '—') + ' · H4: ' + (r.divergence.H4 || '—') + '</span></div>' +
      '<h3>Zonas H1</h3><ul class="tight">' + (r.tf.H1.zones.length ? r.tf.H1.zones.map((z) => '<li class="' + (z.type === 'demanda' ? 'up' : 'down') + '">' + z.type + ' ' + fmt(z.low, d) + ' – ' + fmt(z.high, d) + ' <span class="muted">(' + z.tests + ' teste(s))</span></li>').join('') : '<li class="muted">nenhuma ativa</li>') + '</ul>';

    renderAI();
    renderCalc();
  }

  function renderAI() {
    const name = state.current, out = state.ai[name];
    let html = '<h2>Leitura da IA</h2>';
    if (!out) html += '<p class="muted">A IA comenta os números calculados acima (não cria preços).</p><button id="btn-ai" class="primary">Analisar com IA</button>';
    else if (out.loading) html += '<p class="muted">Consultando o Gemini…</p>';
    else if (out.error) html += '<p class="err">' + esc(out.error) + '</p><button id="btn-ai">Tentar de novo</button>';
    else {
      const q = Math.max(0, Math.min(5, out.qualidade | 0));
      html += '<div class="ai-out"><p><span class="stars">' + '★'.repeat(q) + '☆'.repeat(5 - q) + '</span> · confirma setup: <b>' + esc(out.confirma_setup) + '</b></p>' +
        '<p>' + esc(out.resumo) + '</p><h3>O que esperar</h3><p>' + esc(out.o_que_esperar) + '</p>' +
        (Array.isArray(out.riscos) && out.riscos.length ? '<h3>Riscos</h3><ul class="tight">' + out.riscos.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
        (out._modelo ? '<p class="muted" style="font-size:12px">Modelo: ' + esc(out._modelo) + '</p>' : '') + '</div>';
    }
    $('c-ai').innerHTML = html;
  }

  async function runAI() {
    const name = state.current, r = state.results[name];
    if (!r) return;
    state.ai[name] = { loading: true }; renderAI();
    try { state.ai[name] = await MA.ai.analyze(r, state.settings); }
    catch (e) { state.ai[name] = { error: e.message }; }
    if (state.current === name) renderAI();
  }

  function renderCalc() {
    const r = state.results[state.current], up = state.userPlan, d = r.digits, asset = assetBy(state.current);
    let html = '<h2>SL/TP para minha entrada</h2><div class="calc-form">' +
      '<label>Direção<select id="calc-dir"><option value="compra">Compra</option><option value="venda">Venda</option></select></label>' +
      '<label>Entrada<input id="calc-entry" type="number" step="any" value="' + fmt(up ? up.plan.entry : r.price, d) + '"></label>' +
      '<button id="btn-calc" class="primary">Calcular</button></div>';
    if (up) {
      const p = up.plan;
      html += '<table style="margin-top:10px"><tr><td class="down">SL</td><td>' + fmt(p.sl, d) + '</td><td class="up">TP1</td><td>' + fmt(p.tp1, d) + '</td></tr>' +
        '<tr><td class="up">TP2</td><td>' + fmt(p.tp2, d) + ' (' + fmt(p.rr.tp2, 2) + 'R)</td><td class="up">TP3</td><td>' + fmt(p.tp3, d) + ' (' + fmt(p.rr.tp3, 2) + 'R)</td></tr></table>' +
        '<p><b>Lote:</b> ' + (asset.proxy ? '— (ETF)' : fmt(up.size.lots, 2)) + ' · SL ' + fmt(up.size.pips, 1) + ' pips · invalidação: ' + (up.invalidation != null ? 'swing H1 em ' + fmt(up.invalidation, d) : 'nenhum swing — SL mínimo') + '</p>' +
        (p.notes.length ? '<ul class="tight">' + p.notes.map((x) => '<li class="muted">' + esc(x) + '</li>').join('') + '</ul>' : '') +
        '<button id="btn-calc-clear">Voltar ao plano do setup</button>';
    }
    $('c-calc').innerHTML = html;
    if (up) $('calc-dir').value = up.plan.dir;
  }

  // ---------------- configurações ----------------
  function renderConfig() {
    const s = state.settings;
    for (const k of ['tdKey', 'geminiKey', 'geminiModel', 'ntfyTopic', 'accountSize', 'riskPct']) $('s-' + k).value = s[k] == null ? '' : s[k];
    $('assets-table').innerHTML = '<div class="assets-grid"><span></span><span class="muted">Ativo</span><span class="muted">Símbolo Twelve Data</span><span class="muted">USD/pip/lote</span>' +
      s.assets.map((a, i) => '<input type="checkbox" data-i="' + i + '" data-k="enabled"' + (a.enabled ? ' checked' : '') + '><span>' + a.name + '</span>' +
        '<input data-i="' + i + '" data-k="td" value="' + esc(a.td) + '"><input data-i="' + i + '" data-k="pipValue" type="number" step="any" value="' + a.pipValue + '">').join('') + '</div>';
  }

  function saveConfig() {
    const s = state.settings;
    s.tdKey = $('s-tdKey').value.trim(); s.geminiKey = $('s-geminiKey').value.trim();
    s.geminiModel = $('s-geminiModel').value.trim() || MA.DEFAULT_SETTINGS.geminiModel;
    s.ntfyTopic = $('s-ntfyTopic').value.trim();
    s.accountSize = +$('s-accountSize').value || 0; s.riskPct = +$('s-riskPct').value || 0;
    document.querySelectorAll('#assets-table [data-i]').forEach((el) => {
      const a = s.assets[+el.dataset.i], k = el.dataset.k;
      a[k] = k === 'enabled' ? el.checked : k === 'pipValue' ? +el.value : el.value.trim();
    });
    const ok = MA.settings.save(s);
    $('save-status').textContent = ok ? 'Salvo.' : 'Não foi possível salvar neste navegador (armazenamento bloqueado).';
    // reanalisa o que já está em cache com os novos parâmetros
    state.results = {}; state.ai = {};
    loadFromCache().then(renderList);
  }

  async function loadFromCache() {
    for (const a of enabled()) await analyze(a, { cacheOnly: true });
  }

  // ---------------- login / cofre ----------------
  let afterLogin = null;
  function openConfig() {
    if (MA.auth.hasVault() && !MA.auth.isAdmin()) return openLogin('config');
    renderConfig(); show('config');
  }
  function openLogin(target) {
    afterLogin = target;
    $('login-err').textContent = '';
    $('l-pass').value = '';
    $('l-remember').checked = MA.auth.remember();
    $('login').classList.remove('hidden');
    $('l-user').focus();
  }
  function closeLogin() { $('login').classList.add('hidden'); }
  async function doLogin() {
    const btn = $('l-go');
    btn.disabled = true; $('login-err').textContent = ''; $('login-msg').textContent = 'Verificando…';
    const data = await MA.auth.decrypt(MA.VAULT, $('l-user').value, $('l-pass').value);
    $('login-msg').textContent = 'Desbloqueia as chaves salvas e as configurações.';
    btn.disabled = false;
    if (!data) { $('login-err').textContent = 'Usuário ou senha incorretos.'; $('l-pass').value = ''; $('l-pass').focus(); return; }
    MA.auth.setRemember($('l-remember').checked);
    MA.auth.setAdmin(true);
    state.settings.tdKey = data.tdKey || state.settings.tdKey;
    state.settings.geminiKey = data.geminiKey || state.settings.geminiKey;
    MA.settings.save(state.settings);
    closeLogin();
    if (afterLogin === 'config') { renderConfig(); show('config'); } else renderList();
  }
  function logout() {
    state.settings.tdKey = ''; state.settings.geminiKey = '';
    MA.auth.setAdmin(false);
    MA.settings.save(state.settings);
    MA.data.clearCache(); state.results = {}; state.ai = {};
    show('painel'); renderList(); setStatus('Chaves removidas deste aparelho.');
  }

  // ---------------- eventos ----------------
  function bind() {
    document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => (b.dataset.view === 'config' ? openConfig() : show(b.dataset.view))));
    $('btn-scan').addEventListener('click', scanAll);
    $('btn-rank').addEventListener('click', rankAI);
    $('list').addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) openAsset(row.dataset.asset); });
    $('setup-hint').addEventListener('click', (e) => {
      if (e.target.id === 'go-config') { e.preventDefault(); openConfig(); }
      if (e.target.id === 'go-login') { e.preventDefault(); openLogin(null); }
    });
    $('login-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
    $('l-cancel').addEventListener('click', closeLogin);
    $('btn-logout').addEventListener('click', logout);
    $('btn-back').addEventListener('click', () => { show('painel'); renderList(); });
    $('btn-refresh').addEventListener('click', async () => {
      $('btn-refresh').disabled = true;
      await analyze(assetBy(state.current), { force: true });
      delete state.ai[state.current];
      $('btn-refresh').disabled = false; renderDetail();
    });
    $('tf-tabs').addEventListener('click', (e) => { const tf = e.target.dataset && e.target.dataset.tf; if (tf) { state.tf = tf; renderDetail(); } });
    ['opt-zones', 'opt-levels', 'opt-ema'].forEach((id) => $(id).addEventListener('change', renderDetail));
    $('c-ai').addEventListener('click', (e) => { if (e.target.id === 'btn-ai') runAI(); });
    $('c-calc').addEventListener('click', (e) => {
      if (e.target.id === 'btn-calc') {
        const entry = parseFloat($('calc-entry').value);
        if (!Number.isFinite(entry)) return;
        state.userPlan = MA.setups.planForEntry(state.results[state.current], assetBy(state.current), state.settings, $('calc-dir').value, entry);
        renderDetail();
      } else if (e.target.id === 'btn-calc-clear') { state.userPlan = null; renderDetail(); }
    });
    $('btn-save').addEventListener('click', saveConfig);
    $('btn-ntfy-test').addEventListener('click', async () => {
      state.settings.ntfyTopic = $('s-ntfyTopic').value.trim();
      if (!state.settings.ntfyTopic) { $('ntfy-status').textContent = 'Informe o tópico.'; return; }
      $('ntfy-status').textContent = 'Enviando…';
      try { $('ntfy-status').textContent = (await sendNtfy('Teste do Analisador', 'Se você recebeu isto, os alertas estão funcionando.', 3)) ? 'Enviado. Confira o celular.' : 'Falhou.'; }
      catch (e) { $('ntfy-status').textContent = 'Falhou: ' + e.message; }
    });
    $('btn-clear').addEventListener('click', () => { MA.data.clearCache(); state.results = {}; state.ai = {}; renderList(); $('save-status').textContent = 'Cache limpo.'; });
  }

  async function init() {
    bind();
    renderList();
    if (!window.LightweightCharts) setStatus('Biblioteca de gráficos não carregou (sem internet?).');
    await loadFromCache();
    renderList();
    const n = Object.keys(state.results).length;
    if (n) setStatus('Mostrando última análise salva (' + n + ' ativos). Clique em "Varrer todos" para atualizar.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(globalThis.MA = globalThis.MA || {});
