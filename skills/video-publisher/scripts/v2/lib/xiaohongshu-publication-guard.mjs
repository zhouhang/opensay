import fs from 'node:fs';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://creator.xiaohongshu.com';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blocker = (code, message, evidence = {}) => ({ code, message, retryable: false, requiresUser: false, evidence });

// A browser-local draft is not a publication-status authority. In particular,
// false flags on a stale editor do not prove that a different tab never published.
export function xhsNativePublicationBlocker(state) {
  const p = state?.publication || {};
  if (p.noteId || p.hasBeenPublished === true || p.hasBeenPublishSuccess === true) {
    return blocker('ALREADY_PUBLISHED', '小红书原生资源已有发布标记；禁止恢复、编辑或再次暂存', {
      draftId: state?.id || null, uid: state?.uid || null, videoFileId: state?.live?.videoFileId || null,
      noteId: p.noteId || null, hasBeenPublished: p.hasBeenPublished === true,
      hasBeenPublishSuccess: p.hasBeenPublishSuccess === true,
    });
  }
  return null;
}

export function readXhsPublicationStatus(file, plan, now = Date.now()) {
  if (!file) return { blocker: blocker('STATE_AMBIGUOUS', '旧小红书草稿缺少本轮原生发布状态证据；禁止自动重开或再次暂存') };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.platform !== 'xiaohongshu'
      || !manifest.evidencePath || !/^[a-f0-9]{64}$/.test(manifest.evidenceSha256 || '')) throw new Error('invalid publication-status manifest');
    const bytes = fs.readFileSync(manifest.evidencePath);
    if (hash(bytes) !== manifest.evidenceSha256) throw new Error('publication-status evidence changed');
    const evidence = JSON.parse(bytes.toString('utf8'));
    if (new URL(evidence.sourceUrl).origin !== ORIGIN || evidence.platform !== 'xiaohongshu'
      || !Array.isArray(evidence.resources)) throw new Error('invalid native publication-status evidence');
    const matches = evidence.resources.filter(record => record.uid === plan.uid
      && record.videoFileId === plan.videoFileId && (!record.draftId || record.draftId === plan.id));
    if (matches.some(record => record.published === true && Boolean(record.noteId))) {
      return { blocker: blocker('ALREADY_PUBLISHED', '此小红书视频已发布；禁止恢复旧编辑器或重新生成草稿', {
        draftId: plan.id, uid: plan.uid, videoFileId: plan.videoFileId,
        noteIds: matches.filter(record => record.published === true).map(record => record.noteId),
        evidencePath: manifest.evidencePath, evidenceSha256: manifest.evidenceSha256,
      }) };
    }
    const observed = Date.parse(evidence.observedAt);
    const exact = matches.filter(record => record.draftId === plan.id && record.published === false
      && record.statusAuthority === 'native-resource-detail' && record.noteId === null);
    if (evidence.complete !== true || exact.length !== 1 || !Number.isFinite(observed)
      || observed > now || now - observed > 60000) throw new Error('no fresh explicit unpublished resource detail');
    return { allowed: true, evidence: { version: 1, uid: plan.uid, draftId: plan.id,
      videoFileId: plan.videoFileId, observedAt: evidence.observedAt, evidencePath: manifest.evidencePath,
      evidenceSha256: manifest.evidenceSha256, status: 'not_published' } };
  } catch (error) {
    return { blocker: blocker('STATE_AMBIGUOUS', '小红书发布状态无法严格确认；禁止自动重开或再次暂存', {
      reason: String(error?.message || error), draftId: plan?.id || null,
    }) };
  }
}

export function checkXhsRecoveryPublication({ journal, statusPath, operation, now = Date.now() }) {
  // Parking only removes a live editor from service; it cannot save, reopen or
  // edit any resource. Unknown publication state must not prevent quiescing it.
  if (operation === 'park' || !journal) return { allowed: true, protectiveParking: operation === 'park' };
  if (!journal.plan?.id || !journal.plan.uid || !journal.plan.videoFileId) {
    return { blocker: blocker('STATE_AMBIGUOUS', '旧小红书保存日志缺少原生账号、UUID 或视频身份') };
  }
  return readXhsPublicationStatus(statusPath, journal.plan, now);
}
