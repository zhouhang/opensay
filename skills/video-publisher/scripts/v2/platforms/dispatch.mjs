const prepared = platform === 'xiaohongshu' && typeof xhsVerifySavedMode === 'function' && xhsVerifySavedMode()
  ? await prepareXhsReadOnlyPlatform() : await preparePlatform();
if (!prepared.selected.ok) {
  await emitObservation({
    blocker: prepared.selected.blocker,
    gates: {
      authenticated: failedGate({ reason: 'page unavailable' }),
      draftIdentity: failedGate({ reason: 'page unavailable' }),
      video: failedGate({ reason: 'page unavailable' }),
    },
  });
} else {
  if (platform === 'xiaohongshu' && phase === 'persist'
    && typeof xhsReconcileContext !== 'undefined' && xhsReconcileContext) await openXhsReconcileOriginal();
  const publicationBlocker = platform === 'xiaohongshu' && (phase !== 'park'
    || typeof xhsVerifySavedMode === 'function' && xhsVerifySavedMode())
    ? xhsNativePublicationBlocker(await readXhsNativeDraft()) : null;
  if (publicationBlocker) {
    await emitObservation({ gates: {}, blocker: publicationBlocker });
  } else {
  if (['upload_start', 'prefill', 'upload', 'mutate'].includes(phase)) {
    await js(`delete window[${JSON.stringify(PERSISTED_DRAFT_KEY)}]`);
  }
  let result = phase === 'replace_video' ? await replaceOriginalDraftVideo() : phase === 'park' ? await parkXhsDraft() : phase === 'persist'
    ? await persistAndReopenDraft(inspectPersistedPlatform)
    : await runPlatformPhase();
  if (platform === 'xiaohongshu' && typeof finishXhsReadOnlyParking === 'function') result = await finishXhsReadOnlyParking(result);
  await emitObservation(result);
  }
}
