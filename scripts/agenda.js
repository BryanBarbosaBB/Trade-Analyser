/* Horários da varredura e a "corrente" que garante que ela rode (o cron do GitHub atrasa e pula horários).
   Cada rodada da corrente: varre se o horário atual ainda não foi varrido, espera o próximo horário e dispara a próxima.

   Horários (UTC; Brasília = UTC−3), a cada 30 min:
     seg–sex 11:00–20:30  = 08:00–17:30 Brasília (Londres/NY)
     dom–qui 21:00–23:30  = 18:00–20:30 Brasília
     seg–sex 00:00–05:30 e 06:00 = 21:00–03:00 Brasília (Ásia)

   Uso no workflow:
     node scripts/agenda.js deve-varrer <pasta-dados>   -> "varrer=true|false"
     node scripts/agenda.js espera                      -> segundos até a próxima rodada */
'use strict';
const fs = require('fs');
const path = require('path');

const SLOT = 1800;          // 30 min
const ATRASO = 90;          // dispara 90 s depois do horário, com a vela de 15 min já fechada na Twelve Data
const SALTO_MAX = 5.5 * 3600; // a espera máxima por rodada (o GitHub encerra jobs com 6 h)

function isSlot(t) {
  if (t % SLOT !== 0) return false;
  const d = new Date(t * 1000), dow = d.getUTCDay(), h = d.getUTCHours(), m = d.getUTCMinutes();
  const util = dow >= 1 && dow <= 5;
  if (util && h >= 11 && h <= 20) return true;
  if (dow <= 4 && h >= 21) return true;
  if (util && h <= 5) return true;
  return util && h === 6 && m === 0;
}

/* Varre se o horário mais recente (até 30 min atrás) é de varredura e ainda não foi varrido. */
function deveVarrer(now, ultima) {
  const s = Math.floor(now / SLOT) * SLOT;
  return isSlot(s) && !(ultima >= s);
}

/* Segundos até a próxima rodada: o próximo horário + 90 s, ou um "salto" de 5h30 se ele estiver longe
   (madrugada e fim de semana; a rodada do salto não varre, só espera de novo). */
function espera(now) {
  for (let s = Math.floor(now / SLOT) * SLOT; s + ATRASO - now <= SALTO_MAX; s += SLOT) {
    if (isSlot(s) && s + ATRASO - now > 60) return s + ATRASO - now;
  }
  return SALTO_MAX;
}

/* Horários de varredura que ainda faltam / já passaram no dia UTC (quando a cota da Twelve Data zera). */
const slotsDoDia = (now) => { const d0 = Math.floor(now / 86400) * 86400, out = []; for (let s = d0; s < d0 + 86400; s += SLOT) if (isSlot(s)) out.push(s); return out; };
const slotsRestantes = (now) => slotsDoDia(now).filter((s) => s > now).length;
const slotsPassados = (now) => slotsDoDia(now).filter((s) => s <= now).length;

module.exports = { slotsRestantes, slotsPassados, isSlot, deveVarrer, espera, SLOT, ATRASO };

if (require.main === module) {
  const now = Math.floor(Date.now() / 1000);
  const [cmd, dir] = process.argv.slice(2);
  if (cmd === 'deve-varrer') {
    let ultima = 0;
    try { ultima = JSON.parse(fs.readFileSync(path.join(dir || 'dados', 'scan.json'), 'utf8')).t || 0; } catch (e) {}
    console.log('varrer=' + deveVarrer(now, ultima));
  } else if (cmd === 'espera') {
    console.log(Math.round(espera(now)));
  } else {
    console.error('uso: agenda.js deve-varrer <pasta> | espera');
    process.exit(2);
  }
}
