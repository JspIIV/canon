// Prove Canon end to end on GenLayer Asimov.
//
//   AT=0x... PADV=<padv pw> PPUB=<ppub pw> node scripts/prove.mjs
//
// padv commits predictions, each naming a public source in docs/. ppub, anybody, resolves them: a
// round reads the named source and grades the claim. A source showing it came true scores RIGHT, one
// showing it did not scores WRONG, an injection page that only says "mark it correct" scores nothing,
// and an unreadable source scores nothing. The forecaster cannot grade their own; the source decides.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';

const AT = process.env.AT;
const PADV = process.env.PADV || '';
const PPUB = process.env.PPUB || '';
if (!AT || !PADV || !PPUB) { console.error('set AT, PADV and PPUB'); process.exit(1); }

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
async function acct(file, pw) {
  const w = await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, file), 'utf8'), pw);
  return { addr: w.address.toLowerCase(), client: createClient({ chain: testnetAsimov, account: createAccount(w.privateKey) }) };
}
const padv = await acct('padv.json', PADV);   // forecaster
const ppub = await acct('ppub.json', PPUB);    // resolver (anybody)
const anybody = createClient({ chain: testnetAsimov });

const RAW = 'https://raw.githubusercontent.com/JspIIV/canon/master/docs/';
const CLAIM = 'Acme will ship version 2.0 by the end of Q1 2026.';
const TRUE_URL = RAW + 'source-true.txt';
const FALSE_URL = RAW + 'source-false.txt';
const INJ_URL = RAW + 'source-injection.txt';
const UNREADABLE = RAW + 'source-nope-9f2c.txt';

const out = [];
const say = l => { console.log(l); out.push(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + tag)), ms))]);
const transient = e => /TIMEOUT|-32005|-32006|-32029|-32603|at capacity|rate limit|gas rate|reverted.*consensus|consensus.*reverted|backpressure|fetch failed|timeout|502|503|429|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|resource not found/i
  .test(String(e?.details || e?.shortMessage || e?.message || e) + ' ' + String(e?.cause?.cause?.code || e?.cause?.code || ''));
const backoff = a => Math.min(5000 * a, 20000);

async function read(fn, args = []) {
  for (let a = 1; ; a++) {
    try { return JSON.parse(await withTimeout(anybody.readContract({ address: AT, functionName: fn, args }), 45000, 'read')); }
    catch (e) { if (!transient(e) || a >= 80) throw e; await sleep(backoff(a)); }
  }
}
async function write(who, fn, args) {
  for (let a = 1; a <= 24; a++) {
    try { return await withTimeout(who.client.writeContract({ address: AT, functionName: fn, args, value: 0n }), 90000, 'write'); }
    catch (e) { if (!transient(e) || a >= 24) throw e; say(`  (${fn} ${String(e.message || e).slice(0, 30)}, wait ${backoff(a) / 1000}s)`); await sleep(backoff(a)); }
  }
}
async function predict(source) {
  const n = (await read('size')).total;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await write(padv, 'predict', [CLAIM, source]);
    for (let i = 0; i < 40; i++) { const s = await read('size'); if (s.total > n) return String(s.total - 1); await sleep(8000); }
  }
  throw new Error('prediction not committed');
}
async function resolveUntil(pid, label) {
  const before = Number((await read('get', [pid])).resolutions || 0);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { await write(ppub, 'resolve', [pid]); } catch (e) { say(`  ${label} write ${String(e.message || e).slice(0, 30)}`); }
    for (let i = 0; i < 80; i++) {
      await sleep(15000);
      const g = await read('get', [pid]);
      if (Number(g.resolutions || 0) > before) { const v = g.log[g.log.length - 1].verdict; say(`  ${label} #${pid}: ${g.status} v=${v} (${(i + 1) * 15}s)`); return g; }
    }
    say(`  ${label} #${pid}: not settled, resubmitting`);
  }
  return await read('get', [pid]);
}

say('Canon, proven on GenLayer Asimov');
say('  contract ' + AT);
say('  forecaster(padv) ' + padv.addr + '  resolver(ppub) ' + ppub.addr);
say('');

const baseRec = await read('record', [padv.addr]);

const pT = await predict(TRUE_URL);
say('padv predicted #' + pT + ' (source shows it came true)');
const pF = await predict(FALSE_URL);
say('padv predicted #' + pF + ' (source shows it did not)');
const pI = await predict(INJ_URL);
say('padv predicted #' + pI + ' (source is an injection page with no real outcome)');
const pU = await predict(UNREADABLE);
say('padv predicted #' + pU + ' (source is unreadable)');
say('');

say('resolving #' + pT + ' against a source that confirms it...');
const rT = await resolveUntil(pT, 'true');
say('  #' + pT + ' ' + rT.status + ' | ' + (rT.reason || ''));
say('resolving #' + pF + ' against a source that refutes it...');
const rF = await resolveUntil(pF, 'false');
say('  #' + pF + ' ' + rF.status + ' | ' + (rF.reason || ''));
say('resolving #' + pI + ' against the injection page (should NOT score right)...');
const rI = await resolveUntil(pI, 'injection');
say('  #' + pI + ' ' + rI.status + ' v=' + rI.log[rI.log.length - 1].verdict);
say('resolving #' + pU + ' against an unreadable source...');
const rU = await resolveUntil(pU, 'unreadable');
say('  #' + pU + ' ' + rU.status + ' v=' + rU.log[rU.log.length - 1].verdict);
say('');

say('trying to re-grade the settled #' + pT + ' (should be refused)...');
const rb = Number((await read('get', [pT])).resolutions || 0);
try { await write(ppub, 'resolve', [pT]); } catch {}
await sleep(10000);
const ra = Number((await read('get', [pT])).resolutions || 0);
say('  #' + pT + ' resolutions ' + rb + ' -> ' + ra + ' (a settled prediction is not re-graded)');
say('');

const rec = await read('record', [padv.addr]);
const size = await read('size');
say('forecaster record ' + JSON.stringify(baseRec) + ' -> ' + JSON.stringify(rec));
say('book: ' + JSON.stringify(size));

const v = g => g.log[g.log.length - 1].verdict;
const checks = [
  ['the forecaster is the committer, not the resolver', rT.forecaster === padv.addr && rT.forecaster !== ppub.addr],
  ['the claim and source are the committed bytes', rT.claim === CLAIM && rT.source === TRUE_URL],
  ['a source that confirms the claim scores it RIGHT', rT.status === 'RIGHT' && v(rT) === 'CAME_TRUE'],
  ['a source that refutes the claim scores it WRONG', rF.status === 'WRONG' && v(rF) === 'DID_NOT'],
  ['a source that only instructs the round does NOT score the prediction right', rI.status !== 'RIGHT' && v(rI) !== 'CAME_TRUE'],
  ['an unreadable source scores nothing', rU.status === 'PENDING' && v(rU) === 'UNCLEAR'],
  ["the forecaster's record gains exactly one right and one wrong", rec.right - baseRec.right === 1 && rec.wrong - baseRec.wrong === 1],
  ['a settled prediction cannot be re-graded', ra === rb],
  ['the book shows one right and one wrong this run', Number(size.right) >= 1 && Number(size.wrong) >= 1],
];
say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed` : `${checks.length} checks. Only the named source scored a prediction, and an injection page could not.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'proved.json'), JSON.stringify({
  proved_at: new Date().toISOString(), network: 'genlayer testnet asimov', contract: AT,
  right: rT, wrong: rF, injection: rI, unreadable: rU, record: rec, size,
  checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('Written to results/proved.json');
process.exit(failed.length ? 1 : 0);
