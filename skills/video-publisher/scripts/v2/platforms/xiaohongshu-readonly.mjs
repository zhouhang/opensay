// This operation verifies a saved browser-local resource. It does NOT assert
// unpublished status. No input mutation, upload, save click or journal restart.
function xhsVerifySavedMode() {
  return typeof xhsVerifySavedContext !== 'undefined' && Boolean(xhsVerifySavedContext);
}

// Self-contained so CDP can install the same guard before each new document's
// native code. Existing transactions are also protected at object-store calls.
function installXhsNativeReadOnlyGuard(binding) {
  const key = '__VIDEO_PUBLISHER_XHS_READONLY__';
  if (location.origin !== 'https://creator.xiaohongshu.com') return {ok: false, reason: 'wrong origin'};
  if (window[key]?.active) {
    if (window[key].binding !== binding) throw new Error('Read-only guard belongs to another original resource');
    return {ok: true, active: true, binding};
  }
  if (!window.IDBDatabase || !window.IDBObjectStore) return {ok: false, reason: 'IndexedDB prototypes unavailable'};
  const state = {active: true, binding, blocked: [], originals: []};
  const deny = (method, db) => {
    state.blocked.push({method, database: db, at: Date.now()});
    throw new DOMException('Draft database is read-only during saved-draft verification', 'ReadOnlyError');
  };
  const patch = (proto, name, wrapper) => {
    const original = proto[name];
    const patched = wrapper(original);
    Object.defineProperty(proto, name, {value: patched, writable: true, configurable: true});
    state.originals.push({proto, name, original, patched});
  };
  patch(IDBDatabase.prototype, 'transaction', original => function(stores, mode, ...rest) {
    if (this.name === 'draft-database-v1' && mode && mode !== 'readonly') return deny('transaction:' + mode, this.name);
    return Reflect.apply(original, this, [stores, mode, ...rest]);
  });
  for (const name of ['add', 'put', 'delete', 'clear']) patch(IDBObjectStore.prototype, name, original => function(...args) {
    const db = this.transaction?.db?.name;
    if (db === 'draft-database-v1') return deny('objectStore:' + name, db);
    return Reflect.apply(original, this, args);
  });
  if (window.IDBFactory?.prototype?.deleteDatabase) patch(IDBFactory.prototype, 'deleteDatabase', original => function(name, ...rest) {
    if (name === 'draft-database-v1') return deny('deleteDatabase', name);
    return Reflect.apply(original, this, [name, ...rest]);
  });
  state.release = () => {
    for (const item of state.originals) if (item.proto[item.name] === item.patched)
      Object.defineProperty(item.proto, item.name, {value: item.original, writable: true, configurable: true});
    state.active = false;
    return {ok: true, released: true, blockedWrites: state.blocked.length};
  };
  window[key] = state;
  return {ok: true, active: true, binding, blockedWrites: 0};
}

function xhsReadOnlyGuardBinding() {
  const c = xhsVerifySavedContext;
  return `${c.fingerprint}:${c.taskSpaceId}:${c.plan.uid}:${c.plan.id}:${c.plan.videoFileId}`;
}

async function prepareXhsReadOnlyPlatform() {
  const task = await selectTaskSpace();
  if (taskSpaceRecovery || Number(task.id) !== Number(xhsVerifySavedContext.taskSpaceId)
    || task.name !== xhsVerifySavedContext.taskSpaceName) throw new Error('Read-only verification cannot recreate or change the original task space');
  const tabs = (await listTabs()).filter(tab => PLATFORM_HOSTS.xiaohongshu.test(String(tab.url || '')));
  if (tabs.length !== 1) throw new Error('Read-only verification requires one existing original creator tab; it never opens a new one');
  await switchTab(tabs[0].targetId);
  const c = xhsVerifySavedContext, binding = xhsReadOnlyGuardBinding();
  let meta = fs.existsSync(c.guardPath) ? JSON.parse(fs.readFileSync(c.guardPath, 'utf8')) : null;
  if (meta && meta.binding !== binding) throw new Error('Read-only guard checkpoint belongs to another original resource');
  meta ||= {version: 1, binding, scriptIds: []};
  const source = `(${installXhsNativeReadOnlyGuard.toString()})(${JSON.stringify(binding)})`;
  const installation = await cdp('Page.addScriptToEvaluateOnNewDocument', {source});
  if (!installation.identifier) throw new Error('Read-only guard could not cover new documents');
  meta.scriptIds.push(installation.identifier);meta.released = false;
  fs.mkdirSync(path.dirname(c.guardPath), {recursive: true, mode: 0o700});
  fs.writeFileSync(c.guardPath, JSON.stringify(meta, null, 2) + '\n', {mode: 0o600});
  const installed = await js(source);
  if (installed?.active !== true) throw new Error('Current-document draft write guard is unavailable');
  const guard = await armFinalPublishGuard();
  if (!guard.ok || !guard.armed) throw new Error('Final-publish guard failed during read-only verification');
  return {task, selected: {ok: true}, guard, readOnly: installed};
}

async function assertXhsReadOnlyGuard() {
  if (!xhsVerifySavedMode()) return;
  const state = await js(`(() => {const s=window.__VIDEO_PUBLISHER_XHS_READONLY__;return s?{active:s.active,binding:s.binding,blockedWrites:s.blocked.length}:null;})()`);
  if (!state?.active || state.binding !== xhsReadOnlyGuardBinding()) throw new Error('Saved-draft verification lost its native-write guard');
}

async function finishXhsReadOnlyParking(result) {
  if (!xhsVerifySavedMode() || phase !== 'park' || result.blocker) return result;
  await assertXhsReadOnlyGuard();
  const stored = await readXhsStoredDraft(xhsVerifySavedContext.plan.id);
  if (stored.activeVideoFileId || stored.activeTitle || stored.activeDescription) throw new Error('Do not release draft-write guard while an editor is active');
  const meta = JSON.parse(fs.readFileSync(xhsVerifySavedContext.guardPath, 'utf8'));
  const blocked = await js('window.__VIDEO_PUBLISHER_XHS_READONLY__.blocked.slice()');
  for (const identifier of meta.scriptIds) await cdp('Page.removeScriptToEvaluateOnNewDocument', {identifier});
  const released = await js('window.__VIDEO_PUBLISHER_XHS_READONLY__.release()');
  meta.scriptIds=[];meta.released=true;meta.releasedAt=new Date().toISOString();meta.blockedWrites=blocked;
  fs.writeFileSync(xhsVerifySavedContext.guardPath, JSON.stringify(meta,null,2)+'\n',{mode:0o600});
  return {...result,evidence:{...result.evidence,readOnlyVerification:{operation:'verify-saved-xhs',
    noUpload:true,noMetadataMutation:true,noSaveClick:true,publicationStatus:'not-asserted',
    nativeWriteGuard:released,blockedNativeWrites:blocked,guardCheckpoint:xhsVerifySavedContext.guardPath}}};
}
