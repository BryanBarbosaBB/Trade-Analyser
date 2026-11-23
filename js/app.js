/* Interface: painel e detalhe do ativo. Sem login e sem chaves.
   A varredura roda sozinha no GitHub Actions a cada 30 min (scripts/scan.js) e salva no ramo `dados`.
   O site só lê esses dados, então PC e celular mostram exatamente o mesmo resultado. */
(function (MA) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const REPO = 'BryanBarbosaBB/Trade-Analyser', BRANCH = 'dados';
  const RELOAD_MS = 5 * 60 * 1000;
  const SCHEDULE = 'automática a cada 30 min, das 08:00 às 03:00 de Brasília, de domingo à noite até sexta';

  const settings = structuredClone(MA.DEFAULT_SETTINGS);
  settings.asiaSignals = true; // igual à varredura (scripts/scan.js)
  const state = { scan: null, ref: BRANCH, full: {}, errors: {}, current: null, tf: 'M15', userPlan: null, loading: false };
  const assetBy = (name) => settings.assets.find((a) => a.name === name);
  const fmt = (x, d) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
  const arrow = (dir) => dir === 'alta' ? '<span class="up" title="alta">▲</span>' : dir === 'baixa' ? '<span class="down" title="baixa">▼</span>' : '<span class="neutral" title="neutro">▬</span>';
  const badge = (st) => '<span class="badge b-' + (st === 'SEM SETUP' ? 'SEM' : st) + '">' + esc(st) + '</span>';
  const when = (sec) => new Date(sec * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const LABELS = { alinhamento: 'Alinhamento D1/H4', zona: 'Qualidade da zona/nível', momento: 'Momento (RSI/MACD)', rr: 'R:R até nível contrário', volatilidade: 'Volatilidade (ATR)', sessao: 'Sessão' };
  const MAXP = { alinhamento: 30, zona: 20, momento: 15, rr: 15, volatilidade: 10, sessao: 10 };

  /* Versões antigas guardavam chaves e cache no navegador: apaga tudo. */
  function forgetOldStorage() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('ma.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem('ma.admin'); } catch (e) { /* ignore */ }
  }

  // ---------------- dados salvos (ramo `dados` no GitHub) ----------------
  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /* Fixa o commit atual do ramo para que resumo e velas venham da mesma varredura. */
  async function latestRef() {
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/commits/' + BRANCH, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store' });
      if (res.ok) { const sha = (await res.text()).trim(); if (/^[0-9a-f]{40}$/.test(sha)) return sha; }
    } catch (e) { /* limite da API: usa o nome do ramo (cache de até 5 min) */ }
    return BRANCH;
  }
  // teste local: ?dados=pasta lê os arquivos dessa pasta em vez do GitHub
  const LOCAL = new URLSearchParams(location.search).get('dados');
  const rawUrl = (ref, file) => (LOCAL ? LOCAL.replace(/\/$/, '') + '/' : 'https://raw.githubusercontent.com/' + REPO + '/' + ref + '/') + file;

  async function load() {
    if (state.loading) return;
    state.loading = true; $('btn-reload').disabled = true;
    setStatus('Carregando a última varredura…');
    try {
      const ref = LOCAL ? 'local' : await latestRef();
      const scan = await getJson(rawUrl(ref, 'scan.json'));
      if (!state.scan || scan.t !== state.scan.t) { state.full = {}; state.errors = {}; }
      state.scan = scan; state.ref = ref;
      renderList(); renderHistory(); statusLine();
      if (state.current && !$('v-detalhe').classList.contains('hidden')) await openAsset(state.current, true);
    } catch (e) {
      setStatus(state.scan ? 'Não foi possível atualizar (' + e.message + '). Mostrando os dados anteriores.' : '');
      if (!state.scan) {
        $('setup-hint').classList.remove('hidden');
        $('setup-hint').innerHTML = 'Ainda não há varredura salva (' + esc(e.message) + '). A primeira roda sozinha no próximo horário (' + SCHEDULE + ').';
      }
    }
    state.loading = false; $('btn-reload').disabled = false;
  }

  function setStatus(t) { $('scan-status').textContent = t; }

  function statusLine() {
    const s = state.scan;
    if (!s) return;
    const ago = Math.round((Date.now() / 1000 - s.t) / 60);
    const agoTxt = ago < 1 ? 'agora' : ago < 120 ? 'há ' + ago + ' min' : 'há ' + Math.round(ago / 60) + ' h';
    const n = Object.keys(s.errors || {}).length;
    setStatus('Última varredura: ' + when(s.t) + ' (' + agoTxt + ')' + (n ? ' · ' + n + ' com erro' : '') +
      ' · ' + SCHEDULE);
    $('setup-hint').classList.add('hidden');
  }

  // ---------------- painel ----------------
  function renderList() {
    const s = state.scan, errs = (s && s.errors) || {};
    const rows = ((s && s.assets) || []).slice().sort((x, y) => y.score - x.score);
    $('list').innerHTML = rows.map((r) => {
      const b = r.best, e = errs[r.name];
      const setup = b ? esc(b.name) + ' — <b class="' + (b.dir === 'compra' ? 'up' : 'down') + '">' + b.dir + '</b><small>' +
        (b.triggered ? 'Gatilho confirmado' : 'Área a ' + fmt(b.distAtr, 1) + ' ATR(H1)') + '</small>' : '<span class="muted">Nenhum setup</span>';
      return '<div class="row" data-asset="' + esc(r.name) + '">' +
        '<div class="c-name"><div class="name">' + esc(r.name) + '</div><div class="price">' + fmt(r.price, r.digits) + (r.proxy ? ' · ' + esc(r.td) : '') + '</div></div>' +
        '<div class="c-arrows arrows">' + ['D1', 'H4', 'H1', 'M15'].map((k) => arrow(r.bias[k])).join('') + '</div>' +
        '<div class="c-setup setup-txt">' + setup + (e ? '<small class="err">' + esc(e) + '</small>' : '') + '</div>' +
        '<div class="c-score score">' + r.score + '<span class="bar"><i style="width:' + r.score + '%"></i></span></div>' +
        '<div class="c-status">' + badge(r.status) + (b && b.asia ? ' <small class="warn-txt">Ásia</small>' : '') + '</div>' +
        '<div class="c-time time">' + MA.chart.fmtTime(r.updated + MA.data.TF_SEC.M15) + (r.stale ? ' <span class="err">(antigo)</span>' : '') + '</div></div>';
    }).join('');
  }

  function renderHistory() {
    const h = (state.scan && state.scan.history) || [];
    $('history').innerHTML = '<h2>Sinais de ENTRADA (histórico)</h2>' + (h.length
      ? '<div class="hist-wrap"><table><tr><th>Quando</th><th>Ativo</th><th>Direção</th><th>Setup</th><th class="num">Score</th><th>Entrada</th><th>SL</th><th>TP1</th><th>TP3</th></tr>' +
        h.map((x) => '<tr class="hist-row" data-asset="' + esc(x.asset) + '"><td>' + when(x.t) + '</td><td><b>' + esc(x.asset) + '</b>' + (x.asia ? ' <small class="warn-txt">Ásia</small>' : '') + '</td><td class="' + (x.dir === 'compra' ? 'up' : 'down') + '">' + esc(x.dir) +
          '</td><td>' + esc(x.setup) + '</td><td class="num">' + x.score + '</td><td>' + fmt(x.entry, x.digits) + '</td><td class="down">' + fmt(x.sl, x.digits) +
          '</td><td class="up">' + fmt(x.tp1, x.digits) + '</td><td class="up">' + fmt(x.tp3, x.digits) + '</td></tr>').join('') + '</table></div>' +
        '<p class="muted">Cada sinal gera uma notificação no celular (app ntfy). O mesmo ativo/setup/direção só avisa de novo depois de 4 h. Sinais marcados <span class="warn-txt">Ásia</span> (noite) <b>não foram validados</b> no backtest: perderam no treino (−0,20R por trade).</p>'
      : '<p class="muted">Nenhum sinal de ENTRADA ainda. Quando aparecer, ele fica guardado aqui e chega no celular.</p>');
  }

  // ---------------- detalhe ----------------
  function show(view) {
    for (const v of ['painel', 'detalhe']) $('v-' + v).classList.toggle('hidden', v !== view);
    if (view !== 'detalhe') MA.chart.destroy();
    window.scrollTo(0, 0);
  }

  /* Refaz a análise com as mesmas velas e o mesmo horário da varredura: resultado idêntico ao salvo. */
  async function fullResult(name) {
    if (state.full[name]) return state.full[name];
    const v = await getJson(rawUrl(state.ref, 'velas/' + encodeURIComponent(name) + '.json'));
    const un = (a) => a.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    const now = state.scan.t;
    const data = { M15: un(v.M15), H1: un(v.H1), D1: un(v.D1) };
    data.H4 = MA.data.resample(data.H1, MA.data.TF_SEC.H4, MA.data.TF_SEC.H1, now);
    const r = MA.setups.analyzeAsset(assetBy(name), data, settings, now);
    state.full[name] = r;
    return r;
  }

  async function openAsset(name, keepView) {
    if (!assetBy(name)) return;
    state.current = name;
    if (!keepView) { state.userPlan = null; show('detalhe'); }
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    $('d-title').textContent = name;
    if (!state.scan) { $('d-status').innerHTML = '<span class="muted">Carregando…</span>'; return; }
    if (!state.full[name]) $('d-status').innerHTML = '<span class="muted">Carregando…</span>';
    try { await fullResult(name); delete state.errors[name]; } catch (e) { state.errors[name] = 'Sem velas salvas para ' + name + ' (' + e.message + ')'; }
    if (state.current === name) renderDetail();
  }

  function back() {
    state.current = null;
    history.replaceState(null, '', location.pathname + location.search);
    show('painel'); renderList();
  }

  function renderDetail() {
    const name = state.current, r = state.full[name], asset = assetBy(name);
    if (!r) {
      $('d-status').innerHTML = '<span class="err">' + esc(state.errors[name] || 'Sem dados') + '</span>';
      MA.chart.destroy();
      ['c-setup', 'c-trend', 'c-calc'].forEach((id) => { $(id).innerHTML = ''; });
      return;
    }
    const d = r.digits, b = r.best;
    $('d-status').innerHTML = badge(r.status) + ' <span class="muted">score ' + r.score + ' · ' + fmt(r.price, d) + ' · ' + esc(r.session.label) + ' · varredura ' + when(state.scan.t) + '</span>';
    document.querySelectorAll('#tf-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tf === state.tf));
    const plan = state.userPlan ? state.userPlan.plan : b && b.status !== 'SEM SETUP' ? b.plan : null;
    MA.chart.render(r, state.tf, plan, { zones: $('opt-zones').checked, levels: $('opt-levels').checked, ema: $('opt-ema').checked });

    if (b) {
      const p = b.plan, pips = (x) => fmt(Math.abs(x - p.entry) / asset.pip, 1);
      $('c-setup').innerHTML = '<h2>' + esc(b.name) + ' — <span class="' + (b.dir === 'compra' ? 'up' : 'down') + '">' + b.dir + '</span> ' + badge(b.status) + '</h2>' +
        '<p class="muted">' + (b.triggered ? 'Gatilho confirmado na varredura (entrada a mercado).' : 'Aguardando: entrada sugerida na área (ordem limite / alerta de preço).') + '</p>' +
        '<table><tr><th></th><th>Preço</th><th class="num">pips</th><th class="num">R:R</th></tr>' +
        '<tr><td>Entrada</td><td>' + fmt(p.entry, d) + '</td><td></td><td></td></tr>' +
        '<tr><td class="down">SL</td><td>' + fmt(p.sl, d) + '</td><td class="num">' + pips(p.sl) + '</td><td class="num">−1</td></tr>' +
        '<tr><td class="up">TP1</td><td>' + fmt(p.tp1, d) + '</td><td class="num">' + pips(p.tp1) + '</td><td class="num">1.0</td></tr>' +
        '<tr><td class="up">TP2</td><td>' + fmt(p.tp2, d) + '</td><td class="num">' + pips(p.tp2) + '</td><td class="num">' + fmt(p.rr.tp2, 2) + '</td></tr>' +
        '<tr><td class="up">TP3 ★</td><td>' + fmt(p.tp3, d) + '</td><td class="num">' + pips(p.tp3) + '</td><td class="num">' + fmt(p.rr.tp3, 2) + '</td></tr></table>' +
        '<p class="muted">★ Saída sugerida pelo backtest: <b>TP3</b> com o stop original (deixar o lucro correr). TP1/TP2 são só referência.</p>' +
        (asset.proxy
          ? '<p class="muted"><b>Lote:</b> não calculado — dados do ' + esc(asset.proxy) + '. Use os níveis como referência de estrutura.</p>'
          : '<p><b>Lote:</b> ' + fmt(b.size.lots, 2) + ' (risco US$ ' + fmt(b.size.riskUsd, 0) + ' = ' + settings.riskPct + '% de US$ ' + settings.accountSize + ')</p>') +
        '<h3>Score ' + b.score + '/100</h3><div class="kv">' + Object.entries(b.breakdown).map(([k, v]) => '<span>' + (LABELS[k] || k) + '</span><span>' + v + ' / ' + MAXP[k] + '</span>').join('') + '</div>' +
        '<h3>Confirmações</h3><ul class="tight">' + b.confirmations.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        (b.warnings.length ? '<h3>Atenção</h3><ul class="tight">' + b.warnings.map((x) => '<li class="down">' + esc(x) + '</li>').join('') + '</ul>' : '') +
        (r.candidates.length > 1 ? '<h3>Outros setups</h3><ul class="tight">' + r.candidates.slice(1).map((c) => '<li>' + esc(c.name) + ' — ' + c.dir + ' · score ' + c.score + ' · ' + c.status + '</li>').join('') + '</ul>' : '');
    } else {
      $('c-setup').innerHTML = '<h2>Sem setup</h2><p class="muted">Nenhuma área de pullback ou rompimento relevante perto do preço. Use a calculadora abaixo se tiver uma entrada própria.</p>';
    }

    $('c-trend').innerHTML = '<h2>Tendência e níveis</h2><table><tr><th>TF</th><th>Viés</th><th>Estrutura</th><th class="num">ADX</th><th class="num">RSI</th></tr>' +
      ['D1', 'H4', 'H1', 'M15'].map((k) => '<tr><td>' + k + '</td><td>' + arrow(r.bias[k].dir) + ' ' + r.bias[k].dir + '</td><td>' + r.bias[k].structure + '</td><td class="num">' + fmt(r.bias[k].adx, 0) +
        '</td><td class="num">' + fmt(MA.an.lastValid(r.tf[k].ind.rsi), 0) + '</td></tr>').join('') + '</table>' +
      '<h3>Máx/mín</h3><div class="kv"><span>Dia anterior</span><span>' + fmt(r.period.pdh, d) + ' / ' + fmt(r.period.pdl, d) + '</span>' +
      '<span>Semana anterior</span><span>' + fmt(r.period.pwh, d) + ' / ' + fmt(r.period.pwl, d) + '</span>' +
      '<span>ATR H1 / M15</span><span>' + fmt(r.atr.H1, d) + ' / ' + fmt(r.atr.M15, d) + '</span>' +
      '<span>Divergência RSI</span><span>H1: ' + (r.divergence.H1 || '—') + ' · H4: ' + (r.divergence.H4 || '—') + '</span></div>' +
      '<h3>Zonas H1</h3><ul class="tight">' + (r.tf.H1.zones.length ? r.tf.H1.zones.map((z) => '<li class="' + (z.type === 'demanda' ? 'up' : 'down') + '">' + z.type + ' ' + fmt(z.low, d) + ' – ' + fmt(z.high, d) + ' <span class="muted">(' + z.tests + ' teste(s))</span></li>').join('') : '<li class="muted">nenhuma ativa</li>') + '</ul>';

    renderCalc();
  }

  function renderCalc() {
    const r = state.full[state.current], up = state.userPlan, d = r.digits, asset = assetBy(state.current);
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

  // ---------------- eventos ----------------
  function bind() {
    $('btn-reload').addEventListener('click', load);
    $('list').addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) openAsset(row.dataset.asset); });
    $('history').addEventListener('click', (e) => { const row = e.target.closest('.hist-row'); if (row) openAsset(row.dataset.asset); });
    $('btn-back').addEventListener('click', back);
    $('tf-tabs').addEventListener('click', (e) => { const tf = e.target.dataset && e.target.dataset.tf; if (tf && state.full[state.current]) { state.tf = tf; renderDetail(); } });
    ['opt-zones', 'opt-levels', 'opt-ema'].forEach((id) => $(id).addEventListener('change', () => { if (state.full[state.current]) renderDetail(); }));
    $('c-calc').addEventListener('click', (e) => {
      if (e.target.id === 'btn-calc') {
        const entry = parseFloat($('calc-entry').value);
        if (!Number.isFinite(entry)) return;
        state.userPlan = MA.setups.planForEntry(state.full[state.current], assetBy(state.current), settings, $('calc-dir').value, entry);
        renderDetail();
      } else if (e.target.id === 'btn-calc-clear') { state.userPlan = null; renderDetail(); }
    });
    // celular: ao voltar para a aba, busca a varredura mais nova
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.scan && Date.now() / 1000 - state.scan.t > 25 * 60) load(); });
    setInterval(() => { if (!document.hidden) load(); }, RELOAD_MS);
    setInterval(statusLine, 60000);
  }

  async function init() {
    forgetOldStorage();
    bind();
    if (!window.LightweightCharts) setStatus('Biblioteca de gráficos não carregou (sem internet?).');
    const target = decodeURIComponent(location.hash.slice(1));
    if (assetBy(target)) { state.current = target; show('detalhe'); $('d-title').textContent = target; }
    await load();
    if (state.current) await openAsset(state.current, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(globalThis.MA = globalThis.MA || {});
