/* Cria js/vault.js com as chaves criptografadas.
   Rode no SEU terminal (as respostas não saem do seu PC):  node scripts/make-vault.js
   Depois: git add js/vault.js && git commit -m "Atualiza cofre" && git push */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('../js/auth.js');
const MA = globalThis.MA;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
  console.log('Criação do cofre de chaves do Analisador de Mercado\n');
  const user = await ask('Usuário: ');
  const pass = await ask('Senha (mínimo 12 caracteres, misture letras, números e símbolos): ');
  if (pass.length < 12) {
    console.error('\nSenha curta demais. O arquivo do cofre é público e senhas fracas são quebradas em segundos. Nada foi gravado.');
    process.exit(1);
  }
  const again = await ask('Repita a senha: ');
  if (again !== pass) { console.error('\nAs senhas não conferem. Nada foi gravado.'); process.exit(1); }
  const tdKey = await ask('Chave do Twelve Data: ');
  const geminiKey = await ask('Chave do Gemini: ');
  rl.close();
  if (!user || !tdKey || !geminiKey) { console.error('\nUsuário e chaves são obrigatórios. Nada foi gravado.'); process.exit(1); }

  console.log('\nCriptografando (alguns segundos)...');
  const vault = await MA.auth.encrypt({ tdKey, geminiKey }, user, pass);
  const ok = await MA.auth.decrypt(vault, user, pass);
  if (!ok || ok.tdKey !== tdKey) { console.error('Falha ao validar o cofre.'); process.exit(1); }
  const out = '/* Gerado por scripts/make-vault.js — chaves criptografadas (AES-256-GCM). */\n' +
    '(function (MA) { MA.VAULT = ' + JSON.stringify(vault) + '; })(globalThis.MA = globalThis.MA || {});\n';
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'vault.js'), out);
  console.log('Pronto: js/vault.js gravado. Agora rode:\n  git add js/vault.js\n  git commit -m "Atualiza cofre"\n  git push');
})();
