/* Interface: painel e detalhe do ativo. Sem login.
   A varredura roda sozinha no GitHub Actions a cada 30 min (scripts/scan.js) e salva no ramo `dados`.
   O site lê esses dados, então PC e celular mostram o mesmo resultado.
   "Varrer agora" e a IA pedem à nuvem para rodar na hora: nenhuma chave fica no site, e o resultado vale para todos os aparelhos. */
(function (MA) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const REPO = 'BryanBarbosaBB/Trade-Analyser', BRANCH = 'dados';
  const RELOAD_MS = 5 * 60 * 1000;
  const SCHEDULE = 'automática a cada 30 min, das 08:00 às 03:00 de Brasília, de domingo à noite até sexta';

  const settings = structuredClone(MA.DEFAULT_SETTINGS);
  settings.asiaSignals = true; // igual à varredura (scripts/scan.js)
  const state = { scan: null, ref: BRANCH, full: {}, errors: {}, current: null, tf: 'M15', userPlan: null, loading: false,
    note: '', scanning: false, ia: null, aiBusy: {}, aiErr: {}, showRank: false };
  const assetBy = (name) => settings.assets.find((a) => a.name === name);
  const fmt = (x, d) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
  const arrow = (dir) => dir === 'alta' ? '<span class="up" title="alta">▲</span>' : dir === 'baixa' ? '<span class="down" title="baixa">▼</span>' : '<span class="neutral" title="neutro">▬</span>';
  const badge = (st) => '<span class="badge b-' + (st === 'SEM SETUP' ? 'SEM' : st) + '">' + esc(st) + '</span>';
  const when = (sec) => new Date(sec * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const LABELS = { alinhamento: 'Alinhamento D1/H4', zona: 'Qualidade da zona/nível', momento: 'Momento (RSI/MACD)', rr: 'R:R até nível contrário', volatilidade: 'Volatilidade (ATR)', sessao: 'Sessão' };
  const MAXP = { alinhamento: 30, zona: 20, momento: 15, rr: 15, volatilidade: 10, sessao: 10 };

  /* Versões antigas guardavam chaves e cache no navegador: apaga tudo. */
  function forgetOldStorage() {
    try { ['td', 'gemini'].forEach((k) => localStorage.removeItem('analisador.' + k)); } catch (e) { /* ignore */ }
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

  /* id = pedido que a nuvem acabou de atender: ela guarda uma cópia em p/<id>/, um endereço nunca visto, sem cache nem limite da API. */
  async function load(quiet, id) {
    if (state.loading) return;
    state.loading = true; $('btn-reload').disabled = true;
    if (quiet !== true) setStatus('Carregando a última varredura…');
    try {
      let ref = LOCAL ? 'local' : null, scan = null;
      if (id && !LOCAL) {
        try { scan = await getJson(rawUrl(BRANCH + '/p/' + id, 'scan.json')); ref = BRANCH + '/p/' + id; } catch (e) { /* cai no caminho normal */ }
      }
      if (!scan) { ref = ref || await latestRef(); scan = await getJson(rawUrl(ref, 'scan.json')); }
      // cache atrasado do GitHub: nunca troca por uma varredura mais velha que a da tela
      if (state.scan && scan.t < state.scan.t) { state.loading = false; $('btn-reload').disabled = false; statusLine(); return; }
      if (!state.scan || scan.t !== state.scan.t) {
        state.full = {}; state.errors = {}; if (!state.scanning) state.note = '';
      }
      state.scan = scan; state.ref = ref;
      try { state.ia = novaIA(state.ia, await getJson(rawUrl(ref, 'ia.json'))); } catch (e) { /* ainda sem leitura da IA */ }
      renderList(); renderHistory(); statusLine(); renderRank();
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

  // ---------------- pedidos à nuvem (botões) ----------------
  /* O botão publica um pedido curto num tópico do ntfy; a rodada do GitHub Actions que está sempre esperando executa com as
     chaves guardadas lá (scripts/comandos.js) e salva no ramo `dados`. O site não tem nenhuma chave. */
  const PEDIDOS = 'trade-analyser-pedidos-k7q2xw', STATUS = 'trade-analyser-status-k7q2xw'; // iguais em scripts/comandos.js
  const DESISTE_MS = 12 * 60 * 1000;

  /* Envia o pedido e espera a nuvem terminar. progress(texto) mostra o andamento. Devolve {txt, id} ou lança erro. */
  function pedir(texto, progress) {
    return new Promise((resolve, reject) => {
      const desde = Math.floor(Date.now() / 1000) - 5, fila = [];
      let id = null, timers = [];
      const es = new EventSource('https://ntfy.sh/' + STATUS + '/sse?since=' + desde);
      const fim = (fn, v) => { es.close(); timers.forEach(clearTimeout); fn(v); };
      const ver = (m) => {
        if (id == null) { fila.push(m); return; }
        if (!m || m.id !== id) return;
        if (m.st === 'recebido') { timers.forEach(clearTimeout); timers = [timers[0]]; progress('A nuvem está executando…'); }
        else if (m.st === 'pronto') fim(resolve, { txt: m.txt || '', id: /^[A-Za-z0-9]{1,20}$/.test(id) ? id : null });
        else if (m.st === 'negado' || m.st === 'erro') fim(reject, new Error(m.txt || 'falhou'));
      };
      es.onmessage = (e) => { try { ver(JSON.parse(JSON.parse(e.data).message)); } catch (x) { /* mensagem de outro formato */ } };
      timers.push(setTimeout(() => fim(reject, new Error('A nuvem não respondeu. Confira em GitHub → Actions se a Varredura está em andamento.')), DESISTE_MS));
      timers.push(setTimeout(() => progress('Pedido na fila: a nuvem está ocupada ou trocando de rodada, começa em até 5 min…'), 25000));
      progress('Pedido enviado…');
      fetch('https://ntfy.sh/' + PEDIDOS, { method: 'POST', body: texto })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((r) => { id = r.id; fila.forEach(ver); })
        .catch((e) => fim(reject, new Error('Não consegui enviar o pedido (' + e.message + ').')));
    });
  }

  /* Recarrega até aparecer o resultado novo (o GitHub pode demorar a servir o commit novo). */
  async function recarrega(pronto, id) {
    for (let i = 0; i < 20; i++) {
      await load(true, i < 3 ? id : null);
      if (pronto()) return true;
      await new Promise((r) => setTimeout(r, i < 3 ? 4000 : 20000));
    }
    return false;
  }

  async function scanNow() {
    if (state.scanning) return;
    const antes = state.scan ? state.scan.t : 0;
    state.scanning = true; scanButtons();
    const show = (t) => { state.note = t; statusLine(); };
    try {
      const { txt, id } = await pedir('varrer', (t) => show('Varredura: ' + t + (t.includes('executando') ? ' (leva de 1 a 4 min)' : '')));
      if (txt) { await load(true); show(txt); }
      else {
        show('Varredura pronta, carregando…');
        const ok = await recarrega(() => state.scan && state.scan.t > antes, id);
        const entr = ok ? state.scan.assets.filter((a) => a.status === 'ENTRADA').map((a) => a.name) : [];
        const ses = MA.an.sessions();
        show(!ok ? 'A varredura terminou, mas o GitHub ainda não entregou os dados novos. Clique em Atualizar em alguns minutos.'
          : 'Varredura feita agora: ' + (entr.length ? 'ENTRADA em ' + entr.join(', ') : 'nenhuma ENTRADA') +
          (ses.good || ses.active.includes('Ásia') ? '' : ' · ' + ses.label.toLowerCase() + ': neste horário nunca sai ENTRADA'));
      }
    } catch (e) { show(e.message); }
    state.scanning = false; scanButtons();
  }

  function scanButtons() {
    $('btn-scan').disabled = state.scanning;
    $('btn-scan').textContent = state.scanning ? 'Varrendo…' : 'Varrer agora';
  }

  // ---------------- IA (Gemini, roda na nuvem; resultado em ia.json) ----------------
  /* Junta as leituras da IA ficando com a mais nova de cada uma (o cache do GitHub pode entregar um arquivo antigo). */
  function novaIA(a, b) {
    if (!a || !b) return b || a;
    const maior = (x, y) => (!x || (y && y.t >= x.t) ? y || x : x), at = { ...a.ativos, ...b.ativos };
    for (const k in at) at[k] = maior((a.ativos || {})[k], (b.ativos || {})[k]);
    return { ...b, rank: maior(a.rank, b.rank), ativos: at };
  }
  const iaDe = (alvo) => (state.ia ? (alvo === 'rank' ? state.ia.rank : (state.ia.ativos || {})[alvo]) : null);
  const iaQuando = (x) => '<p class="muted">Feita às ' + when(x.t) + ' sobre a varredura de ' + when(x.scan) +
    (state.scan && x.scan < state.scan.t ? ' <span class="warn-txt">(já há varredura mais nova)</span>' : '') + '</p>';

  async function pedirIA(alvo) {
    if (state.aiBusy[alvo]) return;
    const antes = (iaDe(alvo) || {}).t || 0;
    const show = (t) => { state.aiBusy[alvo] = t; renderIA(alvo); };
    delete state.aiErr[alvo];
    try {
      const { txt, id } = await pedir(alvo === 'rank' ? 'ia' : 'ia:' + alvo, (t) => show('IA: ' + t));
      show('IA: resposta pronta, carregando…');
      if (txt) await load(true);
      else if (!(await recarrega(() => ((iaDe(alvo) || {}).t || 0) > antes, id))) throw new Error('A IA respondeu, mas o GitHub ainda não entregou. Clique em Atualizar em alguns minutos.');
    } catch (e) { state.aiErr[alvo] = e.message; }
    delete state.aiBusy[alvo];
    renderIA(alvo);
  }

  function renderIA(alvo) {
    if (alvo === 'rank') renderRank();
    else if (state.current === alvo && state.full[alvo]) renderAI();
  }

  function renderRank() {
    const box = $('rank-box'), x = iaDe('rank'), busy = state.aiBusy.rank, err = state.aiErr.rank;
    $('btn-rank').disabled = !!busy;
    box.classList.toggle('hidden', !state.showRank);
    if (!state.showRank) return;
    const o = (x && x.out) || {};
    box.innerHTML = '<h2>Ranking da IA</h2>' + (busy ? '<p class="muted">' + esc(busy) + '</p>' : '') + (err ? '<p class="err">' + esc(err) + '</p>' : '') +
      (x ? (Array.isArray(o.ranking) && o.ranking.length ? '<ol class="tight">' + o.ranking.map((r) => '<li><b>' + esc(r.ativo) + '</b> — ' + esc(r.motivo) + '</li>').join('') + '</ol>' : '') +
        '<p>' + esc(o.comentario_geral || '') + '</p>' + iaQuando(x) : '') +
      '<p class="muted">A IA só comenta os números do motor. Ela não cria ENTRADA nem muda a regra.</p>';
  }

  function renderAI() {
    const alvo = state.current, x = iaDe(alvo), busy = state.aiBusy[alvo], err = state.aiErr[alvo];
    let html = '<h2>Leitura da IA</h2>' + (err ? '<p class="err">' + esc(err) + '</p>' : '');
    if (x) {
      const out = x.out || {}, q = Math.max(0, Math.min(5, out.qualidade | 0));
      html += '<div class="ai-out"><p><span class="stars">' + '★'.repeat(q) + '☆'.repeat(5 - q) + '</span> · confirma setup: <b>' + esc(out.confirma_setup) + '</b></p>' +
        '<p>' + esc(out.resumo) + '</p><h3>O que esperar</h3><p>' + esc(out.o_que_esperar) + '</p>' +
        (Array.isArray(out.riscos) && out.riscos.length ? '<h3>Riscos</h3><ul class="tight">' + out.riscos.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '') + iaQuando(x) + '</div>';
    } else if (!busy) html += '<p class="muted">A IA comenta os números calculados (não cria preços nem ENTRADA).</p>';
    html += busy ? '<p class="muted">' + esc(busy) + '</p>' : '<button id="btn-ai" class="primary">' + (x ? 'Analisar de novo' : 'Analisar com IA') + '</button>';
    $('c-ai').innerHTML = html;
  }

  function rowsNow() { return ((state.scan && state.scan.assets) || []).slice().sort((x, y) => y.score - x.score); }

  function setStatus(t) { $('scan-status').textContent = t; }

  function statusLine() {
    const s = state.scan;
    if (!s) { if (state.note) setStatus(state.note); return; }
    const ago = Math.round((Date.now() / 1000 - s.t) / 60);
    const agoTxt = ago < 1 ? 'agora' : ago < 120 ? 'há ' + ago + ' min' : 'há ' + Math.round(ago / 60) + ' h';
    const n = Object.keys(s.errors || {}).length;
    setStatus((state.note ? state.note + ' — ' : '') + 'Última varredura: ' + when(s.t) + ' (' + agoTxt + ')' + (n ? ' · ' + n + ' com erro' : '') +
      ' · ' + SCHEDULE);
    $('setup-hint').classList.add('hidden');
  }

  // ---------------- painel ----------------
  function renderList() {
    const s = state.scan, errs = (s && s.errors) || {};
    const rows = rowsNow();
    $('list').innerHTML = rows.map((r) => {
      const b = r.best, e = errs[r.name];
      const setup = b ? esc(b.name) + ' — <b class="' + (b.dir === 'compra' ? 'up' : 'down') + '">' + b.dir + '</b><small>' +
        (b.status !== 'ENTRADA' && b.missing && b.missing.length ? '<b class="no-entry">NÃO ENTRAR.</b> <b>Falta:</b> ' + b.missing.map(esc).join(' · ') + ' · <b>preço atual ' + fmt(r.price, r.digits) + '</b>'
          : b.triggered ? 'Gatilho confirmado' : 'Área a ' + fmt(b.distAtr, 1) + ' ATR(H1)') + '</small>' : '<span class="muted">Nenhum setup</span>';
      return '<div class="row" data-asset="' + esc(r.name) + '">' +
        '<div class="c-name"><div class="name">' + esc(r.name) + '</div><div class="price">' + fmt(r.price, r.digits) + (r.proxy ? ' <small title="' + esc(proxyInfo(r.name)) + '">' + (fatorDe(r.name) ? 'estimado' : esc(r.td)) + '</small>' : '') + '</div></div>' +
        '<div class="c-arrows arrows">' + ['D1', 'H4', 'H1', 'M15'].map((k) => arrow(r.bias[k])).join('') + '</div>' +
        '<div class="c-setup setup-txt">' + setup + (e ? '<small class="err">' + esc(e) + '</small>' : '') + '</div>' +
        '<div class="c-score score">' + r.score + '<span class="bar"><i style="width:' + r.score + '%"></i></span></div>' +
        '<div class="c-status">' + badge(r.status) + (b && b.asia ? ' <small class="warn-txt">Ásia</small>' : '') + '</div>' +
        '<div class="c-time time">' + MA.chart.fmtTime(r.updated + MA.data.TF_SEC.M15) + (r.stale ? ' <span class="err">(antigo)</span>' : '') + '</div></div>';
    }).join('');
  }

  const fatorDe = (name) => (state.scan && state.scan.fator && state.scan.fator[name]) || null;
  /* Explica o preço do NAS100/US30: vem do ETF convertido para a escala do índice. */
  function proxyInfo(name) {
    const a = assetBy(name), f = fatorDe(name);
    if (!f) return 'Preço do ' + a.proxy + ', não do índice.';
    return 'Índice estimado: ' + a.td + ' × ' + f.k.toFixed(2) + (f.fech ? ' (proporção do fechamento de ' + f.fech.split('-').reverse().slice(0, 2).join('/') + ')' : '') +
      '. Pode diferir alguns pontos da corretora. Fora do pregão americano (por volta de 11:30–18:00 de Brasília) o ' + a.td + ' não negocia e o preço fica parado.';
  }

  function renderHistory() {
    const h = (state.scan && state.scan.history) || [];
    $('history').innerHTML = '<h2>Sinais de ENTRADA (histórico)</h2>' + (h.length
      ? '<div class="hist-wrap"><table><tr><th>Quando</th><th>Ativo</th><th>Direção</th><th>Setup</th><th class="num">Score</th><th>Entrada</th><th>SL</th><th>TP1</th><th>TP3</th></tr>' +
        h.map((x) => '<tr class="hist-row" data-asset="' + esc(x.asset) + '"><td>' + when(x.t) + '</td><td><b>' + esc(x.asset) + '</b>' + (x.asia ? ' <small class="warn-txt">Ásia</small>' : '') + '</td><td class="' + (x.dir === 'compra' ? 'up' : 'down') + '">' + esc(x.dir) +
          '</td><td>' + esc(x.setup) + '</td><td class="num">' + x.score + '</td><td>' + fmt(x.entry, x.digits) + '</td><td class="down">' + fmt(x.sl, x.digits) +
          '</td><td class="up">' + fmt(x.tp1, x.digits) + '</td><td class="up">' + fmt(x.tp3, x.digits) + '</td></tr>').join('') + '</table></div>' +
        '<p class="muted">Cada sinal gera uma notificação no celular (app ntfy). O mesmo ativo/setup/direção não repete enquanto o sinal continua ativo; se ele sumir e voltar, avisa de novo. Sinais marcados <span class="warn-txt">Ásia</span> (noite) <b>não foram validados</b> no backtest: perderam no treino (−0,20R por trade).</p>'
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
    // NAS100/US30: mesma conversão ETF -> índice da varredura (varredura antiga, sem proporção salva, fica no ETF)
    const f = state.scan.fator, conv = f && MA.data.toIndex ? MA.data.toIndex(assetBy(name), data, (f[name] || {}).k) : { asset: assetBy(name), data, k: 1 };
    const r = MA.setups.analyzeAsset(conv.asset, conv.data, settings, now);
    r.conv = conv.asset; r.k = conv.k;
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
    const name = state.current, r = state.full[name], asset = (r && r.conv) || assetBy(name), un = asset.proxy ? 'pontos' : 'pips';
    if (!r) {
      $('d-status').innerHTML = '<span class="err">' + esc(state.errors[name] || 'Sem dados') + '</span>';
      MA.chart.destroy();
      ['c-setup', 'c-ai', 'c-trend', 'c-calc'].forEach((id) => { $(id).innerHTML = ''; });
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
        '<p class="muted">' + (b.triggered ? 'Gatilho confirmado na varredura (entrada a mercado).' : 'Ainda sem gatilho: não é sinal. Plano abaixo só para acompanhar (no backtest, ordem limite na área sem esperar o gatilho não deu lucro).') + '</p>' +
        (b.missing.length ? '<div class="missing"><b class="no-entry">NÃO ENTRAR AINDA</b> · preço atual ' + fmt(r.price, d) + '<br><b>Falta para ENTRADA:</b><ul class="tight">' + b.missing.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
          (b.triggered ? '' : '<small>O score ' + b.score + ' supõe a entrada em ' + fmt(p.entry, d) + ', não no preço atual.</small>') + '</div>' : '') +
        '<table><tr><th></th><th>Preço</th><th class="num">' + un + '</th><th class="num">R:R</th></tr>' +
        '<tr><td>Entrada</td><td>' + fmt(p.entry, d) + '</td><td></td><td></td></tr>' +
        '<tr><td class="down">SL</td><td>' + fmt(p.sl, d) + '</td><td class="num">' + pips(p.sl) + '</td><td class="num">−1</td></tr>' +
        '<tr><td class="up">TP1</td><td>' + fmt(p.tp1, d) + '</td><td class="num">' + pips(p.tp1) + '</td><td class="num">1.0</td></tr>' +
        '<tr><td class="up">TP2</td><td>' + fmt(p.tp2, d) + '</td><td class="num">' + pips(p.tp2) + '</td><td class="num">' + fmt(p.rr.tp2, 2) + '</td></tr>' +
        '<tr><td class="up">TP3 ★</td><td>' + fmt(p.tp3, d) + '</td><td class="num">' + pips(p.tp3) + '</td><td class="num">' + fmt(p.rr.tp3, 2) + '</td></tr></table>' +
        '<p class="muted">★ Saída sugerida pelo backtest: <b>TP3</b> com o stop original (deixar o lucro correr). TP1/TP2 são só referência.</p>' +
        (asset.proxy
          ? '<p class="muted"><b>Lote:</b> não calculado (depende do contrato da corretora). ' + esc(proxyInfo(name)) + '</p>'
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

    renderAI();
    renderCalc();
  }

  function renderCalc() {
    const r = state.full[state.current], up = state.userPlan, d = r.digits, asset = r.conv || assetBy(state.current);
    let html = '<h2>SL/TP para minha entrada</h2><div class="calc-form">' +
      '<label>Direção<select id="calc-dir"><option value="compra">Compra</option><option value="venda">Venda</option></select></label>' +
      '<label>Entrada<input id="calc-entry" type="number" step="any" value="' + fmt(up ? up.plan.entry : r.price, d) + '"></label>' +
      '<button id="btn-calc" class="primary">Calcular</button></div>';
    if (up) {
      const p = up.plan;
      html += '<table style="margin-top:10px"><tr><td class="down">SL</td><td>' + fmt(p.sl, d) + '</td><td class="up">TP1</td><td>' + fmt(p.tp1, d) + '</td></tr>' +
        '<tr><td class="up">TP2</td><td>' + fmt(p.tp2, d) + ' (' + fmt(p.rr.tp2, 2) + 'R)</td><td class="up">TP3</td><td>' + fmt(p.tp3, d) + ' (' + fmt(p.rr.tp3, 2) + 'R)</td></tr></table>' +
        '<p><b>Lote:</b> ' + (asset.proxy ? '—' : fmt(up.size.lots, 2)) + ' · SL ' + fmt(up.size.pips, 1) + (asset.proxy ? ' pontos' : ' pips') + ' · invalidação: ' + (up.invalidation != null ? 'swing H1 em ' + fmt(up.invalidation, d) : 'nenhum swing — SL mínimo') + '</p>' +
        (p.notes.length ? '<ul class="tight">' + p.notes.map((x) => '<li class="muted">' + esc(x) + '</li>').join('') + '</ul>' : '') +
        '<button id="btn-calc-clear">Voltar ao plano do setup</button>';
    }
    $('c-calc').innerHTML = html;
    if (up) $('calc-dir').value = up.plan.dir;
  }

  // ---------------- eventos ----------------
  function bind() {
    $('btn-reload').addEventListener('click', load);
    $('btn-scan').addEventListener('click', scanNow);
    $('btn-rank').addEventListener('click', () => { state.showRank = true; pedirIA('rank'); });
    $('c-ai').addEventListener('click', (e) => { if (e.target.id === 'btn-ai') pedirIA(state.current); });
    $('list').addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) openAsset(row.dataset.asset); });
    $('history').addEventListener('click', (e) => { const row = e.target.closest('.hist-row'); if (row) openAsset(row.dataset.asset); });
    $('btn-back').addEventListener('click', back);
    $('tf-tabs').addEventListener('click', (e) => { const tf = e.target.dataset && e.target.dataset.tf; if (tf && state.full[state.current]) { state.tf = tf; renderDetail(); } });
    ['opt-zones', 'opt-levels', 'opt-ema'].forEach((id) => $(id).addEventListener('change', () => { if (state.full[state.current]) renderDetail(); }));
    $('c-calc').addEventListener('click', (e) => {
      if (e.target.id === 'btn-calc') {
        const entry = parseFloat($('calc-entry').value);
        if (!Number.isFinite(entry)) return;
        const r = state.full[state.current];
        state.userPlan = MA.setups.planForEntry(r, r.conv || assetBy(state.current), settings, $('calc-dir').value, entry);
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
