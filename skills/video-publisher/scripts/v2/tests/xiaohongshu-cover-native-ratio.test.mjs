import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');
const helpers = source.slice(0, source.indexOf('async function inspectXiaohongshu'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bytes = Buffer.from('exact-approved-native-cover');
const assetHash = createHash('sha256').update(bytes).digest('hex');
const fileid = 'spectrum/approved-cover-object';
const afterUrl = 'https://ros-preview.xhscdn.com/' + fileid + '?signature=current';
const paths = { vertical3x4Path: '/approved/portrait.png', horizontal4x3Path: '/approved/landscape4x3.png', horizontal16x9Path: '/approved/landscape16x9.png' };

function element({ classes = '', text = '', parent = null, visible = true, bg = 'none', disabled = false } = {}) {
  return {
    className: classes, innerText: text, textContent: text, parentElement: parent, disabled,
    style: { display: visible ? 'block' : 'none', visibility: 'visible', opacity: '1', backgroundImage: bg },
    queries: {}, clicks: 0,
    querySelectorAll(selector) { return this.queries[selector] || []; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getAttribute() { return null; },
    removeAttribute(name) { if (name === 'id') delete this.id; },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
    getBoundingClientRect() { return { width: 100, height: 100 }; },
    matches(selector) { return selector.split(',').some(item => item.trim().split('.').filter(Boolean).every(cls => this.className.split(/\s+/).includes(cls))); },
    closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; },
    click() { this.clicks += 1; },
  };
}

function packageFor(ratio = '4:3', explicit = true) {
  return { platformTitle: { xiaohongshu: 'Approved' }, xhsTopics: [], cover: { uploadCustomCover: true, ...paths, ...(explicit ? { nativeRatio: ratio } : {}) } };
}

function dimensions(ratio) { return ratio === '3:4' ? { width: 1080, height: 1440 } : ratio === '4:3' ? { width: 1988, height: 1491 } : { width: 1920, height: 1080 }; }

function receiptFor(ratio = '4:3') {
  const pathKey = { '3:4': 'vertical3x4Path', '4:3': 'horizontal4x3Path', '16:9': 'horizontal16x9Path' }[ratio];
  return { version: 2, assetPath: paths[pathKey], ratio, nativeRatio: ratio, nativeSlot: ratio === '3:4' ? 'portrait' : 'landscape', nativeFileId: fileid, assetHash, afterUrl };
}

function validation({ ratio = '4:3', explicit = true, receipt = receiptFor(ratio), preview, native, proof = null, changedBytes = false } = {}) {
  const basePreview = { ok: true, count: 1, direction: ratio === '3:4' ? 'portrait' : 'landscape', bg: `url("${afterUrl}")` };
  const baseNative = { live: { coverFileId: fileid }, liveCover: { fileid, ...dimensions(ratio) }, record: { id: 'same-draft' }, recordCover: { fileid, ...dimensions(ratio) } };
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'receipt', 'preview', 'native', 'proof', `${helpers}\nreturn xhsCoverReceiptMatches(receipt,preview,native,proof);`);
  return run(packageFor(ratio, explicit), '/video.mp4', { readFileSync: () => changedBytes ? Buffer.from('different') : bytes }, createHash,
    receipt, preview || basePreview, native || baseNative, proof);
}

function previewFixture(cards) {
  const document = { querySelectorAll: selector => selector === '.cover-plugin-preview .default' ? cards : [] };
  const run = new AsyncFunction('pkg', 'videoPath', 'js', `${helpers}\nreturn readXhsCoverPreview();`);
  return run(packageFor(), '/video.mp4', expression => vm.runInNewContext(expression, { document, getComputedStyle: el => el.style }));
}

test('XHS explicit ratio selects only the corresponding approved asset path', async () => {
  const get = new AsyncFunction('pkg', 'videoPath', `${helpers}\nreturn {ratio:xhsCoverRatio,slot:xhsCoverSlot,path:xhsCoverPath};`);
  for (const [ratio, slot, key] of [['3:4', 'portrait', 'vertical3x4Path'], ['4:3', 'landscape', 'horizontal4x3Path'], ['16:9', 'landscape', 'horizontal16x9Path']]) {
    assert.deepEqual(await get(packageFor(ratio), '/video.mp4'), { ratio, slot, path: paths[key] });
  }
  assert.deepEqual(await get(packageFor('3:4', false), '/video.mp4'), { ratio: '3:4', slot: 'portrait', path: paths.vertical3x4Path });
});

test('XHS accepts explicit portrait, 4:3 and 16:9 only with exact native export and asset hash', async () => {
  for (const ratio of ['3:4', '4:3', '16:9']) assert.equal(await validation({ ratio }), true);
  assert.equal(await validation({ changedBytes: true }), false);
});

test('XHS rejects cropped or swapped native export dimensions even if the receipt claims the desired ratio', async () => {
  for (const wrong of [{ width: 1080, height: 1440 }, { width: 1491, height: 1988 }, { width: 1920, height: 1080 }, { width: 0, height: 0 }]) {
    assert.equal(await validation({ native: { live: { coverFileId: fileid }, liveCover: { fileid, ...wrong } } }), false);
  }
  assert.equal(await validation({ ratio: '3:4', native: { live: { coverFileId: fileid }, liveCover: { fileid, width: 1988, height: 1491 } } }), false);
});

test('XHS rejects wrong slot, native ratio, asset path, file id, local hash and receipt version', async () => {
  for (const change of [{ nativeSlot: 'portrait' }, { nativeRatio: '3:4' }, { ratio: '3:4' }, { assetPath: paths.vertical3x4Path },
    { nativeFileId: 'spectrum/foreign' }, { assetHash: 'f'.repeat(64) }, { version: 1 }, { assetHash: '' }]) {
    assert.equal(await validation({ receipt: { ...receiptFor(), ...change } }), false);
  }
});

test('XHS rejects wrong card direction or mismatched accepted native key', async () => {
  for (const preview of [
    { ok: true, count: 1, direction: 'portrait', bg: `url("${afterUrl}")` },
    { ok: true, count: 2, direction: 'landscape', bg: `url("${afterUrl}")` },
    { ok: false, count: 1, direction: 'landscape', bg: `url("${afterUrl}")` },
    { ok: true, count: 1, direction: 'landscape', bg: 'url("https://ros-preview.xhscdn.com/spectrum/foreign")' },
  ]) assert.equal(await validation({ preview }), false);
  assert.equal(await validation({ native: { live: { coverFileId: 'spectrum/foreign' }, liveCover: { fileid, ...dimensions('4:3') } } }), false);
});

test('XHS legacy receipt compatibility requires actual native 3:4 output, never the uploaded thumbnail', async () => {
  const legacy = { assetPath: paths.vertical3x4Path, ratio: '3:4', afterUrl };
  assert.equal(await validation({ ratio: '3:4', explicit: false, receipt: legacy }), true);
  assert.equal(await validation({ ratio: '3:4', explicit: false, receipt: legacy, native: { live: { coverFileId: fileid }, liveCover: { fileid, ...dimensions('4:3') } } }), false);
  assert.equal(await validation({ ratio: '3:4', explicit: true, receipt: legacy }), false);
});

test('XHS binds saved record cover only when a fresh current-run reopen proof exists', async () => {
  const native = { live: { coverFileId: fileid }, liveCover: { fileid, ...dimensions('4:3') }, record: { id: 'same-draft' }, recordCover: { fileid: 'spectrum/old-cover', ...dimensions('3:4') } };
  assert.equal(await validation({ native }), true);
  const proof = { ok: true, evidence: { draftId: 'same-draft' } };
  assert.equal(await validation({ native, proof }), false);
  native.recordCover = { fileid, ...dimensions('4:3') };
  assert.equal(await validation({ native, proof }), true);
  native.record.id = 'foreign-draft';
  assert.equal(await validation({ native, proof }), false);
});

test('XHS single-card preview excludes the operator and preserves landscape direction', async () => {
  const parent = element({ classes: 'cover--row' });
  const card = element({ classes: 'default row', parent, bg: `url("${afterUrl}")` });
  const operator = element({ classes: 'operator default column', parent, bg: 'url("https://not-a-cover")' });
  const result = await previewFixture([operator, card]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.direction, 'landscape');
  assert.equal(result.bg, card.style.backgroundImage);
});

test('XHS preview fails closed for duplicate cards, hidden cards, ambiguous class and outer-direction mismatch', async () => {
  const make = options => element({ classes: 'default row', bg: `url("${afterUrl}")`, ...options });
  for (const cards of [
    [make(), make()], [make({ visible: false })], [make({ parent: element({ visible: false }) })],
    [make({ classes: 'default row column' })], [make({ parent: element({ classes: 'cover--column' }) })],
  ]) assert.equal((await previewFixture(cards)).ok, false);
});

function editorFixture({ active = '4:3', duplicate = false, hidden = false, options = ['3:4', '4:3', '1:1'], initiallyOpen = true } = {}) {
  let opened = initiallyOpen;
  const modal = element({ classes: 'main-cover-editor-modal', visible: !hidden });
  const crop = element({ classes: 'item', text: '裁剪', parent: modal });
  const ratioOptions = options.map(label => {
    const button = element({ classes: 'ratio-option' + (label === active ? ' active' : ''), parent: modal });
    button.queries['.ratio-label'] = [element({ classes: 'ratio-label', text: label, parent: button })];
    return button;
  });
  const document = { querySelectorAll: selector => selector === '.main-cover-editor-modal' ? (duplicate ? [modal, element({ classes: 'main-cover-editor-modal' })] : [modal]) : [] };
  modal.querySelectorAll = selector => selector === '.items .item' ? [crop] : selector === '.crop-panel .ratio-list button.ratio-option' && opened ? ratioOptions : [];
  const js = expression => vm.runInNewContext(expression, { document, getComputedStyle: el => el.style });
  const clicks = [];
  const click = async selector => {
    clicks.push(selector);
    if (selector === '#vp2-xhs-native-crop') { opened = true; return; }
    const selected = ratioOptions.find(el => '#' + el.id === selector);
    assert.ok(selected);
    ratioOptions.forEach(el => { el.className = 'ratio-option' + (el === selected ? ' active' : ''); });
  };
  const get = new AsyncFunction('pkg', 'videoPath', 'js', `${helpers}\nreturn readXhsCoverEditorRatio();`);
  const select = new AsyncFunction('pkg', 'videoPath', 'js', 'click', 'wait', `${helpers}\nreturn selectXhsCoverNativeRatio();`);
  return { get: () => get(packageFor(), '/video.mp4', js), select: ratio => select(packageFor(ratio), '/video.mp4', js, click, async () => {}), clicks, ratioOptions };
}

test('XHS reads actual native crop panel selection and opens native crop toolbar when necessary', async () => {
  const f = editorFixture({ initiallyOpen: false });
  assert.equal((await f.get()).ok, false);
  const result = await f.select('4:3');
  assert.equal(result.ok, true);
  assert.equal(result.actual, '4:3');
  assert.equal(result.source, 'native-crop-panel');
  assert.deepEqual(f.clicks, ['#vp2-xhs-native-crop']);
});

test('XHS native crop selection changes 4:3 to 3:4 and re-reads the active output ratio', async () => {
  const f = editorFixture();
  assert.equal((await f.select('3:4')).actual, '3:4');
  assert.deepEqual(f.clicks, ['#vp2-xhs-native-ratio']);
});

test('XHS missing 16:9 option, duplicate editor and hidden ratio panel fail closed without accepting thumbnail dimensions', async () => {
  assert.equal((await editorFixture().select('16:9')).ok, false);
  assert.equal((await editorFixture({ duplicate: true }).get()).ok, false);
  assert.equal((await editorFixture({ hidden: true }).get()).ok, false);
  const f = editorFixture();
  f.ratioOptions[0].className = 'ratio-option active';
  assert.equal((await f.get()).ok, false);
});

test('XHS cover flow never infers native output from source-thumbnail natural dimensions', () => {
  assert.doesNotMatch(source, /inferredFromUploadedThumbnail/);
  const flow = source.slice(source.indexOf('async function uploadXhsCover'), source.indexOf('async function ensureXiaohongshuEarlyMetadata'));
  assert.match(flow, /await selectXhsCoverNativeRatio\(\)/);
  assert.match(flow, /current\.gates\.noBlockingDialog\.ok/);
  assert.match(flow, /xhsCoverReceiptMatches\(receipt, preview, nativeDraft\)/);
  assert.match(flow, /nativeFileId: nativeDraft\.liveCover\?\.fileid/);
  assert.match(flow, /assetHash: injection\.assetHash/);
  assert.doesNotMatch(flow, /alreadyUploaded|resume-uploaded-thumbnail/);
});

function inputFixture({ duplicateInput = false, duplicateModal = false, missingModal = false, hiddenModal = false, oldThumbnail = true, staleId = false } = {}) {
  const modal = element({ classes: 'main-cover-editor-modal', visible: !hiddenModal });
  const input = element({ parent: modal }); input.accept = 'image/png,image/jpeg';
  const thumbnail = element({ classes: 'uploaded-thumbnail active', parent: modal });
  const thumbnailImage = element({ classes: 'uploaded-thumbnail-img', parent: thumbnail });
  thumbnailImage.src = 'blob:old-unbound-thumbnail';
  thumbnailImage.naturalWidth = 1080; thumbnailImage.naturalHeight = 1440;
  modal.queries['input[type=file]'] = duplicateInput ? [input, { ...input }] : [input];
  modal.queries['.uploaded-thumbnail'] = oldThumbnail ? [thumbnail] : [];
  modal.queries['.uploaded-thumbnail-img'] = oldThumbnail ? [thumbnailImage] : [];
  const staleInput = element({ visible: false }); staleInput.accept = 'image/png'; if (staleId) staleInput.id = 'vp2-xhs-cover';
  const document = { querySelectorAll: selector => selector === '.main-cover-editor-modal' ? (missingModal ? [] : duplicateModal ? [modal, element({ classes: 'main-cover-editor-modal' })] : [modal])
    : selector.startsWith('#') ? [staleInput, input, thumbnail].filter(el => el.id === selector.slice(1)) : [] };
  const js = expression => vm.runInNewContext(expression, { document, getComputedStyle: el => el.style });
  return { modal, input, thumbnail, thumbnailImage, staleInput, document, js };
}

test('XHS an existing portrait thumbnail plus image input cannot bypass exact landscape file injection', async () => {
  const fixture = inputFixture();
  const uploads = [];
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', `${helpers}\nreturn injectExactXhsCover();`);
  const result = await run(packageFor('4:3'), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async (selector, path) => { uploads.push({ selector, path }); fixture.thumbnailImage.src = 'blob:fresh-exact-file'; });
  assert.equal(result.injected, true);
  assert.equal(result.assetHash, assetHash);
  assert.deepEqual(uploads, [{ selector: '#vp2-xhs-cover', path: paths.horizontal4x3Path }]);
});

test('XHS exact injection rejects duplicate inputs, absent editor, duplicate editor or ancestor-hidden editor', async () => {
  for (const options of [{ duplicateInput: true }, { missingModal: true }, { duplicateModal: true }, { hiddenModal: true }]) {
    const fixture = inputFixture(options);
    let uploads = 0;
    const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', `${helpers}\nreturn injectExactXhsCover();`);
    const result = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js, async () => { uploads += 1; });
    assert.equal(result.ok, false);
    assert.equal(uploads, 0);
  }
});

test('XHS exact injection clears a hidden stale selector id before targeting the active native image input', async () => {
  const fixture = inputFixture({ staleId: true });
  const uploadedTo = [];
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', `${helpers}\nreturn injectExactXhsCover();`);
  const result = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async selector => { uploadedTo.push(...fixture.document.querySelectorAll(selector)); fixture.thumbnailImage.src = 'blob:fresh-exact-file'; });
  assert.equal(result.ok, true);
  assert.equal(fixture.staleInput.id, undefined);
  assert.deepEqual(uploadedTo, [fixture.input]);
});

test('XHS file changed during injection or injection failure cannot produce accepted source hash', async () => {
  const fixture = inputFixture();
  let changed = false;
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', `${helpers}\nreturn injectExactXhsCover();`);
  const changedResult = await run(packageFor(), '/video.mp4', { readFileSync: () => changed ? Buffer.from('changed') : bytes }, createHash, fixture.js,
    async () => { changed = true; });
  assert.equal(changedResult.ok, false);
  assert.equal(changedResult.assetHash, undefined);
  const failed = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async () => { throw new Error('native injection failed'); });
  assert.equal(failed.ok, false);
  assert.equal(failed.assetHash, undefined);
});

test('XHS old portrait thumbnail cannot mint a landscape receipt when fresh exact-file injection fails', async () => {
  const fixture = inputFixture();
  let uploads = 0;
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', 'expectedReceipts', 'removeExactStaleMask', 'wait', `${source}
    inspectXiaohongshu=async()=>({gates:{cover:{ok:false},noBlockingDialog:{ok:true}}});
    readXhsCoverPreview=async()=>({ok:true,count:1,direction:'landscape',bg:'url("https://ros-preview.xhscdn.com/spectrum/old-portrait-cropped")'});
    return uploadXhsCover();`);
  const result = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async () => { uploads += 1; throw new Error('injection unavailable'); }, {}, async () => {}, async () => {});
  assert.equal(uploads, 1);
  assert.equal(result.ok, false);
  assert.equal(result.receipt, undefined);
});

test('XHS accepted matching custom receipt alone may skip exact injection on a no-op cover rerun', async () => {
  let uploads = 0;
  const receipt = receiptFor();
  const run = new AsyncFunction('pkg', 'videoPath', 'expectedReceipts', 'uploadFile', `${source}
    inspectXiaohongshu=async()=>({gates:{cover:{ok:true},noBlockingDialog:{ok:true}}});
    return uploadXhsCover();`);
  const result = await run(packageFor(), '/video.mp4', { cover: receipt }, async () => { uploads += 1; });
  assert.equal(result.already, true);
  assert.equal(result.receipt, receipt);
  assert.equal(uploads, 0);
});

test('XHS confirmation clicks only one exact enabled action in one ancestor-visible native cover editor', async () => {
  const fixture = inputFixture();
  const button = element({ text: '完成', parent: fixture.modal });
  fixture.modal.queries.button = [button];
  const run = new AsyncFunction('pkg', 'videoPath', 'js', `${helpers}\nreturn confirmXhsCoverEditor();`);
  assert.equal((await run(packageFor(), '/video.mp4', fixture.js)).ok, true);
  assert.equal(button.clicks, 1);
  fixture.modal.queries.button.push(element({ text: '确定', parent: fixture.modal }));
  assert.equal((await run(packageFor(), '/video.mp4', fixture.js)).ok, false);
  assert.equal(button.clicks, 1);
  fixture.modal.queries.button = [button]; button.disabled = true;
  assert.equal((await run(packageFor(), '/video.mp4', fixture.js)).ok, false);
  for (const options of [{ duplicateModal: true }, { hiddenModal: true }, { missingModal: true }]) {
    const other = inputFixture(options); other.modal.queries.button = [element({ text: '完成', parent: other.modal })];
    assert.equal((await run(packageFor(), '/video.mp4', other.js)).ok, false);
    assert.equal(other.modal.queries.button[0].clicks, 0);
  }
});

test('XHS uploaded-thumbnail selection rejects duplicate cards or non-unique active native editor', async () => {
  const run = new AsyncFunction('pkg', 'videoPath', 'js', `${helpers}\nreturn selectXhsInjectedCoverThumbnail();`);
  const fixture = inputFixture();
  assert.equal((await run(packageFor(), '/video.mp4', fixture.js)).ok, true);
  fixture.modal.queries['.uploaded-thumbnail'].push(element({ classes: 'uploaded-thumbnail', parent: fixture.modal }));
  assert.equal((await run(packageFor(), '/video.mp4', fixture.js)).ok, false);
  for (const options of [{ duplicateModal: true }, { hiddenModal: true }, { missingModal: true }, { oldThumbnail: false }]) {
    assert.equal((await run(packageFor(), '/video.mp4', inputFixture(options).js)).ok, false);
  }
});

async function coverRevisionMutation({ missing = null, guard = { armed: true, blockedAttempts: 0 }, unknownDialog = false, tagsGate = null } = {}) {
  const gates = Object.fromEntries(['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'noBlockingDialog'].map(key => [key, { ok: true }]));
  if (missing) gates[missing] = { ok: false };
  if (tagsGate) gates.tags = tagsGate;
  if (unknownDialog) gates.noBlockingDialog = { ok: false, evidence: { active: [{ text: 'Other dialog' }] } };
  const writes = [];
  const run = new AsyncFunction('pkg', 'videoPath', 'gates', 'guard', 'writes', `${source}
    const readBrowserCoverRevisionSource=()=>({sourceDraftId:'same-draft'});
    const inspectFinalPublishGuard=async()=>guard;
    const typedBlocker=(code,message,options)=>({code,message,...options});
    inspectXiaohongshu=async()=>({gates});
    ensureXiaohongshuEarlyMetadata=async()=>{writes.push('metadata');return {ok:true,actions:{}}};
    ensureXhsOriginal=async()=>{writes.push('original');return {ok:true}};
    onlyXhsCoverEditorDialogOpen=async()=>false;
    finishXhsCoverMutation=async()=>{writes.push('cover');return {gates,actions:{coverOnly:true}}};
    return mutateXiaohongshu();`);
  return { result: await run(packageFor(), '/video.mp4', gates, guard, writes), writes };
}

test('XHS cover-only revision rejects every unrelated-field drift without metadata, rights or cover writes', async () => {
  for (const missing of ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original']) {
    const result = await coverRevisionMutation({ missing });
    assert.equal(result.result.blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(result.writes, []);
  }
  for (const options of [{ guard: { armed: false, blockedAttempts: 0 } }, { guard: { armed: true, blockedAttempts: 1 } }, { unknownDialog: true }]) {
    const result = await coverRevisionMutation(options);
    assert.equal(result.result.blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(result.writes, []);
  }
});

test('XHS valid cover-only revision executes cover action only and does not repair metadata or originality', async () => {
  const result = await coverRevisionMutation();
  assert.deepEqual(result.writes, ['cover']);
  assert.equal(result.result.actions.coverOnly, true);
});

async function inspectTopicGate(requestedTopics, actualTopics) {
  const anchors = actualTopics.map(name => ({ getAttribute: attr => attr === 'data-topic' ? JSON.stringify({ name }) : null }));
  const editor = element({ classes: 'creator-editor', text: 'Approved body' });
  editor.queries.a = anchors;
  editor.cloneNode = () => ({ textContent: 'Approved body', querySelectorAll: () => [] });
  const title = element(); title.placeholder = '填写标题'; title.value = 'Approved';
  const document = {
    body: { innerText: 'video.mp4 重新上传' },
    querySelectorAll: selector => selector === 'input' ? [title] : selector.includes('contenteditable') ? [editor] : [],
    querySelector: () => null,
    createTextNode: () => ({}),
  };
  const js = expression => vm.runInNewContext(expression, { document, getComputedStyle: el => el.style });
  const run = new AsyncFunction('pkg', 'videoPath', 'js', 'semanticButtons', 'readXhsRestoredIdentity', 'readXhsNativeDraft', 'expectedReceipts', 'okGate', 'failedGate', 'PLATFORM_URLS', `${source}
    readXhsCoverPreview=async()=>({ok:true,count:1,direction:'portrait',bg:''});
    return (await inspectXiaohongshu()).gates.tags;`);
  return run({ ...packageFor(), xhsTopics: requestedTopics, xhsDescription: 'Approved body' }, '/video.mp4', js,
    async () => [], async () => ({ ok: false, existingDraft: false }), async () => ({ live: {} }), {},
    evidence => ({ ok: true, evidence }), evidence => ({ ok: false, evidence }), { xiaohongshu: 'https://creator.xiaohongshu.com' });
}

test('XHS extra real topic anchors fail the actual inspection gate and block cover-only mutation without writes', async () => {
  assert.equal((await inspectTopicGate(['AI工具'], ['AI工具'])).ok, true);
  const gate = await inspectTopicGate(['AI工具'], ['AI工具', '额外话题']);
  assert.equal(gate.ok, false);
  assert.equal(gate.evidence.topicAnchorCount, 2);
  assert.deepEqual(Array.from(gate.evidence.unexpected), ['额外话题']);
  const mutation = await coverRevisionMutation({ tagsGate: gate });
  assert.equal(mutation.result.blocker.code, 'STATE_AMBIGUOUS');
  assert.deepEqual(mutation.writes, []);
  const noRequested = await inspectTopicGate([], ['额外话题']);
  assert.equal(noRequested.ok, false);
});

test('XHS old visible thumbnail persisting after successful file injection cannot produce a receipt or confirmation', async () => {
  const fixture = inputFixture();
  let uploads = 0, confirms = 0;
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', 'expectedReceipts', 'removeExactStaleMask', 'wait', 'confirmCounter', `${source}
    inspectXiaohongshu=async()=>({gates:{cover:{ok:false},noBlockingDialog:{ok:true}}});
    readXhsCoverPreview=async()=>({ok:true,count:1,direction:'landscape',bg:'url("https://ros-preview.xhscdn.com/spectrum/old-portrait-cropped")'});
    confirmXhsCoverEditor=async()=>{confirmCounter();return {ok:true}};
    return uploadXhsCover();`);
  const result = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async () => { uploads += 1; }, {}, async () => {}, async () => {}, () => { confirms += 1; });
  assert.equal(uploads, 1);
  assert.equal(result.ok, false);
  assert.equal(result.receipt, undefined);
  assert.equal(confirms, 0);
});

test('XHS fresh thumbnail still loading cannot prove exact injection completion', async () => {
  const fixture = inputFixture();
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'createHash', 'js', 'uploadFile', 'wait', `${helpers}\nreturn injectExactXhsCover();`);
  const result = await run(packageFor(), '/video.mp4', { readFileSync: () => bytes }, createHash, fixture.js,
    async () => { fixture.thumbnailImage.src = 'blob:fresh-exact-file'; fixture.modal.innerText = '封面上传中'; }, async () => {});
  assert.equal(result.ok, false);
  assert.equal(result.assetHash, undefined);
});
