import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDraftboxLedger, checkLegacyXiaohongshuDraftbox, recordVerifiedDraftbox } from '../lib/draftbox-ledger.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftbox-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file: path.join(root, 'ledger.json'), video: { sha256: 'a'.repeat(64), size: 123, path: '/video.mp4' },
    jobId: 'same', packagePath: '/package.json', title: 'Approved title' };
}

test('legacy exact SHA entry blocks a new job without pretending it is READY', t => {
  const options = fixture(t), record = { platform: 'xhs', package: '/old/package.json', job_id: 'old' };
  const ledger = { [`xhs|sha:${options.video.sha256}`]: record };
  assert.throws(() => checkLegacyXiaohongshuDraftbox({ ...options, ledger, stateExisted: false }), /DUPLICATE_VIDEO.*old/);
  assert.doesNotThrow(() => checkLegacyXiaohongshuDraftbox({ ...options, ledger: { 'xhs|title:Approved title#vid:': record }, stateExisted: false }));
});

test('exact original-job resume and revisions do not get skipped by legacy bookkeeping', t => {
  const options = fixture(t);
  for (const operation of ['resume', 'replace-cover', 'update-tags']) {
    for (const record of [{ platform: 'xhs', job_id: options.jobId, package: options.packagePath },
      { platform: 'xhs', job_id: '', package: options.packagePath }]) {
      assert.doesNotThrow(() => checkLegacyXiaohongshuDraftbox({ ...options, operation, stateExisted: true,
        ledger: { [`xhs|sha:${options.video.sha256}`]: record } }));
    }
  }
  assert.throws(() => checkLegacyXiaohongshuDraftbox({ ...options, operation: 'resume', stateExisted: false,
    ledger: { [`xhs|sha:${options.video.sha256}`]: { platform: 'xhs', job_id: options.jobId } } }), /DUPLICATE_VIDEO/);
});

test('partial completion records only freshly verified READY platforms, retaining unrelated rows', t => {
  const options = fixture(t);
  fs.writeFileSync(options.file, JSON.stringify({ prior: { title: 'Keep original row' } }));
  const state = { platforms: {
    xiaohongshu: { verdict: { ready: true, verificationVersion: 2 }, lastEvidencePath: '/fresh/xhs.json' },
    bilibili: { verdict: { ready: false, verificationVersion: 2 } },
    youtube: { verdict: { ready: true, verificationVersion: 2 } },
    douyin: { verdict: { ready: true, verificationVersion: 1 } },
  } };
  const recorded = recordVerifiedDraftbox({ ...options, state, platforms: Object.keys(state.platforms),
    verifiedPlatforms: new Set(['xiaohongshu', 'bilibili', 'douyin']) });
  assert.deepEqual(recorded, ['xiaohongshu']);
  const ledger = readDraftboxLedger(options.file);
  assert.equal(ledger.prior.title, 'Keep original row');
  assert.equal(ledger[`xhs|sha:${options.video.sha256}`].job_id, options.jobId);
  assert.equal(ledger[`xhs|sha:${options.video.sha256}`].evidence_path, '/fresh/xhs.json');
  assert.equal(Object.keys(ledger).length, 2);
  assert.equal(fs.statSync(options.file).mode & 0o777, 0o600);
});

test('no current verification never creates a ledger or transforms historical READY into success', t => {
  const options = fixture(t);
  assert.deepEqual(recordVerifiedDraftbox({ ...options, state: { platforms: {
    xiaohongshu: { verdict: { ready: true, verificationVersion: 2 } } } }, platforms: ['xiaohongshu'], verifiedPlatforms: new Set() }), []);
  assert.equal(fs.existsSync(options.file), false);
});

test('unreadable/invalid ledgers and a malformed matching row fail closed and remain intact', t => {
  const options = fixture(t);
  for (const bytes of ['{broken', '[]', 'null']) {
    fs.writeFileSync(options.file, bytes);
    assert.throws(() => readDraftboxLedger(options.file), /ledger/);
    assert.equal(fs.readFileSync(options.file, 'utf8'), bytes);
  }
  assert.throws(() => checkLegacyXiaohongshuDraftbox({ ...options,
    ledger: { [`xhs|sha:${options.video.sha256}`]: 'invalid' } }), /invalid/);
});
