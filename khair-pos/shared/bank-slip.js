/* v57 (owner 2026-10-15: «عندما يتم عملية التحويل البنكي يقع التقاط الصورة للتحويل البنكي والتطبيق مباشرة يتعرف على أي نوع البنك ويصنفها حسب
   الصورة»): which store bank account a transfer slip shows — money in: the receiver's account, money out: the sender's. First by the
   account number (a slip often hides all but the last digits: xxxx7890), then by the bank's name when only one active store account is
   at that bank; '' when the slip does not tell. The same rules as slipAccount() in backend/process.js — for Khair Kasir and the owner
   app (the account is chosen by itself after the slip photo) and for both demo backends. */
(function () {
  const ALIASES = [['bca', 'mybca', 'klikbca', 'bank central asia'], ['bri', 'brimo', 'bank rakyat indonesia'], ['mandiri', 'livin'], ['bni', 'bank negara indonesia'],
    ['bsi', 'bank syariah indonesia'], ['cimb', 'octo'], ['permata'], ['danamon'], ['btn', 'bank tabungan negara'], ['jago'], ['seabank'], ['dana'], ['ovo'], ['gopay'], ['shopeepay']];
  const s = v => (v == null ? '' : String(v)).trim();
  /** A bank's name as one key: "Bank Central Asia", "myBCA", "BCA" → "bca". */
  function key(name) {
    const n = ' ' + s(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    if (!n.trim()) return '';
    for (const g of ALIASES) if (g.some(al => n.indexOf(' ' + al + ' ') >= 0)) return g[0];
    return n.replace(/\s+/g, '');
  }
  function slipAccount(accounts, ex, dir) {
    if (!ex || typeof ex !== 'object') return '';
    const accs = (Array.isArray(accounts) ? accounts : []).filter(x => x && s(x.id) && x.active !== false);
    const no = s(dir === 'out' ? ex.sender_account : ex.receiver_account), bank = dir === 'out' ? s(ex.sender_bank) || s(ex.bank) : s(ex.receiver_bank);
    const all = no.replace(/\D/g, ''), tail = (no.match(/(\d+)\D*$/) || [])[1] || '';
    if (all.length >= 3) {
      const hit = accs.filter(x => { const a = s(x.account_no).replace(/\D/g, ''); return a && (a === all || (tail.length >= 3 && /[^\d\s.-]/.test(no) && a.slice(-tail.length) === tail)); });
      if (hit.length === 1) return s(hit[0].id);
    }
    const k = key(bank);
    if (k) { const hb = accs.filter(x => key(x.bank) === k); if (hb.length === 1) return s(hb[0].id); }
    return '';
  }
  window.KBank = { key, slipAccount };
})();
