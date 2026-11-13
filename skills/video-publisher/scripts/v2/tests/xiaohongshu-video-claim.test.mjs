import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkXiaohongshuVideoClaim, reserveXiaohongshuVideoClaim, hasXiaohongshuSaveJournal,
  XiaohongshuDuplicateVideoError } from '../lib/xiaohongshu-video-claim.mjs';

const video = { sha256: 'a'.repeat(64), size: 12345, path: '/one/video.mp4' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-video-claim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { registryPath: path.join(root, 'locks', 'xiaohongshu-video-claims.json'), stateRoots: [path.join(root, 'jobs')],
    video, jobId: 'first', jobDir: path.join(root, 'jobs', 'first'), fingerprint: 'first-package', operation: 'auto', phase: 'upload_start' };
  return { root, options };
}
function oldJob(root, jobId, options = {}) {
  const jobDir = path.join(root, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({ jobId, video: options.video || video, platforms: {
    xiaohongshu: { status: options.status || 'blocked', ...options.item }, ...options.platforms } }));
  return jobDir;
}

test('byte identity survives renamed path, title, cover, fingerprint, job and state root', t => {
  const { root, options } = fixture(t);
  reserveXiaohongshuVideoClaim(options);
  const next = { ...options, stateRoots: [path.join(root, 'another-root')], jobId: 'second', jobDir: path.join(root, 'another-root', 'second'),
    fingerprint: 'different-title-cover-package', video: { ...video, path: '/renamed/other.mp4' } };
  assert.throws(() => reserveXiaohongshuVideoClaim(next), error => error instanceof XiaohongshuDuplicateVideoError
    && error.matches[0].jobId === 'first' && /original --job-id/.test(error.message));
  assert.equal(JSON.parse(fs.readFileSync(options.registryPath)).claims.length, 1);
  assert.equal(fs.statSync(options.registryPath).mode & 0o777, 0o600);
});

test('same job resumes its claim without new resources or duplicate registry rows', t => {
  const { options } = fixture(t);
  const first = reserveXiaohongshuVideoClaim(options);
  const second = reserveXiaohongshuVideoClaim({ ...options, phase: 'persist' });
  assert.equal(first.firstClaimedAt, second.firstClaimedAt);
  assert.equal(second.phase, 'persist');
  assert.equal(JSON.parse(fs.readFileSync(options.registryPath)).claims.length, 1);
});

test('different bytes are not identified by matching title or filename', t => {
  const { root, options } = fixture(t);
  reserveXiaohongshuVideoClaim(options);
  assert.doesNotThrow(() => reserveXiaohongshuVideoClaim({ ...options, jobId: 'different', jobDir: path.join(root, 'jobs', 'different'),
    video: { ...video, sha256: 'b'.repeat(64) } }));
});

test('historical uploads and pending saves block before any new claim even without registry', t => {
  for (const kind of ['receipt', 'history', 'journal', 'ready']) {
    const { root, options } = fixture(t);
    const prior = oldJob(options.stateRoots[0], 'old', { item: kind === 'receipt' ? { videoReceipt: { mode: 'injected' } }
      : kind === 'history' ? { history: [{ phase: 'upload_start' }] } : kind === 'ready' ? { status: 'ready' } : {} });
    if (kind === 'journal') {
      fs.mkdirSync(path.join(prior, 'checkpoints'));
      fs.writeFileSync(path.join(prior, 'checkpoints', 'xiaohongshu.receipts.json.draft-save.json'), '{"status":"intent"}');
      assert.equal(hasXiaohongshuSaveJournal(prior), true);
    }
    assert.throws(() => checkXiaohongshuVideoClaim(options), XiaohongshuDuplicateVideoError, kind);
    assert.equal(fs.existsSync(options.registryPath), false);
  }
});

test('unstarted login failure and another platform history do not claim XHS video', t => {
  const { options } = fixture(t);
  oldJob(options.stateRoots[0], 'login-only', { item: { history: [{ phase: 'inspect', blocker: { code: 'AUTH_REQUIRED' } }] } });
  oldJob(options.stateRoots[0], 'other-platform', { platforms: { xiaohongshu: undefined, bilibili: { status: 'ready' } } });
  assert.doesNotThrow(() => checkXiaohongshuVideoClaim(options));
});

test('only explicit repost may create another same-content claim', t => {
  const { root, options } = fixture(t);
  reserveXiaohongshuVideoClaim(options);
  const next = { ...options, jobId: 'second', jobDir: path.join(root, 'jobs', 'second') };
  for (const overrides of [{ confirmNewCopy: true }, { operation: 'repost' }]) {
    assert.throws(() => reserveXiaohongshuVideoClaim({ ...next, ...overrides }), XiaohongshuDuplicateVideoError);
  }
  reserveXiaohongshuVideoClaim({ ...next, operation: 'repost', confirmNewCopy: true });
  assert.equal(JSON.parse(fs.readFileSync(options.registryPath)).claims.length, 2);
  assert.doesNotThrow(() => reserveXiaohongshuVideoClaim({ ...next, operation: 'resume' }));
  assert.doesNotThrow(() => reserveXiaohongshuVideoClaim(options));
});

test('corrupt claim registry and invalid video identity fail closed without erasing history', t => {
  const { options } = fixture(t);
  reserveXiaohongshuVideoClaim(options);
  fs.writeFileSync(options.registryPath, '{broken');
  assert.throws(() => checkXiaohongshuVideoClaim(options), /unreadable/);
  assert.equal(fs.readFileSync(options.registryPath, 'utf8'), '{broken');
  assert.throws(() => checkXiaohongshuVideoClaim({ ...options, video: { sha256: 'title-is-not-a-hash', size: 1 } }), /SHA-256/);
});

test('historical atomic backup preserves duplicate detection without modifying corrupt primary', t => {
  const { options } = fixture(t);
  const prior = oldJob(options.stateRoots[0], 'old', { item: { videoReceipt: { mode: 'injected' } } });
  fs.copyFileSync(path.join(prior, 'state.json'), path.join(prior, 'state.backup.json'));
  fs.writeFileSync(path.join(prior, 'state.json'), '{broken');
  assert.throws(() => checkXiaohongshuVideoClaim(options), XiaohongshuDuplicateVideoError);
  assert.equal(fs.readFileSync(path.join(prior, 'state.json'), 'utf8'), '{broken');
});
