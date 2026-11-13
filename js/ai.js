/* Camada de leitura por IA (Google Gemini, free tier). A IA recebe SOMENTE os números já calculados
   e nunca cria preços: entrada/SL/TP vêm do motor determinístico. */
(function (MA) {
  'use strict';
  const CACHE = 'ma.ai.';

  const round = (x, d) => (x == null || Number.isNaN(x) ? null : +x.toFixed(d));

  /* JSON compacto enviado à IA. */
  function payload(r) {
    const d = r.digits, b = r.best;
    const lv = (arr) => arr.map((l) => ({ preco: round(l.price, d), toques: l.touches, tipo: l.kind === 'S' ? 'suporte' : 'resistencia' }));
    const zn = (arr) => arr.map((z) => ({ tipo: z.type, de: round(z.low, d), ate: round(z.high, d), testes: z.tests }));
    return {
      ativo: r.asset,
      preco_atual: round(r.price, d),
      horario_utc: new Date(r.updated * 1000).toISOString(),
      sessao: r.session.label,
      tendencia: Object.fromEntries(Object.entries(r.bias).map(([k, v]) => [k, { vies: v.dir, estrutura: v.structure, adx: round(v.adx, 1) }])),
      rsi: { H1: round(r.rsi.H1, 1), M15: round(r.rsi.M15, 1) },
      atr: { H1: round(r.atr.H1, d), M15: round(r.atr.M15, d) },
      divergencia_rsi: r.divergence,
      maxmin: Object.fromEntries(Object.entries(r.period).map(([k, v]) => [k, round(v, d)])),
      niveis_H1: lv(r.tf.H1.levels), zonas_H1: zn(r.tf.H1.zones), niveis_H4: lv(r.tf.H4.levels),
      setup: b ? {
        nome: b.name, direcao: b.dir, status: b.status, score: b.score, componentes_score: b.breakdown,
        gatilho_confirmado: b.triggered, distancia_da_area_em_ATR: round(b.area.distAtr, 2),
        entrada: round(b.plan.entry, d), sl: round(b.plan.sl, d), tp1: round(b.plan.tp1, d), tp2: round(b.plan.tp2, d), tp3: round(b.plan.tp3, d),
        rr: { tp2: round(b.plan.rr.tp2, 2), tp3: round(b.plan.rr.tp3, 2) },
        confirmacoes: b.confirmations, alertas: b.warnings,
      } : null,
    };
  }

  const RULES = [
    'Você é um analista técnico que explica a leitura de um motor de análise para um trader de day trade.',
    'Responda em português do Brasil, linguagem simples e direta.',
    'Use SOMENTE os números fornecidos no JSON. NÃO crie preços, níveis, entradas, SL ou TP novos.',
    'Se faltar informação, diga que falta. Não invente notícias; apenas lembre de checar o calendário econômico se relevante.',
    'Isto é apoio ao estudo, não recomendação de investimento.',
  ].join('\n');

  function assetPrompt(p) {
    return RULES + '\n\nDevolva APENAS um JSON com o formato:\n' +
      '{"resumo": string (3-5 frases), "qualidade": inteiro 1-5, "riscos": [string], "o_que_esperar": string, "confirma_setup": "sim"|"nao"|"aguardar"}\n\n' +
      'Dados do ativo:\n' + JSON.stringify(p);
  }

  function rankingPrompt(list) {
    return RULES + '\n\nCompare os ativos abaixo e ordene as melhores oportunidades. Devolva APENAS um JSON:\n' +
      '{"ranking": [{"ativo": string, "posicao": inteiro, "motivo": string (1 frase)}], "comentario_geral": string}\n\n' +
      'Ativos:\n' + JSON.stringify(list);
  }

  async function hash(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf).slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const FALLBACK_MODEL = 'gemini-flash-lite-latest';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // sobrecarga temporária do modelo (503/429/"high demand"): vale tentar de novo ou usar outro modelo
  const isBusy = (status, msg) => status === 503 || status === 429 || /high demand|overloaded|unavailable/i.test(msg || '');

  async function request(model, prompt, apiKey) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
    let res;
    try {
      res = await fetch(url, {
      signal: ctrl.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
      });
    } catch (e) {
      const err = new Error('Gemini (' + model + '): sem resposta em 25s.');
      err.busy = true; throw err;
    } finally { clearTimeout(timer); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && json.error.message) || 'HTTP ' + res.status;
      const err = new Error('Gemini (' + model + '): ' + msg);
      err.busy = isBusy(res.status, msg);
      throw err;
    }
    const text = (((json.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text.replace(/^```json\s*|```\s*$/g, '')); } catch (e) { throw new Error('Gemini devolveu resposta fora do formato JSON.'); }
  }

  async function call(prompt, settings) {
    if (!settings.geminiKey) throw new Error('Configure a chave do Gemini em Configurações.');
    const key = CACHE + (await hash(prompt));
    try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) { /* sem cache */ }
    const main = settings.geminiModel || FALLBACK_MODEL;
    const attempts = [[main, 0], [main, 2500]];
    if (main !== FALLBACK_MODEL) attempts.push([FALLBACK_MODEL, 0], [FALLBACK_MODEL, 4000]);
    let out, lastErr;
    for (const [model, wait] of attempts) {
      if (wait) await sleep(wait);
      try { out = await request(model, prompt, settings.geminiKey); out._modelo = model; break; }
      catch (e) { lastErr = e; if (!e.busy) throw e; }
    }
    if (!out) throw new Error(lastErr.message + ' Tente de novo em alguns minutos.');
    try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) { /* cota cheia */ }
    return out;
  }

  const analyze = (result, settings) => call(assetPrompt(payload(result)), settings);

  function rank(results, settings) {
    const list = results.filter((r) => r.score >= settings.score.watchMin).map((r) => {
      const p = payload(r);
      return { ativo: p.ativo, tendencia: p.tendencia, setup: p.setup };
    });
    if (!list.length) return Promise.resolve({ ranking: [], comentario_geral: 'Nenhum ativo com score ≥ ' + settings.score.watchMin + ' para ranquear.' });
    return call(rankingPrompt(list), settings);
  }

  MA.ai = { payload, analyze, rank, assetPrompt };
})(globalThis.MA = globalThis.MA || {});
