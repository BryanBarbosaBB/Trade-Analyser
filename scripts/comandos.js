/* Pedidos feitos pelos botões do site ("Varrer agora" e IA), sem nenhuma chave no navegador.
   O site publica um texto curto num tópico público do ntfy; a rodada da corrente, que fica esperando o próximo horário,
   escuta esse tópico e executa o pedido com as chaves guardadas nos secrets do GitHub.
   Uso no workflow: node scripts/comandos.js <pasta-dados> <segundos>

   O tópico é público (está no código do site). Por isso só três pedidos são aceitos, nada do texto chega ao shell,
   e há limites: a cota da Twelve Data fica reservada para a varredura automática e a IA tem um teto por dia. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { slotsRestantes, slotsPassados } = require('./agenda.js');
globalThis.MA = globalThis.MA || {};
if (!globalThis.MA.DEFAULT_ASSETS) require('../js/config.js');

const PEDIDOS = 'trade-analyser-pedidos-k7q2xw', STATUS = 'trade-analyser-status-k7q2xw'; // iguais em js/app.js
const COTA = 790, POR_SLOT = 17, POR_MANUAL = 30; // consultas da Twelve Data
const IA_DIA = 40, VELHO = 900, INTERVALO = 60;   // IA por dia; pedido com mais de 15 min é ignorado; 1 varredura manual por minuto
const dia = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Texto do pedido -> {tipo:'varrer'} | {tipo:'ia', alvo:'rank'|ATIVO} | null */
function parsePedido(txt) {
  const s = String(txt == null ? '' : txt).trim();
  if (s === 'varrer') return { tipo: 'varrer' };
  if (s === 'ia') return { tipo: 'ia', alvo: 'rank' };
  const m = /^ia:([A-Z0-9]{3,10})$/.exec(s);
  return m && globalThis.MA.DEFAULT_ASSETS.some((a) => a.enabled && a.name === m[1]) ? { tipo: 'ia', alvo: m[1] } : null;
}

/* Consultas já gastas hoje (dia UTC, quando a cota da Twelve Data zera). */
function gastoHoje(scan, now) {
  if (scan.uso && scan.uso.dia) return scan.uso.dia === dia(now) ? scan.uso.n : 0;
  return slotsPassados(now) * POR_SLOT; // dados de antes do contador existir
}

/* Decide o que fazer com um pedido: {acao:'executa'|'pronto'|'nega'|'ignora', txt}. */
function decide(p, msgTime, now, scan, ia) {
  if (!p || now - msgTime > VELHO) return { acao: 'ignora' };
  if (p.tipo === 'varrer') {
    if (scan.t >= msgTime || now - (scan.t || 0) < INTERVALO) return { acao: 'pronto', txt: 'A nuvem acabou de varrer.' };
    if (gastoHoje(scan, now) + POR_MANUAL + slotsRestantes(now) * POR_SLOT > COTA)
      return { acao: 'nega', txt: 'Sem cota sobrando hoje na Twelve Data: o resto está reservado para a varredura automática. Zera às 21:00.' };
    return { acao: 'executa' };
  }
  const feito = p.alvo === 'rank' ? ia.rank : (ia.ativos || {})[p.alvo];
  if (feito && feito.t >= msgTime) return { acao: 'pronto', txt: 'A leitura da IA já está pronta.' };
  if (ia.uso && ia.uso.dia === dia(now) && ia.uso.n >= IA_DIA) return { acao: 'nega', txt: 'Limite de ' + IA_DIA + ' leituras da IA por dia atingido.' };
  return { acao: 'executa' };
}

function roda(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (c) => { clearTimeout(t); if (c === 0) resolve(); else reject(new Error((err.trim().split('\n').pop() || 'falhou').replace(/^ERRO: /, '').slice(0, 200))); });
  });
}

/* O tópico de status é público: nenhum segredo pode sair numa mensagem de erro (o git, por exemplo, mostra a URL com o token). */
function limpa(txt, env = process.env) {
  let s = String(txt || '');
  for (const k of ['TD_KEY', 'GEMINI_KEY', 'GH_TOKEN', 'NTFY_TOPIC']) { const v = (env[k] || '').trim(); if (v) s = s.split(v).join('***'); }
  return s.replace(/x-access-token:[^@\s]*/g, '***').replace(/https?:\/\/\S+/g, '(link)').slice(0, 200);
}

async function avisa(fetchFn, id, st, txt) {
  try { await fetchFn('https://ntfy.sh/' + STATUS, { method: 'POST', body: JSON.stringify({ id, st, txt: limpa(txt) }) }); } catch (e) { /* o site desiste sozinho */ }
}

/* Executa um pedido. deps = {baixa, salva, varre, ia} (trocáveis nos testes). */
async function atende(msg, { dir, now, fetchFn, deps, log = console.log }) {
  const p = parsePedido(msg.message);
  if (!p || now() - msg.time > VELHO) return 'ignora';
  const ler = () => [readJson(path.join(dir, 'scan.json'), {}), readJson(path.join(dir, 'ia.json'), {})];
  const d = decide(p, msg.time, now(), ...ler());
  log('Pedido', msg.message, '->', d.acao, d.txt || '');
  if (d.acao === 'pronto') { await avisa(fetchFn, msg.id, 'pronto', d.txt); return d.acao; }
  if (d.acao === 'nega') { await avisa(fetchFn, msg.id, 'negado', d.txt); return d.acao; }
  await avisa(fetchFn, msg.id, 'recebido');
  try {
    await deps.baixa(); // pega o que outra rodada possa ter salvo
    if (p.tipo === 'varrer') await deps.varre(); else await deps.ia(p.alvo);
    await deps.salva();
    await avisa(fetchFn, msg.id, 'pronto');
  } catch (e) {
    log('  ERRO', e.message);
    await avisa(fetchFn, msg.id, 'erro', e.message);
  }
  return d.acao;
}

/* Escuta o tópico até o prazo, atendendo um pedido por vez. */
async function escuta({ dir, segundos, fetchFn = fetch, deps, log = console.log }) {
  const fim = Date.now() + segundos * 1000, vistos = new Set();
  let since = Math.floor(Date.now() / 1000) - VELHO;
  while (Date.now() < fim) {
    const ctrl = new AbortController();
    let vivo;
    const marca = () => { clearTimeout(vivo); vivo = setTimeout(() => ctrl.abort(), Math.max(0, Math.min(120000, fim - Date.now()))); };
    try {
      marca(); // o ntfy manda um sinal de vida a cada 45 s
      const res = await fetchFn('https://ntfy.sh/' + PEDIDOS + '/json?since=' + since, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const dec = new TextDecoder();
      let buf = '';
      for await (const pedaco of res.body) {
        marca();
        buf += dec.decode(pedaco, { stream: true });
        const linhas = buf.split('\n'); buf = linhas.pop().slice(-20000);
        for (const l of linhas) {
          let m; try { m = JSON.parse(l); } catch (e) { continue; }
          if (!m || m.event !== 'message' || vistos.has(m.id) || Date.now() >= fim) continue;
          vistos.add(m.id); since = Math.max(since, m.time);
          clearTimeout(vivo);
          await atende(m, { dir, now: () => Math.floor(Date.now() / 1000), fetchFn, deps, log });
          marca();
        }
      }
    } catch (e) { if (Date.now() < fim && !ctrl.signal.aborted) log('ntfy:', e.message); } finally { clearTimeout(vivo); }
    if (Date.now() < fim) await sleep(Math.min(10000, fim - Date.now()));
  }
}

module.exports = { limpa, parsePedido, decide, atende, escuta, gastoHoje, PEDIDOS, STATUS, IA_DIA, COTA };

if (require.main === module) {
  const [dir, seg] = process.argv.slice(2), aqui = (f) => path.join(__dirname, f);
  const deps = {
    baixa: () => roda('bash', [aqui('dados.sh'), 'baixa', dir], 120000),
    salva: () => roda('bash', [aqui('dados.sh'), 'salva', dir], 120000),
    varre: () => roda(process.execPath, [aqui('scan.js'), dir], 12 * 60000),
    ia: (alvo) => roda(process.execPath, [aqui('ia.js'), dir, alvo], 3 * 60000),
  };
  escuta({ dir, segundos: +seg || 0, deps }).then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
