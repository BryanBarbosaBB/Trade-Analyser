/* Cofre de chaves: as API keys ficam no site criptografadas (AES-256-GCM, chave derivada de usuário+senha
   com PBKDF2-SHA256, 600 mil iterações). Sem a senha correta o conteúdo não pode ser lido.
   A segurança depende 100% da força da senha: o arquivo é público e pode ser atacado offline. */
(function (MA) {
  'use strict';
  const ITER = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

  async function deriveKey(user, pass, salt, iter) {
    const material = await crypto.subtle.importKey('raw', enc.encode(user.trim().toLowerCase() + '\u0000' + pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encrypt(data, user, pass, iter = ITER) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(user, pass, salt, iter);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
    return { v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  /* Devolve os dados ou null se usuário/senha estiverem errados (a tag do GCM não confere). */
  async function decrypt(vault, user, pass) {
    try {
      const key = await deriveKey(user, pass, unb64(vault.salt), vault.iter);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) { return null; }
  }

  // ---- sessão de administrador (vale até fechar a aba) e "lembrar neste aparelho" ----
  const SES = 'ma.admin', REM = 'ma.remember';
  const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };
  const isAdmin = () => safe(() => sessionStorage.getItem(SES) === '1', false);
  const setAdmin = (on) => safe(() => (on ? sessionStorage.setItem(SES, '1') : sessionStorage.removeItem(SES)));
  const remember = () => safe(() => localStorage.getItem(REM) !== '0', true);
  const setRemember = (on) => safe(() => localStorage.setItem(REM, on ? '1' : '0'));
  const hasVault = () => !!(MA.VAULT && MA.VAULT.ct);

  MA.auth = { encrypt, decrypt, isAdmin, setAdmin, remember, setRemember, hasVault, ITER };
})(globalThis.MA = globalThis.MA || {});
