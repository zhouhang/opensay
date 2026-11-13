import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALIASES = { xiaohongshu: 'xhs', bilibili: 'bili', douyin: 'dy', wechat_channels: 'wechat', youtube: 'yt' };
export function draftboxLedgerPath() {
  return process.env.VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH
    ? path.resolve(process.env.VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH)
    : path.join(os.homedir(), 'content-pipeline', '.draftbox_ledger.json');
}
export function readDraftboxLedger(file) {
  if (!fs.existsSync(file)) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Draftbox ledger is unreadable; preserve and reconcile it before platform writes'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Draftbox ledger must be an object; do not clear it to bypass duplicate protection');
  }
  return value;
}
export function checkLegacyXiaohongshuDraftbox({ ledger, video, jobId, packagePath, stateExisted, operation, confirmNewCopy }) {
  const record = ledger[`xhs|sha:${video.sha256}`];
  if (!record) return;
  if (typeof record !== 'object' || Array.isArray(record) || (record.platform && record.platform !== 'xhs')) {
    throw new Error('Xiaohongshu draftbox ledger record is invalid; reconcile the original resource before upload');
  }
  // Old wrapper entries have no job_id. An existing exact-package job may still
  // recover, but its fingerprint and native account/UUID/file ID are rechecked.
  if (stateExisted && ((record.job_id && record.job_id === jobId)
    || (!record.job_id && record.package && path.resolve(record.package) === path.resolve(packagePath)))) return;
  if (operation === 'repost' && confirmNewCopy === true) return;
  throw new Error(`XIAOHONGSHU_DUPLICATE_VIDEO: legacy ledger already records these video bytes; inspect the original job=${record.job_id || '(not recorded)'} package=${record.package || '(not recorded)'}. Preserve the ledger and recover its native draft; it is not fresh READY evidence.`);
}

// Only the orchestrator calls this while holding the publisher and job locks.
// No network or selection-pool update is performed; this is a local mirror.
export function recordVerifiedDraftbox({ file, video, jobId, packagePath, title, platforms, state, verifiedPlatforms }) {
  const eligible = platforms.filter(platform => verifiedPlatforms.has(platform)
    && state.platforms[platform]?.verdict?.ready === true
    && state.platforms[platform]?.verdict?.verificationVersion === 2);
  if (!eligible.length) return [];
  const ledger = readDraftboxLedger(file);
  for (const platform of eligible) {
    const alias = ALIASES[platform];
    if (!alias) throw new Error(`Unsupported draftbox ledger platform: ${platform}`);
    const key = `${alias}|sha:${video.sha256}`;
    const previous = ledger[key] && typeof ledger[key] === 'object' && !Array.isArray(ledger[key]) ? ledger[key] : {};
    ledger[key] = { ...previous, at: new Date().toISOString(), platform: alias,
      title, video: video.path, package: packagePath, job_id: jobId, record_id: '',
      ...(previous.record_id ? { record_id: previous.record_id } : {}),
      verification_version: 2, evidence_path: state.platforms[platform].lastEvidencePath || null };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return eligible;
}
