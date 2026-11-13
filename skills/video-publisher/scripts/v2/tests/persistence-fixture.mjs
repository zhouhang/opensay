import fs from 'node:fs';

const browserPersistenceSource = fs.readFileSync(new URL('../ego/persisted-draft.mjs', import.meta.url), 'utf8');
export const browserTagRevisionSourceCode = browserPersistenceSource.slice(
  browserPersistenceSource.indexOf('function readBrowserCoverRevisionSource()'),
  browserPersistenceSource.indexOf('async function readPersistedDraft()'));
export const browserRevisionSourceCode = browserTagRevisionSourceCode;

export function persistenceEvidence(platform, fingerprint = 'test-content', verificationRunId = 'test-run') {
  const now = new Date().toISOString();
  return { version: 2, platform, fingerprint, verificationRunId, draftId: 'draft-test',
    savedAt: now, readAt: now,
    ...(platform === 'youtube'
      ? { method: 'youtube.videos.list', private: true, actualId: 'draft-test', channelVerified: true }
      : platform === 'douyin'
        ? { method: 'resume-slot-reopen', resumeSlotObserved: true, resumeSlotId: 'draft-test',
          reopenedId: 'editor-instance-test', documentChanged: false, routeChanged: true, contentReadback: true,
          uploadUrl: 'https://example.test/upload',
          reopenedUrl: 'https://example.test/post/video?enter_from=draft' }
        : { method: 'draft-list-reopen', listEntryId: 'draft-test', reopenedId: 'draft-test', documentChanged: true,
          listUrl: 'https://example.test/drafts', reopenedUrl: 'https://example.test/edit?draft_id=draft-test' }) };
}
