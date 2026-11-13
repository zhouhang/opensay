import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Call only while holding the fixed account-wide publisher lock. A package
// fingerprint includes paths and metadata, so it cannot identify video bytes.
export class XiaohongshuDuplicateVideoError extends Error {
  constructor(matches) {
    const locations = matches.map(item => `${item.jobId} (${item.jobDir})`).join(', ');
    super(`XIAOHONGSHU_DUPLICATE_VIDEO: identical video bytes already belong to ${locations}. Inspect/resume the original --job-id and original package; changing title, cover or path must not upload another copy. Explicit repost requires --operation repost --confirm-new-copy.`);
    this.name = 'XiaohongshuDuplicateVideoError';
    this.matches = matches;
  }
}

function readRegistry(file) {
  if (!fs.existsSync(file)) return { version: 1, roots: [], claims: [] };
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Xiaohongshu video-claim registry is unreadable; preserve it and reconcile before upload'); }
  if (value?.version !== 1 || !Array.isArray(value.roots) || !Array.isArray(value.claims)
    || value.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))
    || value.claims.some(claim => !/^[a-f0-9]{64}$/.test(claim?.sha256 || '')
      || !Number.isSafeInteger(claim.size) || claim.size < 0 || !claim.jobId
      || typeof claim.jobDir !== 'string' || !path.isAbsolute(claim.jobDir))) {
    throw new Error('Xiaohongshu video-claim registry schema mismatch; do not clear it to bypass duplicate protection');
  }
  return value;
}

function sameBytes(left, right) {
  return left?.sha256 === right?.sha256 && left?.size === right?.size;
}

export function hasXiaohongshuSaveJournal(jobDir) {
  const directory = path.join(jobDir, 'checkpoints');
  return fs.existsSync(directory) && fs.readdirSync(directory)
    .some(name => /^xiaohongshu\..*\.draft-save\.json$/.test(name));
}

function hasNativeWork(item, jobDir) {
  return Boolean(item && (item.videoReceipt || item.receipts?.uploadStart || item.verdict?.ready
    || ['ready', 'needs_mutation', 'needs_persistence'].includes(item.status)
    || item.history?.some(entry => ['upload_start', 'upload', 'prefill', 'mutate', 'persist'].includes(entry.phase))
    || hasXiaohongshuSaveJournal(jobDir)));
}

function historicalClaims(roots, video, currentJobDir) {
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.resolve(root, entry.name);
      if (jobDir === currentJobDir) continue;
      const file = path.join(jobDir, 'state.json');
      if (!fs.existsSync(file)) continue;
      let state;
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch {
        try { state = JSON.parse(fs.readFileSync(path.join(jobDir, 'state.backup.json'), 'utf8')); }
        catch { throw new Error(`Cannot inspect historical job state for duplicate video protection: ${jobDir}`); }
      }
      if (sameBytes(state.video, video) && hasNativeWork(state.platforms?.xiaohongshu, jobDir)) {
        found.push({ sha256: video.sha256, size: video.size, jobId: state.jobId || entry.name,
          jobDir, fingerprint: state.fingerprint || null, source: 'historical-job' });
      }
    }
  }
  return found;
}

export function checkXiaohongshuVideoClaim({ registryPath, stateRoots, video, jobDir, operation, confirmNewCopy }) {
  if (!/^[a-f0-9]{64}$/.test(video?.sha256 || '') || !Number.isSafeInteger(video?.size)) {
    throw new Error('Xiaohongshu duplicate protection requires the exact local video SHA-256 and size');
  }
  const registry = readRegistry(registryPath);
  const roots = [...new Set([...registry.roots, ...stateRoots].map(root => path.resolve(root)))];
  const currentJobDir = path.resolve(jobDir);
  const currentClaim = registry.claims.find(claim => sameBytes(claim, video) && path.resolve(claim.jobDir) === currentJobDir) || null;
  const candidates = [...registry.claims, ...historicalClaims(roots, video, currentJobDir)];
  const matches = [...new Map(candidates.filter(claim => sameBytes(claim, video)
    && path.resolve(claim.jobDir) !== currentJobDir).map(claim => [path.resolve(claim.jobDir), claim])).values()];
  if (matches.length && !currentClaim && !(operation === 'repost' && confirmNewCopy === true)) {
    throw new XiaohongshuDuplicateVideoError(matches);
  }
  return { registry, roots, currentJobDir, matches, currentClaim };
}

export function reserveXiaohongshuVideoClaim(options) {
  const { registry, roots, currentJobDir } = checkXiaohongshuVideoClaim(options);
  const previous = registry.claims.find(claim => sameBytes(claim, options.video)
    && path.resolve(claim.jobDir) === currentJobDir);
  // An uncertain upload/save intent is deliberately retained, including if the
  // browser dies before it can return a native ID or an upload receipt.
  const claim = { ...previous, sha256: options.video.sha256, size: options.video.size,
    jobId: options.jobId, jobDir: currentJobDir, fingerprint: options.fingerprint,
    firstClaimedAt: previous?.firstClaimedAt || new Date().toISOString(), phase: options.phase };
  const value = { version: 1, roots, claims: [...registry.claims.filter(item => item !== previous), claim] };
  fs.mkdirSync(path.dirname(options.registryPath), { recursive: true, mode: 0o700 });
  const temp = `${options.registryPath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, options.registryPath);
    const dir = fs.openSync(path.dirname(options.registryPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return claim;
}
