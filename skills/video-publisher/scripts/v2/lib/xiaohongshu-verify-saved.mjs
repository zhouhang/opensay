import fs from 'node:fs';
import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`XHS saved-draft read-only verification: ${message}`); };
export const XHS_VERIFY_SAVED_OPERATION = 'verify-saved-xhs';
export const XHS_VERIFY_SAVED_PHASES = ['inspect', 'persist', 'verify', 'park'];

export function validateXhsVerifySavedContext(context, {operation, platform, phase, fingerprint, taskSpaceId, taskSpaceName}) {
  if (operation !== XHS_VERIFY_SAVED_OPERATION || platform !== 'xiaohongshu' || !XHS_VERIFY_SAVED_PHASES.includes(phase)) fail('only the single-platform read-only operation/phases are permitted');
  if (context?.version !== 1 || context.kind !== 'confirmed-local-draft-read-only-verification'
    || context.fingerprint !== fingerprint || !context.jobId || Number(context.taskSpaceId) !== Number(taskSpaceId)
    || !taskSpaceId || context.taskSpaceName !== taskSpaceName || !taskSpaceName || !context.guardPath
    || !context.journalPath || !/^[a-f0-9]{64}$/.test(context.journalSha256 || '')) fail('missing original job, space or immutable save-journal binding');
  const bytes = fs.readFileSync(context.journalPath);
  if (sha(bytes) !== context.journalSha256) fail('original save journal changed');
  const journal = JSON.parse(bytes);
  if (journal.platform !== 'xiaohongshu' || journal.fingerprint !== fingerprint || journal.status !== 'confirmed'
    || !journal.plan?.id || !journal.plan.uid || !journal.plan.videoFileId || !journal.plan.snapshotHash
    || JSON.stringify(journal.plan) !== JSON.stringify(context.plan)) fail('requires the exact existing confirmed original save journal');
  return journal;
}

export function buildXhsVerifySavedContext({jobId, item, fingerprint, journalPath, guardPath}) {
  if (!item?.taskSpaceId || !item.taskSpaceName) fail('the original task space must exist; recreation is prohibited');
  const bytes = fs.readFileSync(journalPath), journal = JSON.parse(bytes);
  const context = {version: 1, kind: 'confirmed-local-draft-read-only-verification', jobId, fingerprint,
    taskSpaceId: item.taskSpaceId, taskSpaceName: item.taskSpaceName, journalPath, journalSha256: sha(bytes),
    plan: journal.plan, guardPath};
  validateXhsVerifySavedContext(context, {operation: XHS_VERIFY_SAVED_OPERATION, platform: 'xiaohongshu', phase: 'inspect',
    fingerprint, taskSpaceId: item.taskSpaceId, taskSpaceName: item.taskSpaceName});
  return context;
}
