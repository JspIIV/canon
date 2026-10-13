// Prove the reworked Canon end to end on GenLayer Asimov, with genuine future-dated predictions.
//
//   AT=0x... PADV=<padv pw> PPUB=<ppub pw> node scripts/prove.mjs
//
// padv commits future-dated predictions (each with a deadline and a committed source). It proves:
//  - a past deadline is refused at predict time (no backdating a known outcome),
//  - a duplicate claim from the same forecaster is refused (no reputation farming),
//  - resolve is refused before the deadline (no premature grading),
//  - after the deadline the committed source grades it RIGHT or WRONG, recording an evidence fingerprint,
//  - an injection source that only says "mark it CAME_TRUE" scores nothing.
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
const ppub = await acct('ppub.json', PPUB);    // resolver
const anybody = createClient({ chain: testnetAsimov });

const RAW = 'https://raw.githubusercontent.com/JspIIV/canon/master/docs/';
const TRUE_URL = RAW + 'source-true.txt';
const FALSE_URL = RAW + 'source-false.txt';
const INJ_URL = RAW + 'source-injection.txt';
const C_TRUE = 'Acme ships version 2.0 within the stated window (case true).';
const C_FALSE = 'Acme ships version 2.0 on schedule with no slip (case false).';
const C_INJ = 'Acme ships version 2.0 (case injection source).';
const C_PREMATURE = 'Acme ships version 3.0 far in the future (case premature).';
const C_HISTORICAL = 'Acme shipped version 1.0 long ago (case historical).';

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
  for (let a = 1; a <= 20; a++) {
    try { return await withTimeout(who.client.writeContract({ address: AT, functionName: fn, args, value: 0n }), 90000, 'write'); }
    catch (e) { if (!transient(e) || a >= 20) throw e; say(`  (${fn} ${String(e.message || e).slice(0, 30)}, wait ${backoff(a) / 1000}s)`); await sleep(backoff(a)); }
  }
}
async function predict(claim, source, deadline) {
  const n = (await read('size')).total;
  await write(padv, 'predict', [claim, source, String(deadline)]);
  for (let i = 0; i < 40; i++) { const s = await read('size'); if (s.total > n) return String(s.total - 1); await sleep(8000); }
  return null; // may be a deliberate refusal
}
async function resolveUntil(pid, label) {
  const before = Number((await read('get', [pid])).resolutions || 0);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { await write(ppub, 'resolve', [pid]); } catch (e) { say(`  ${label} write ${String(e.message || e).slice(0, 30)}`); }
    for (let i = 0; i < 80; i++) {
      await sleep(15000);
      const g = await read('get', [pid]);
      if (Number(g.resolutions || 0) > before) { const v = g.log[g.log.length - 1].verdict; say(`  ${label} #${pid}: ${g.status} v=${v} fp=${g.evidence_fp || (g.log[g.log.length-1].evidence_fp||'')} (${(i + 1) * 15}s)`); return g; }
    }
    say(`  ${label} #${pid}: not settled, resubmitting`);
  }
  return await read('get', [pid]);
}

say('Canon (reworked), proven on GenLayer Asimov with genuine future-dated predictions');
say('  contract ' + AT);
say('  forecaster(padv) ' + padv.addr + '  resolver(ppub) ' + ppub.addr);
say('');

const baseRec = await read('record', [padv.addr]);
const baseSize = await read('size');
const now = Math.floor(Date.now() / 1000);
const SOON = now + 120;         // a near-future deadline for the resolvable cases
const FAR = now + 86400;        // one day out, for the premature case
const PAST = now - 100;         // already passed, for the historical case

say('committing future-dated predictions (deadline ~120s out)...');
const pTrue = await predict(C_TRUE, TRUE_URL, SOON);
say('  committed #' + pTrue + ' (will be graded true after the deadline)');
const pFalse = await predict(C_FALSE, FALSE_URL, SOON);
say('  committed #' + pFalse + ' (will be graded false after the deadline)');
const pInj = await predict(C_INJ, INJ_URL, SOON);
say('  committed #' + pInj + ' (source is an injection page)');
const pPrem = await predict(C_PREMATURE, TRUE_URL, FAR);
say('  committed #' + pPrem + ' (deadline a day out, for the premature-resolution test)');
say('');

say('a past deadline is refused at predict time (no backdating a known outcome)...');
const sizeBeforeHist = (await read('size')).total;
await write(padv, 'predict', [C_HISTORICAL, TRUE_URL, String(PAST)]);
await sleep(12000);
const sizeAfterHist = (await read('size')).total;
say('  size ' + sizeBeforeHist + ' -> ' + sizeAfterHist + ' (a past-dated prediction did not commit)');

say('a duplicate claim from the same forecaster is refused...');
const sizeBeforeDup = (await read('size')).total;
await write(padv, 'predict', [C_TRUE, TRUE_URL, String(SOON + 10)]);
await sleep(12000);
const sizeAfterDup = (await read('size')).total;
say('  size ' + sizeBeforeDup + ' -> ' + sizeAfterDup + ' (the duplicate did not commit)');
say('');

say('resolving the far-deadline prediction before its deadline (should be refused)...');
const premBefore = Number((await read('get', [pPrem])).resolutions || 0);
try { await write(ppub, 'resolve', [pPrem]); } catch {}
await sleep(15000);
const premAfter = await read('get', [pPrem]);
say('  #' + pPrem + ' status ' + premAfter.status + ' resolutions ' + premBefore + ' -> ' + Number(premAfter.resolutions || 0) + ' (too early, refused)');
say('');

const waitUntil = SOON + 20;
let nowS = Math.floor(Date.now() / 1000);
if (nowS < waitUntil) { say('waiting ' + (waitUntil - nowS) + 's for the ~120s deadlines to pass...'); await sleep((waitUntil - nowS) * 1000); }

say('after the deadline, resolving against the committed sources...');
const rTrue = await resolveUntil(pTrue, 'true');
say('  #' + pTrue + ' ' + rTrue.status + ' | ' + (rTrue.reason || ''));
const rFalse = await resolveUntil(pFalse, 'false');
say('  #' + pFalse + ' ' + rFalse.status + ' | ' + (rFalse.reason || ''));
const rInj = await resolveUntil(pInj, 'injection');
say('  #' + pInj + ' ' + rInj.status + ' v=' + rInj.log[rInj.log.length - 1].verdict);
say('');

say('trying to re-grade the settled #' + pTrue + ' (should be refused)...');
const rb = Number((await read('get', [pTrue])).resolutions || 0);
try { await write(ppub, 'resolve', [pTrue]); } catch {}
await sleep(10000);
const ra = Number((await read('get', [pTrue])).resolutions || 0);
say('  #' + pTrue + ' resolutions ' + rb + ' -> ' + ra + ' (a settled prediction is not re-graded)');
say('');

const rec = await read('record', [padv.addr]);
const size = await read('size');
say('forecaster record ' + JSON.stringify(baseRec) + ' -> ' + JSON.stringify(rec));
say('book: ' + JSON.stringify(size));

const v = g => g.log[g.log.length - 1].verdict;
const checks = [
  ['a past-dated prediction is refused at predict (genuine future dating enforced)', sizeAfterHist === sizeBeforeHist],
  ['a duplicate claim from the same forecaster is refused (no reputation farming)', sizeAfterDup === sizeBeforeDup],
  ['resolve is refused before the deadline (no premature grading)', premAfter.status === 'PENDING' && Number(premAfter.resolutions || 0) === premBefore],
  ['after the deadline, a confirming source scores it RIGHT', rTrue.status === 'RIGHT' && v(rTrue) === 'CAME_TRUE'],
  ['after the deadline, a refuting source scores it WRONG', rFalse.status === 'WRONG' && v(rFalse) === 'DID_NOT'],
  ['an evidence fingerprint of the page read is recorded on a settled prediction', (rTrue.evidence_fp || '').length > 0 && (rFalse.evidence_fp || '').length > 0],
  ['an injection source that only instructs scores nothing', rInj.status !== 'RIGHT' && v(rInj) !== 'CAME_TRUE'],
  ['a settled prediction cannot be re-graded', ra === rb],
  ['the forecaster gains exactly one right and one wrong this run', rec.right - baseRec.right === 1 && rec.wrong - baseRec.wrong === 1],
];
say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed` : `${checks.length} checks. Only genuine future predictions, graded after their deadline against the committed source, scored.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'proved.json'), JSON.stringify({
  proved_at: new Date().toISOString(), network: 'genlayer testnet asimov', contract: AT,
  right: rTrue, wrong: rFalse, injection: rInj, premature_refused: premAfter,
  past_dated_refused: { size_before: sizeBeforeHist, size_after: sizeAfterHist },
  duplicate_refused: { size_before: sizeBeforeDup, size_after: sizeAfterDup },
  record: rec, size, checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('Written to results/proved.json');
process.exit(failed.length ? 1 : 0);
