/* Leitura da IA (Gemini) na nuvem: GEMINI_KEY=... node scripts/ia.js <pasta-dados> rank|ATIVO
   Usa as velas salvas pela última varredura e grava em ia.json, que o site lê em qualquer aparelho. */
'use strict';
const fs = require('fs');
const path = require('path');
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups', 'ai']) require('../js/' + f + '.js');
const MA = globalThis.MA;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

async function runIA({ dir, alvo, key, now = Math.floor(Date.now() / 1000) }) {
  if (!key) throw new Error('Falta o secret GEMINI_KEY no GitHub.');
  const scan = readJson(path.join(dir, 'scan.json'), null);
  if (!scan) throw new Error('Ainda não há varredura salva.');
  const settings = Object.assign(structuredClone(MA.DEFAULT_SETTINGS), { asiaSignals: true, geminiKey: key });
  const analisa = (name) => {
    const v = readJson(path.join(dir, 'velas', name + '.json'), null);
    if (!v) throw new Error('Sem velas salvas para ' + name);
    const un = (a) => a.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    const data = { M15: un(v.M15), H1: un(v.H1), D1: un(v.D1) };
    data.H4 = MA.data.resample(data.H1, MA.data.TF_SEC.H4, MA.data.TF_SEC.H1, scan.t);
    return MA.setups.analyzeAsset(MA.DEFAULT_ASSETS.find((a) => a.name === name), data, settings, scan.t);
  };
  const file = path.join(dir, 'ia.json'), ia = readJson(file, {}), hoje = new Date(now * 1000).toISOString().slice(0, 10);
  let out;
  if (alvo === 'rank') {
    const rs = [];
    for (const a of scan.assets) if (a.score >= settings.score.watchMin) { try { rs.push(analisa(a.name)); } catch (e) { /* sem velas */ } }
    out = await MA.ai.rank(rs, settings);
  } else out = await MA.ai.analyze(analisa(alvo), settings);
  const item = { t: now, scan: scan.t, out };
  if (alvo === 'rank') ia.rank = item; else ia.ativos = Object.assign({}, ia.ativos, { [alvo]: item });
  ia.uso = { dia: hoje, n: (ia.uso && ia.uso.dia === hoje ? ia.uso.n : 0) + 1 };
  fs.writeFileSync(file, JSON.stringify(ia));
  return ia;
}

module.exports = { runIA };

if (require.main === module) {
  runIA({ dir: process.argv[2], alvo: process.argv[3], key: (process.env.GEMINI_KEY || '').trim() })
    .catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
}
