const draftPersistenceContract = { idKeys: [], saveLabels: ['暂存离开'], listLabels: ['草稿箱'], storageScope: 'browser-local' };
const inspectPersistedPlatform = () => inspectXiaohongshu();
const xhsTitle = pkg.platformTitle.xiaohongshu;
const xhsTopics = pkg.xhsTopics;
// Older release packages already bind one identical approved body for these platforms.
const sharedReleaseBody = pkg.douyinDescription && pkg.douyinDescription === pkg.bilibiliDescription
  && pkg.douyinDescription === pkg.youtubeDescription ? pkg.douyinDescription : '';
const xhsDescription = String(pkg.xhsDescription ?? (pkg.description || sharedReleaseBody)).replace(/\r\n?/g, '\n').trim();
const xhsVideoName = videoPath.split('/').pop();
const xhsCustomCover = pkg.cover?.uploadCustomCover === true;
const xhsCoverRatio = String(pkg.cover?.nativeRatio || '3:4');
const xhsCoverSlot = xhsCoverRatio === '3:4' ? 'portrait' : 'landscape';
const xhsCoverPath = String(pkg.cover?.[({ '3:4': 'vertical3x4Path', '4:3': 'horizontal4x3Path', '16:9': 'horizontal16x9Path' })[xhsCoverRatio]] || '');
const xhsCoverObjectKey = value => String(value || '').match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '';
const xhsCoverRatioMatches = cover => {
  const [width, height] = xhsCoverRatio.split(':').map(Number);
  return Number(cover?.width) > 0 && Number(cover?.height) > 0
    && Math.abs(Number(cover.width) / Number(cover.height) - width / height) < 0.01;
};
const xhsLocalCoverHash = () => {
  try { return createHash('sha256').update(fs.readFileSync(xhsCoverPath)).digest('hex'); }
  catch { return ''; }
};

function xhsCoverHeaderDimensions(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff ? { width, height, format: 'png' } : null;
  }
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const size = bytes.readUInt32LE(4);
  if (size < 4 || size > 0xfffffff6 || size % 2 || size + 8 !== bytes.length) return null;
  let canvas = null, image = null;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return null;
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + length % 2;
    if (next > bytes.length || (length % 2 && bytes[end] !== 0)) return null;
    let dimensions = null;
    if (type === 'VP8X') {
      if (length < 10 || canvas) return null;
      canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1, format: 'webp' };
      if (canvas.width * canvas.height > 0xffffffff) return null;
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[start] & 1) || ((bytes[start] >> 1) & 7) > 3
        || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) return null;
      dimensions = { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff, format: 'webp' };
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) return null;
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (dimensions) {
      if (image || !dimensions.width || !dimensions.height) return null;
      image = dimensions;
    }
    offset = next;
  }
  if (canvas && image && (canvas.width !== image.width || canvas.height !== image.height)) return null;
  return canvas || image;
}

function readXhsCoverTransport() {
  const manifestPath = String(typeof xhsCoverTransportManifestPath !== 'undefined' ? xhsCoverTransportManifestPath
    : typeof process !== 'undefined' ? process.env?.VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST || '' : '');
  if (!manifestPath) return { ok: true, uploadPath: xhsCoverPath, transport: null };
  try {
    if (!path.isAbsolute(manifestPath)) throw new Error('transport manifest path must be absolute');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!manifest || Array.isArray(manifest) || manifest.version !== 1
      || manifest.sourcePath !== xhsCoverPath || !path.isAbsolute(manifest.sourcePath)
      || typeof manifest.transportPath !== 'string' || !path.isAbsolute(manifest.transportPath)
      || manifest.transportPath === manifest.sourcePath || manifest.pixelMode !== 'RGBA'
      || manifest.conversion !== 'lossless-png' || manifest.reason !== 'xiaohongshu-native-webp-rejection'
      || !['sourceSha256', 'transportSha256', 'sourcePixelSha256', 'transportPixelSha256'].every(key => isHash(manifest[key]))
      || manifest.sourcePixelSha256 !== manifest.transportPixelSha256
      || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height)
      || manifest.width <= 0 || manifest.height <= 0) throw new Error('transport manifest binding is invalid');
    const sourceBytes = fs.readFileSync(manifest.sourcePath), transportBytes = fs.readFileSync(manifest.transportPath);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    if (hash(sourceBytes) !== manifest.sourceSha256 || hash(transportBytes) !== manifest.transportSha256) throw new Error('transport source or PNG bytes changed');
    const source = xhsCoverHeaderDimensions(sourceBytes), transport = xhsCoverHeaderDimensions(transportBytes);
    const [ratioWidth, ratioHeight] = xhsCoverRatio.split(':').map(Number);
    if (source?.format !== 'webp' || transport?.format !== 'png'
      || source.width !== manifest.width || source.height !== manifest.height
      || transport.width !== manifest.width || transport.height !== manifest.height
      || manifest.width * ratioHeight !== manifest.height * ratioWidth) throw new Error('transport source/PNG dimensions or native ratio do not match');
    // Pixel equality is attested by the explicit local conversion manifest;
    // this transport layer rebinds both original files and every attested field.
    const receipt = { version: 1, manifestPath, manifestSha256: hash(manifestBytes) };
    for (const key of ['sourcePath', 'sourceSha256', 'transportPath', 'transportSha256', 'width', 'height',
      'pixelMode', 'sourcePixelSha256', 'transportPixelSha256', 'conversion', 'reason']) receipt[key] = manifest[key];
    return { ok: true, uploadPath: manifest.transportPath, transport: receipt };
  } catch (error) {
    return { ok: false, reason: `xiaohongshu explicit cover transport invalid: ${String(error?.message || error)}` };
  }
}

function xhsCoverTransportMatches(expected) {
  const current = readXhsCoverTransport();
  if (!current.ok) return false;
  if (!expected) return current.transport === null;
  return current.transport !== null && Object.keys(expected).length === Object.keys(current.transport).length
    && Object.entries(current.transport).every(([key, value]) => expected[key] === value);
}

async function readXhsCoverPreview() {
  return await js(String.raw`(() => {
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    // The .operator.default.column control is not a second cover slot. Require
    // exactly one actual visible native card, regardless of its orientation.
    const cards=[...document.querySelectorAll('.cover-plugin-preview .default')]
      .filter(el=>visible(el)&&!el.closest('.operator')&&getComputedStyle(el).backgroundImage!=='none'&&Boolean(getComputedStyle(el).backgroundImage))
    if(cards.length!==1)return {ok:false,count:cards.length,bg:'',direction:null}
    const card=cards[0],tokens=String(card.className||'').split(/\s+/)
    const direction=tokens.includes('row')&&!tokens.includes('column')?'landscape':tokens.includes('column')&&!tokens.includes('row')?'portrait':null
    const container=card.closest('.cover--row,.cover--column')
    const outerTokens=String(container?.className||'').split(/\s+/)
    const outerDirection=outerTokens.includes('cover--row')?'landscape':outerTokens.includes('cover--column')?'portrait':null
    return {ok:!!direction&&(!outerDirection||outerDirection===direction),count:1,bg:getComputedStyle(card).backgroundImage,direction,outerDirection}
  })()`);
}

function xhsCoverReceiptMatches(receipt, preview, nativeDraft, persistenceProof = null) {
  const acceptedKey = xhsCoverObjectKey(receipt?.afterUrl);
  const liveCover = nativeDraft?.liveCover;
  if (!receipt || receipt.assetPath !== xhsCoverPath || receipt.ratio !== xhsCoverRatio
    || !acceptedKey || !preview?.ok || preview.count !== 1 || preview.direction !== xhsCoverSlot
    || xhsCoverObjectKey(preview.bg) !== acceptedKey || !xhsCoverRatioMatches(liveCover)
    || xhsCoverObjectKey(liveCover?.fileid) !== acceptedKey
    || xhsCoverObjectKey(nativeDraft.live?.coverFileId) !== acceptedKey) return false;
  const explicitTransport = typeof xhsCoverTransportManifestPath !== 'undefined' ? xhsCoverTransportManifestPath
    : typeof process !== 'undefined' && process.env?.VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST;
  if ((receipt.transport || explicitTransport) && !xhsCoverTransportMatches(receipt.transport || null)) return false;
  if (pkg.cover?.nativeRatio || receipt.version === 2 || receipt.transport) {
    if (receipt.version !== 2 || receipt.nativeSlot !== xhsCoverSlot || receipt.nativeRatio !== xhsCoverRatio
      || receipt.nativeFileId !== liveCover.fileid || !/^[a-f0-9]{64}$/.test(receipt.assetHash || '')
      || receipt.assetHash !== xhsLocalCoverHash()) return false;
  }
  // Before save, an existing record may still contain the old cover. Bind its
  // exported dimensions and object key only after a current-run reopen proof.
  if (persistenceProof?.ok) {
    const recordCover = nativeDraft.recordCover;
    if (!xhsCoverRatioMatches(recordCover) || xhsCoverObjectKey(recordCover?.fileid) !== acceptedKey
      || nativeDraft.record?.id !== persistenceProof.evidence?.draftId) return false;
  }
  return true;
}

async function readXhsCoverEditorRatio() {
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu native cover editor missing or ambiguous',count:modals.length}
    const modal=modals[0],selectors=[...modal.querySelectorAll('.ratio-select')].filter(visible)
    if(selectors.length===1){const actual=compact(selectors[0].innerText||selectors[0].textContent);return /^(3:4|4:3|16:9)$/.test(actual)?{ok:true,actual,source:'native-ratio-select'}:{ok:false,actual,reason:'unknown native cover crop ratio'}}
    if(selectors.length>1)return {ok:false,reason:'xiaohongshu native cover ratio selector ambiguous'}
    const cropOptions=[...modal.querySelectorAll('.crop-panel .ratio-list button.ratio-option')].filter(visible)
    if(cropOptions.length){const selected=cropOptions.filter(el=>String(el.className||'').split(/\s+/).includes('active'));if(selected.length!==1)return {ok:false,reason:'xiaohongshu selected native cover ratio is ambiguous'};const actual=compact(selected[0].querySelector('.ratio-label')?.innerText||selected[0].querySelector('.ratio-label')?.textContent);return /^(3:4|4:3|1:1)$/.test(actual)?{ok:true,actual,source:'native-crop-panel'}:{ok:false,actual,reason:'unknown selected native crop panel ratio'}}
    const selected=[...modal.querySelectorAll('.crop-ratio-item')].filter(el=>visible(el)&&String(el.className||'').split(/\s+/).some(token=>['active','selected','checked'].includes(token)))
    if(selected.length===1){const actual=compact(selected[0].innerText||selected[0].textContent);return /^(3:4|4:3|16:9)$/.test(actual)?{ok:true,actual,source:'native-crop-ratio-item'}:{ok:false,actual,reason:'unknown selected native cover crop ratio'}}
    return {ok:false,reason:'xiaohongshu native cover crop ratio is not exposed'}
  })()`);
}

async function readXhsCoverEditorMode(prepareEdit = false) {
  return await js(String.raw`((prepareEdit) => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu cover mode editor missing or ambiguous',count:modals.length}
    const switches=[...modals[0].querySelectorAll('.video-panel-switch-item')]
    if(!switches.length)return {ok:true,legacy:true}
    const visibleSwitches=switches.filter(visible),controls=visibleSwitches.filter(el=>el.tagName==='BUTTON')
    const active=el=>String(el.className||'').split(/\s+/).includes('active')
    const edits=controls.filter(el=>compact(el.innerText||el.textContent)==='编辑')
    const previews=controls.filter(el=>compact(el.innerText||el.textContent)==='预览')
    const selected=controls.filter(active)
    if(controls.length!==2||visibleSwitches.length!==controls.length||edits.length!==1||previews.length!==1||selected.length!==1)
      return {ok:false,reason:'xiaohongshu native cover edit/preview mode missing or ambiguous',visibleSwitchCount:controls.length,activeCount:selected.length}
    if(selected[0]===edits[0])return {ok:true,legacy:false,mode:'edit'}
    if(selected[0]!==previews[0]||edits[0].disabled||edits[0].getAttribute('aria-disabled')==='true')
      return {ok:false,reason:'xiaohongshu native cover edit mode control is unavailable'}
    if(!prepareEdit)return {ok:true,legacy:false,mode:'preview'}
    document.querySelectorAll('#vp2-xhs-native-cover-edit').forEach(el=>el.removeAttribute('id'))
    edits[0].id='vp2-xhs-native-cover-edit'
    return {ok:true,legacy:false,mode:'preview',selector:'#vp2-xhs-native-cover-edit'}
  })(${JSON.stringify(prepareEdit)})`);
}

async function ensureXhsCoverEditorEditMode() {
  const mode = await readXhsCoverEditorMode(true);
  if (!mode.ok || mode.legacy || mode.mode === 'edit') return mode;
  try { await click(mode.selector, { label: 'activate xhs native cover edit mode' }); }
  catch (error) { return { ok: false, reason: `xiaohongshu native cover edit mode failed: ${String(error?.message || error)}` }; }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readXhsCoverEditorMode();
    if (!current.ok) return current;
    if (!current.legacy && current.mode === 'edit') return { ...current, changed: true };
    await wait(0.25);
  }
  return { ok: false, reason: 'xiaohongshu native cover edit mode did not become active' };
}

async function selectXhsCoverNativeRatio() {
  const editMode = await ensureXhsCoverEditorEditMode();
  if (!editMode.ok) return editMode;
  let current = await readXhsCoverEditorRatio();
  if (!current.ok) {
    const crop = await js(String.raw`(() => {
      const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
      const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
      if(modals.length!==1)return {ok:false,reason:'xiaohongshu crop editor missing or ambiguous'}
      const matching=[...modals[0].querySelectorAll('.items .item')].filter(el=>visible(el)&&compact(el.innerText||el.textContent)==='裁剪'&&!el.disabled)
      if(matching.length!==1)return {ok:false,reason:'xiaohongshu native crop toolbar missing or ambiguous'}
      document.querySelectorAll('#vp2-xhs-native-crop').forEach(el=>el.removeAttribute('id'))
      matching[0].id='vp2-xhs-native-crop';return {ok:true,selector:'#vp2-xhs-native-crop'}
    })()`);
    if (!crop.ok) return { ...crop, nativeRatio: current };
    try { await click(crop.selector, { label: 'activate xhs native crop toolbar' }); }
    catch (error) { return { ok: false, reason: `xiaohongshu native crop toolbar failed: ${String(error?.message || error)}` }; }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      current = await readXhsCoverEditorRatio();
      if (current.ok) break;
      await wait(0.5);
    }
  }
  if (!current.ok) return current;
  if (current.actual === xhsCoverRatio) return { ...current, already: true };
  const control = await js(String.raw`((desired) => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu native ratio editor missing or ambiguous'}
    const selectors=[...modals[0].querySelectorAll('.ratio-select')].filter(visible)
    if(selectors.length===1){document.querySelectorAll('#vp2-xhs-ratio-select').forEach(el=>el.removeAttribute('id'));selectors[0].id='vp2-xhs-ratio-select';return {ok:true,menu:true,selector:'#vp2-xhs-ratio-select'}}
    const nativeOptions=[...modals[0].querySelectorAll('.crop-panel .ratio-list button.ratio-option')].filter(el=>visible(el)&&compact(el.querySelector('.ratio-label')?.innerText||el.querySelector('.ratio-label')?.textContent)===desired&&!el.disabled)
    if(nativeOptions.length===1){document.querySelectorAll('#vp2-xhs-native-ratio').forEach(el=>el.removeAttribute('id'));nativeOptions[0].id='vp2-xhs-native-ratio';return {ok:true,selector:'#vp2-xhs-native-ratio'}}
    if(nativeOptions.length>1)return {ok:false,reason:'xiaohongshu requested native crop panel ratio is ambiguous'}
    const options=[...modals[0].querySelectorAll('.crop-ratio-item')].filter(el=>visible(el)&&compact(el.innerText||el.textContent)===desired)
    if(options.length!==1)return {ok:false,reason:'xiaohongshu requested native ratio missing or ambiguous'}
    document.querySelectorAll('#vp2-xhs-native-ratio').forEach(el=>el.removeAttribute('id'))
    options[0].id='vp2-xhs-native-ratio';return {ok:true,selector:'#vp2-xhs-native-ratio'}
  })(${JSON.stringify(xhsCoverRatio)})`);
  if (!control.ok) return control;
  try { await click(control.selector, { label: `select xhs native cover ratio ${xhsCoverRatio}` }); }
  catch (error) { return { ok: false, reason: `xiaohongshu native ratio control failed: ${String(error?.message || error)}` }; }
  if (control.menu) {
    await wait(0.5);
    const option = await js(String.raw`((desired) => {
      const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
      const options=[...document.querySelectorAll('.ratio-select-menu .ratio-item')].filter(el=>visible(el)&&compact(el.innerText||el.textContent)===desired)
      if(options.length!==1)return {ok:false,reason:'xiaohongshu requested native ratio option missing or ambiguous'}
      document.querySelectorAll('#vp2-xhs-native-ratio').forEach(el=>el.removeAttribute('id'))
      options[0].id='vp2-xhs-native-ratio';return {ok:true,selector:'#vp2-xhs-native-ratio'}
    })(${JSON.stringify(xhsCoverRatio)})`);
    if (!option.ok) return option;
    try { await click(option.selector, { label: `select xhs native cover ratio ${xhsCoverRatio}` }); }
    catch (error) { return { ok: false, reason: `xiaohongshu native ratio option failed: ${String(error?.message || error)}` }; }
  }
  await wait(0.5);
  const after = await readXhsCoverEditorRatio();
  return after.ok && after.actual === xhsCoverRatio ? after
    : { ok: false, reason: 'xiaohongshu requested native cover ratio did not persist', expected: xhsCoverRatio, actual: after };
}

async function exposeXhsCoverImageInput() {
  return await js(String.raw`(() => {
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu active native cover editor missing or ambiguous',modalCount:modals.length}
    const inputs=[...modals[0].querySelectorAll('input[type=file]')].filter(el=>/image|png|jpe?g/i.test(el.accept||'')&&!el.disabled)
    if(inputs.length!==1)return {ok:false,reason:'xiaohongshu active native cover image input missing or ambiguous',imageInputCount:inputs.length}
    document.querySelectorAll('#vp2-xhs-cover').forEach(el=>el.removeAttribute('id'))
    inputs[0].id='vp2-xhs-cover';return {ok:true,selector:'#vp2-xhs-cover',accept:inputs[0].accept||''}
  })()`);
}

async function injectExactXhsCover() {
  const transport = readXhsCoverTransport();
  if (!transport.ok) return transport;
  const exposed = await exposeXhsCoverImageInput();
  if (!exposed.ok) return exposed;
  const beforeThumbnail = await readXhsUploadedCoverThumbnail();
  if (beforeThumbnail.ambiguous) return { ok: false, reason: 'xiaohongshu unbound cover thumbnail is ambiguous', beforeThumbnail };
  const assetHash = xhsLocalCoverHash();
  if (!/^[a-f0-9]{64}$/.test(assetHash)) return { ok: false, reason: 'xiaohongshu exact cover file cannot be hashed' };
  if ((transport.transport && transport.transport.sourceSha256 !== assetHash) || !xhsCoverTransportMatches(transport.transport)) {
    return { ok: false, reason: 'xiaohongshu explicit cover transport changed before injection' };
  }
  // An existing uploaded thumbnail is unbound. Only an accepted matching
  // receipt may skip this exact-file injection; dimensions are not provenance.
  try { await uploadFile(exposed.selector, transport.uploadPath); }
  catch (error) { return { ok: false, reason: String(error?.message || error) }; }
  if (xhsLocalCoverHash() !== assetHash) return { ok: false, reason: 'xiaohongshu exact cover file changed during injection' };
  if (!xhsCoverTransportMatches(transport.transport)) return { ok: false, reason: 'xiaohongshu explicit cover transport changed during injection' };
  let thumbnail = null;
  // A decoded blob is only a local preview. Slow native uploads observed in
  // production may need more than 20 seconds to replace it with the server
  // thumbnail; keep the same injection and await that real completion signal.
  for (let attempt = 0; attempt < 240; attempt += 1) {
    thumbnail = await readXhsUploadedCoverThumbnail();
    if (thumbnail.ambiguous) return { ok: false, reason: 'xiaohongshu fresh cover thumbnail is ambiguous', thumbnail };
    if (thumbnail.loaded && !thumbnail.pending && thumbnail.src && thumbnail.src !== beforeThumbnail.src) {
      if (xhsLocalCoverHash() !== assetHash) return { ok: false, reason: 'xiaohongshu exact cover file changed while awaiting upload completion' };
      if (!xhsCoverTransportMatches(transport.transport)) return { ok: false, reason: 'xiaohongshu explicit cover transport changed while awaiting upload completion' };
      return { ok: true, injected: true, assetPath: xhsCoverPath, assetHash, thumbnailSource: thumbnail.src,
        ...(transport.transport ? { transport: transport.transport } : {}) };
    }
    await wait(0.5);
  }
  return { ok: false, reason: 'xiaohongshu fresh exact-file thumbnail did not replace the unbound image', beforeThumbnail, thumbnail };
}

async function readXhsUploadedCoverThumbnail() {
  return await js(String.raw`(() => {
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ambiguous:true,loaded:false,reason:'native cover editor missing or ambiguous'}
    const modal=modals[0],images=[...modal.querySelectorAll('.uploaded-thumbnail-img')].filter(visible)
    if(images.length>1)return {ambiguous:true,loaded:false,reason:'native uploaded cover thumbnail is ambiguous'}
    const image=images[0]
    const pending=/封面上传中|正在上传|上传中|处理中/.test(String(modal.innerText||modal.textContent||''))||[...modal.querySelectorAll('[aria-busy="true"],.uploaded-thumbnail-loading,.upload-progress')].some(visible)
    return {ambiguous:false,loaded:!!image&&image.naturalWidth>0&&image.naturalHeight>0&&image.complete!==false,src:image?.src||image?.getAttribute?.('src')||'',pending}
  })()`);
}

async function selectXhsInjectedCoverThumbnail(expectedSource = null) {
  return await js(String.raw`((expectedSource) => {
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu uploaded thumbnail editor missing or ambiguous'}
    if(expectedSource){const images=[...modals[0].querySelectorAll('.uploaded-thumbnail-img')].filter(visible);if(images.length!==1||String(images[0].src||images[0].getAttribute?.('src')||'')!==expectedSource||images[0].naturalWidth<=0||images[0].naturalHeight<=0||images[0].complete===false)return {ok:false,reason:'xiaohongshu exact injected thumbnail changed before selection'}}
    const buttons=[...modals[0].querySelectorAll('.uploaded-thumbnail')].filter(visible)
    if(buttons.length!==1)return {ok:false,reason:'xiaohongshu injected cover thumbnail missing or ambiguous',thumbnailCount:buttons.length}
    const button=buttons[0]
    if(String(button.className||'').split(/\s+/).some(token=>['active','selected','checked'].includes(token)))return {ok:true,already:true}
    document.querySelectorAll('#vp2-xhs-uploaded-cover-selection').forEach(el=>el.removeAttribute('id'))
    button.id='vp2-xhs-uploaded-cover-selection';return {ok:true,selector:'#vp2-xhs-uploaded-cover-selection'}
  })(${JSON.stringify(expectedSource)})`);
}

async function confirmXhsCoverEditor() {
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(modals.length!==1)return {ok:false,reason:'xiaohongshu cover confirmation editor missing or ambiguous'}
    const buttons=[...modals[0].querySelectorAll('button')].filter(el=>/^(确定|完成)$/.test(compact(el.innerText||el.textContent))&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true'&&visible(el))
    if(buttons.length!==1)return {ok:false,reason:'xiaohongshu cover confirm missing, disabled or ambiguous',buttonCount:buttons.length}
    buttons[0].click();return {ok:true}
  })()`);
}

async function onlyXhsCoverEditorDialogOpen() {
  return await js(String.raw`(() => {
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
    const editors=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
    if(editors.length!==1)return false
    const dialogs=[...document.querySelectorAll('.d-modal-mask,[role="dialog"],[class*="modal-mask"]')].filter(el=>visible(el)&&!/leave-active/.test(String(el.className||'')))
    return dialogs.length>0&&dialogs.every(el=>el===editors[0]||el.contains(editors[0])||editors[0].contains(el))
  })()`);
}

async function inspectXiaohongshu() {
  const state = await js(String.raw`((expectedName, expectedTitle, requestedTopics, expectedDescription) => {
    const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
    const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden' }
    const text = compact(document.body.innerText || '')
    const titleInput = [...document.querySelectorAll('input')]
      .find(el => (el.placeholder || '').includes('填写标题'))
    const title = String(titleInput?.value || '').trim()
    const editors = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')]
    const editor = editors.find(el => el.querySelector('a') || /话题|creator-editor/i.test(String(el.className || ''))) || editors[0]
    const editorText = compact(editor?.innerText || editor?.textContent || '')
    const anchorNames = [...(editor?.querySelectorAll('a') || [])].map(el => {
      try { return String(JSON.parse(el.getAttribute('data-topic') || '{}').name || '').trim() }
      catch { return compact(el.innerText || el.textContent || '').replace(/^#|\[话题\]#.*$/g, '') }
    }).filter(Boolean)
    const plainClone = editor?.cloneNode(true)
    plainClone?.querySelectorAll('a').forEach(el => el.remove())
    // Detached clones lose rendered paragraph separators; preserve those boundaries explicitly.
    plainClone?.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')))
    plainClone?.querySelectorAll('p,div').forEach(el => el.append(document.createTextNode('\n')))
    const plainText = compact(plainClone?.textContent || '')
    const topicCounts = Object.fromEntries(requestedTopics.map(tag => {
      const normalized = String(tag).replace(/\s+/g, '').toLowerCase()
      const count = anchorNames.filter(value => String(value).replace(/\s+/g, '').toLowerCase() === normalized).length
      return [tag, count]
    }))
    const selected = requestedTopics.filter(tag => topicCounts[tag] === 1)
    const requestedTopicNames = new Set(requestedTopics.map(tag => String(tag).replace(/\s+/g, '').toLowerCase()))
    const unexpected = anchorNames.filter(name => !requestedTopicNames.has(String(name).replace(/\s+/g, '').toLowerCase()))
    const plainCompact = plainText.replace(/\s+/g, '').toLowerCase()
    const plainResidue = requestedTopics.filter(tag => plainCompact.includes('#' + String(tag).replace(/\s+/g, '').toLowerCase()))
    const duplicate = requestedTopics.filter(tag => topicCounts[tag] > 1)
    const originalLabels = [...document.querySelectorAll('div,section,label,span')]
      .filter(el => compact(el.innerText || el.textContent || '') === '原创声明')
      .sort((a,b) => { const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(); return ar.width*ar.height-br.width*br.height })
    const originalLabel = originalLabels[0] || null
    const originalAncestors = []; for(let el=originalLabel;el&&originalAncestors.length<8;el=el.parentElement)originalAncestors.push(el)
    const originalSelectors = '.custom-switch-switch, .d-switch, [role="switch"], input[type="checkbox"]'
    const originalRow = originalAncestors.find(el => el.matches?.(originalSelectors) || el.querySelector?.(originalSelectors))
      || originalAncestors.find(el => { const s=getComputedStyle(el); return compact(el.innerText||el.textContent||'')==='原创声明' && (parseFloat(s.borderRadius)>0 || s.backgroundColor!=='rgba(0, 0, 0, 0)') })
      || originalLabel?.parentElement
    const originalSwitch = (originalRow?.matches?.(originalSelectors) ? originalRow : originalRow?.querySelector(originalSelectors))
      || [...document.querySelectorAll('.custom-switch-switch, .d-switch, [role="switch"]')]
        .find(el => /原创声明/.test(el.parentElement?.parentElement?.innerText || ''))
    const simulator = originalSwitch?.querySelector?.('.d-switch-simulator') || originalSwitch?.parentElement?.querySelector?.('.d-switch-simulator')
    const originalInput = originalSwitch?.matches?.('input[type="checkbox"]')
      ? originalSwitch
      : originalSwitch?.querySelector?.('input[type="checkbox"]') || simulator?.querySelector?.('input[type="checkbox"]')
    const switchTokens = String(originalSwitch?.className || '').split(/\s+/).filter(Boolean)
    const simulatorTokens = String(simulator?.className || '').split(/\s+/).filter(Boolean)
    const originalEnabled = Boolean(originalSwitch && (
      originalInput?.checked === true
      || originalSwitch.getAttribute?.('aria-checked') === 'true'
      || originalSwitch.getAttribute?.('data-state') === 'checked'
      || switchTokens.some(token => ['checked', 'active', 'open', 'enabled'].includes(token))
      || simulatorTokens.some(token => ['checked', 'active', 'open', 'enabled'].includes(token))
    ))
    const activeDialogs = [...document.querySelectorAll('.d-modal-mask, [role="dialog"], [class*="modal-mask"]')]
      .map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { text: compact(el.innerText || el.textContent || ''), cls: String(el.className || ''), width: r.width, height: r.height, opacity: s.opacity, display: s.display, visibility: s.visibility } })
      .filter(item => item.width > 20 && item.height > 20 && item.display !== 'none' && item.visibility !== 'hidden')
      .filter(item => !/leave-active/.test(item.cls))
    const filenameVisible = text.includes(expectedName) || text.includes(expectedName.replace(/\.[^.]+$/, ''))
    const uploaded = filenameVisible && /重新上传|上传完成|检测为高清视频/.test(text)
    const uploading = /封面上传中|视频上传中|取消上传|剩余时间|当前速度|处理中/.test(text)
    const failed = /上传失败|网络错误|重新上传失败/.test(text)
    const loginRequired = /扫码登录|请登录|登录后|安全验证|验证码/.test(text) && !/发布笔记|内容设置/.test(text)
    const topicButton = document.querySelector('button.contentBtn.topic-btn, #topicBtn')
    const earlyMutation = {
      ready: Boolean(visible(titleInput) && visible(editor) && visible(topicButton)),
      uploading,
      uploaded,
      controls: { title: visible(titleInput), topics: visible(editor) && visible(topicButton) },
    }
    const descriptionOk=plainText===compact(expectedDescription)
    return { text: text.slice(0, 2600), title, editorText, plainText, descriptionOk, selected, topicCounts, topicAnchorCount: anchorNames.length, unexpected, plainResidue, duplicate, originalEnabled, activeDialogs, filenameVisible, uploaded, uploading, failed, loginRequired, earlyMutation }
  })(${JSON.stringify(xhsVideoName)}, ${JSON.stringify(xhsTitle)}, ${JSON.stringify(xhsTopics)}, ${JSON.stringify(xhsDescription)})`);
  // The actual submit button is inside the platform's closed custom element.
  const buttons = (await semanticButtons(/^发布$/)).filter(button => button.hostTag === 'XHS-PUBLISH-BTN');
  const restoredIdentity = await readXhsRestoredIdentity();
  const nativeDraft = await readXhsNativeDraft();
  const preview = await readXhsCoverPreview();
  const persistenceProof = typeof readXhsPersistenceProof === 'function' ? await readXhsPersistenceProof() : null;
  state.coverBg = preview.bg;
  if (restoredIdentity.ok && /重新上传|检测为高清视频/.test(state.text) && !state.uploading && !state.failed) state.uploaded = true;
  const identityOk = restoredIdentity.existingDraft ? restoredIdentity.ok : (!state.uploaded || state.filenameVisible);
  const receipt = expectedReceipts.cover || null;
  const receiptMatches = xhsCoverReceiptMatches(receipt, preview, nativeDraft, persistenceProof);
  const coverOk = xhsCustomCover
    ? receiptMatches && !state.uploading
    : preview.ok && Boolean(state.coverBg) && !state.uploading;
  const finalButton = buttons.length === 1 ? buttons[0] : null;
  const observation={
    gates: {
      authenticated: state.loginRequired ? failedGate({ loginRequired: true }) : okGate({ url: PLATFORM_URLS.xiaohongshu }),
      draftIdentity: identityOk ? okGate({ expectedName: xhsVideoName, filenameVisible: state.filenameVisible, restoredIdentity }) : failedGate({ foreign: true, expectedName: xhsVideoName, actualTitle: state.title }),
      video: state.uploaded && !state.failed && !state.uploading
        ? okGate({ filename: xhsVideoName, stable: true })
        : failedGate({ filename: xhsVideoName, uploaded: state.uploaded, uploading: state.uploading, failed: state.failed }),
      title: state.title === xhsTitle ? okGate({ expected: xhsTitle, actual: state.title }) : failedGate({ expected: xhsTitle, actual: state.title }),
      description: state.descriptionOk ? okGate({expected:xhsDescription,actual:state.plainText}) : failedGate({expected:xhsDescription,actual:state.plainText}),
      tags: state.selected.length === xhsTopics.length && state.topicAnchorCount === xhsTopics.length && !state.unexpected.length && !state.plainResidue.length && !state.duplicate.length
        ? okGate({ requested: xhsTopics, selected: state.selected, topicCounts: state.topicCounts, topicAnchorCount: state.topicAnchorCount, unexpected: state.unexpected })
        : failedGate({ requested: xhsTopics, selected: state.selected, plainResidue: state.plainResidue, duplicate: state.duplicate, topicCounts: state.topicCounts, topicAnchorCount: state.topicAnchorCount, unexpected: state.unexpected }),
      original: state.originalEnabled ? okGate({ enabled: true }) : failedGate({ enabled: false }),
      cover: coverOk
        ? okGate({ custom: xhsCustomCover, background: state.coverBg, preview, nativeCover: nativeDraft.liveCover, recordCover: nativeDraft.recordCover, nativeCoverFileId: nativeDraft.live?.coverFileId || '', nativeRatio: xhsCoverRatio, nativeSlot: xhsCoverSlot, receipt })
        : failedGate({ custom: xhsCustomCover, background: state.coverBg, preview, nativeCover: nativeDraft.liveCover, recordCover: nativeDraft.recordCover, nativeCoverFileId: nativeDraft.live?.coverFileId || '', nativeRatio: xhsCoverRatio, nativeSlot: xhsCoverSlot, receipt, reason: xhsCustomCover && !receipt ? 'custom cover receipt missing' : 'cover not verified' }),
      noBlockingDialog: state.activeDialogs.length === 0 ? okGate({ active: [] }) : failedGate({ active: state.activeDialogs }),
      finalButton: finalButton && !finalButton.disabled ? okGate(finalButton) : failedGate({ buttons }),
    },
    evidence: { pageSample: state.text, earlyMutation: state.earlyMutation,
      autosaveRecoveryProbe: typeof probeXhsAutosaveRecovery === 'function' ? await probeXhsAutosaveRecovery() : null,
      coverEditorDiagnostics: await js(String.raw`(() => {
        const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true};
        const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible);
        return modals.map(modal=>({
          toolbar:[...modal.querySelectorAll('.items .item')].filter(visible).map(el=>({text:compact(el.innerText||el.textContent),cls:String(el.className),selected:el.getAttribute('aria-selected'),disabled:!!el.disabled})),
          cropRatioElements:[...modal.querySelectorAll('[class*=ratio],[class*=crop]')].filter(visible).slice(0,45).map(el=>({tag:el.tagName,cls:String(el.className?.baseVal||el.className||''),text:compact(el.innerText||el.textContent).slice(0,220),role:el.getAttribute('role'),selected:el.getAttribute('aria-selected')})),
          images:[...modal.querySelectorAll('img')].filter(visible).slice(0,16).map(el=>({cls:String(el.className),loaded:el.complete,width:el.naturalWidth,height:el.naturalHeight,kind:String(el.currentSrc||el.src).split(':')[0]})),
          inputs:[...modal.querySelectorAll('input[type=file]')].map(el=>({accept:el.accept,disabled:el.disabled,files:el.files?.length||0})),
          controls:[...modal.querySelectorAll('button,[role=button],a,[class*=option],[class*=select]')].filter(visible).slice(0,50).map(el=>({tag:el.tagName,cls:String(el.className?.baseVal||el.className||''),text:compact(el.innerText||el.textContent).slice(0,100),disabled:!!el.disabled}))
        }));
      })()`),
      coverDialogHeader: await js(`document.querySelector('.main-cover-editor-modal .d-modal-header')?.outerHTML || null`),
      coverDialogCloseControls: await js(`Array.from(document.querySelector('.main-cover-editor-modal')?.querySelectorAll('[class*="close"],button,[role="button"],svg')||[]).map(el=>({tag:el.tagName,cls:String(el.className?.baseVal||el.className||''),aria:el.getAttribute('aria-label'),html:el.outerHTML.slice(0,450)})).slice(0,40)`),
    },
  };
  if(typeof readBrowserVideoRevisionSource==='function'&&readBrowserVideoRevisionSource()){
    observation.gates.replaceVideo=await readXhsVideoReplacementProof(observation,nativeDraft);
    if(observation.gates.replaceVideo.ok)observation.gates.video.evidence.replacement=observation.gates.replaceVideo.evidence;
  }
  return observation;
}

async function waitXiaohongshuUploadCompletion(mode) {
  let stableSince = 0;
  for (let index = 0; index < 180; index += 1) {
    const current = await inspectXiaohongshu();
    const uploaded = current.gates.video.evidence?.uploaded || current.gates.video.ok;
    const uploading = current.gates.video.evidence?.uploading === true;
    if (uploaded && !uploading) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 10000) return { ...current, actions: { upload: { mode } } };
    } else {
      stableSince = 0;
    }
    await wait(5);
  }
  const after = await inspectXiaohongshu();
  return { ...after, actions: { upload: { mode } }, blocker: typedBlocker('UPLOAD_STALLED', '小红书视频没有在等待窗口内稳定完成', { retryable: true, evidence: after.gates.video.evidence }) };
}

async function uploadXiaohongshu() {
  const before = await inspectXiaohongshu();
  if (!before.gates.video.ok && typeof recoverXhsAutosavedUpload === 'function') {
    const recovery = await recoverXhsAutosavedUpload();
    if (recovery) {
      const current = await inspectXiaohongshu();
      if (!recovery.ok) return { ...current, blocker: recovery.blocker };
      if (current.gates.video.ok) return { ...current, actions: { upload: { mode: 'resume_existing', stage: 'complete',
        earlyMutationReady: true, autosaveRecovery: recovery } } };
      return { ...current, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书原UUID已重开但视频尚未通过验收；禁止重新上传',
        { evidence: { recovery, video: current.gates.video.evidence } }) };
    }
  }

  if (before.gates.video.ok) return { ...before, actions: { upload: { mode: 'already_ready' } } };
  if (!before.gates.draftIdentity.ok) {
    return { ...before, blocker: typedBlocker('FOREIGN_DRAFT', '小红书当前编辑器属于其他视频草稿', { evidence: before.gates.draftIdentity.evidence }) };
  }
  if (before.gates.video.evidence?.uploading === true) {
    return await waitXiaohongshuUploadCompletion('resume_existing');
  }
  const exposed = await js(String.raw`(() => {
    const videoLike = value => /video|\.(mp4|mov|flv|f4v|mkv|rmvb?|m4v|mpg|mpeg|ts)\b/i.test(value || '')
    const input = [...document.querySelectorAll('input[type=file]')].find(el => videoLike(el.accept))
    if (!input) return { ok: false, reason: 'xiaohongshu video input missing' }
    input.id = 'vp2-xhs-video'
    return { ok: true, selector: '#vp2-xhs-video', accept: input.accept || '' }
  })()`);
  if (!exposed.ok) return { ...before, blocker: typedBlocker('SELECTOR_DRIFT', exposed.reason) };
  try {
    await uploadFile(exposed.selector, videoPath);
  } catch (error) {
    return { ...before, blocker: typedBlocker('UPLOAD_NOT_STARTED', `小红书文件注入失败: ${String(error?.message || error)}`, { retryable: true }) };
  }
  return await waitXiaohongshuUploadCompletion('injected');
}

async function waitXiaohongshuEarlyMutationReady(mode) {
  for (let index = 0; index < 30; index += 1) {
    const current = await inspectXiaohongshu();
    if (!current.gates.authenticated.ok) {
      return { ...current, blocker: typedBlocker('AUTH_REQUIRED', '小红书登录状态失效', { requiresUser: true, evidence: current.gates.authenticated.evidence }) };
    }
    if (current.gates.video.ok) return { ...current, actions: { upload: { mode, stage: 'complete', earlyMutationReady: true } } };
    if (current.gates.video.evidence?.failed === true) {
      return { ...current, blocker: typedBlocker('UPLOAD_NOT_STARTED', '小红书上传失败', { retryable: true, evidence: current.gates.video.evidence }) };
    }
    if (current.gates.video.evidence?.uploading === true && current.evidence?.earlyMutation?.ready === true) {
      return { ...current, actions: { upload: { mode, stage: 'editable_uploading', earlyMutationReady: true } } };
    }
    await wait(1);
  }
  const after = await inspectXiaohongshu();
  return { ...after, blocker: typedBlocker('UPLOAD_NOT_STARTED', '小红书上传启动后编辑区未及时就绪', { retryable: true, evidence: after.evidence?.earlyMutation }) };
}

async function startXiaohongshuUpload() {
  const before = await inspectXiaohongshu();
  if (!before.gates.video.ok && typeof recoverXhsAutosavedUpload === 'function') {
    const recovery = await recoverXhsAutosavedUpload();
    if (recovery) {
      const current = await inspectXiaohongshu();
      if (!recovery.ok) return { ...current, blocker: recovery.blocker };
      if (current.gates.video.ok) return { ...current, actions: { upload: { mode: 'resume_existing', stage: 'complete',
        earlyMutationReady: true, autosaveRecovery: recovery } } };
      return { ...current, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书原UUID已重开但视频尚未通过验收；禁止重新上传',
        { evidence: { recovery, video: current.gates.video.evidence } }) };
    }
  }

  if (before.gates.video.ok) return { ...before, actions: { upload: { mode: 'already_ready', stage: 'complete', earlyMutationReady: true } } };
  if (!before.gates.authenticated.ok) {
    return { ...before, blocker: typedBlocker('AUTH_REQUIRED', '小红书登录状态失效', { requiresUser: true, evidence: before.gates.authenticated.evidence }) };
  }
  if (!before.gates.draftIdentity.ok) {
    return { ...before, blocker: typedBlocker('FOREIGN_DRAFT', '小红书当前编辑器属于其他视频草稿', { evidence: before.gates.draftIdentity.evidence }) };
  }
  if (before.gates.video.evidence?.uploading === true) return await waitXiaohongshuEarlyMutationReady('resume_existing');
  const exposed = await js(String.raw`(() => {
    const videoLike = value => /video|\.(mp4|mov|flv|f4v|mkv|rmvb?|m4v|mpg|mpeg|ts)\b/i.test(value || '')
    const input = [...document.querySelectorAll('input[type=file]')].find(el => videoLike(el.accept))
    if (!input) return { ok: false, reason: 'xiaohongshu video input missing' }
    input.id = 'vp2-xhs-video'
    return { ok: true, selector: '#vp2-xhs-video', accept: input.accept || '' }
  })()`);
  if (!exposed.ok) return { ...before, blocker: typedBlocker('SELECTOR_DRIFT', exposed.reason) };
  try {
    await uploadFile(exposed.selector, videoPath);
  } catch (error) {
    return { ...before, blocker: typedBlocker('UPLOAD_NOT_STARTED', `小红书文件注入失败: ${String(error?.message || error)}`, { retryable: true }) };
  }
  return await waitXiaohongshuEarlyMutationReady('injected');
}

async function activateXhsTopicLifecycle() {
  await cdp('Page.bringToFront', {}).catch(() => {});
  await cdp('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await wait(.35);
  const state=await js(String.raw`(() => ({visibility:document.visibilityState,hasFocus:document.hasFocus()}))()`);
  return state.visibility==='visible'&&state.hasFocus
    ? {ok:true,...state}
    : {ok:false,reason:'xiaohongshu topic page did not become visible and focused',...state};
}

async function rebuildXhsTopics() {
  const attempts=[];
  for(let rebuildAttempt=1;rebuildAttempt<=3;rebuildAttempt+=1){
    const lifecycle=await activateXhsTopicLifecycle();
    if(!lifecycle.ok)return {...lifecycle,attempts};
    const cleared = await js(String.raw`(() => {
      const editors = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')]
      const editor = editors.find(el => el.querySelector('a') || /话题|creator-editor/i.test(String(el.className || ''))) || editors[0]
      if (!editor) return { ok: false, reason: 'xiaohongshu topic editor missing' }
      editor.focus()
      const selection = window.getSelection(); const range = document.createRange()
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range)
      document.execCommand('delete', false)
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      return { ok: String(editor.innerText || editor.textContent || '').replace(/[\s\u200b]/g, '') === '' }
    })()`);
    if (!cleared.ok) return {...cleared,attempts};
    if(xhsDescription){
      const focused=await js(String.raw`(() => {const editors=[...document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')];const editor=editors.find(el=>/话题|creator-editor/i.test(String(el.className||'')))||editors[0];if(!editor)return false;editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return document.activeElement===editor})()`);
      if(!focused)return {ok:false,reason:'xiaohongshu body editor did not retain focus',attempts};
      await cdp('Input.insertText',{text:xhsDescription+'\n\n'});
      await wait(.5);
      const body=await inspectXiaohongshu();
      if(!body.gates.description.ok)return {ok:false,reason:'xiaohongshu approved body did not persist',evidence:body.gates.description.evidence,attempts};
    }
    if(rebuildAttempt>1)await wait(1.5*rebuildAttempt);
    let failure=null;
    for (const tag of xhsTopics) {
    const queryTag = String(tag).replace(/\s+/g, '');
    const focusedEnd=await js(String.raw`(() => {const editors=[...document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')];const editor=editors.find(el=>/话题|creator-editor/i.test(String(el.className||'')))||editors[0];if(!editor)return false;editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return document.activeElement===editor})()`);
    if(!focusedEnd){failure={ok:false,reason:'xiaohongshu topic endpoint lost focus',tag};break;}
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35,commands:['moveToEndOfDocument']});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
    await wait(.3);
    const started = await js(String.raw`(() => {
      const editors = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')]
      const editor = editors.find(el => /话题|creator-editor/i.test(String(el.className || ''))) || editors[0]
      if (!editor) return { ok: false, reason: 'xiaohongshu topic editor lost focus' }
      const topicButton = document.querySelector('button.contentBtn.topic-btn, #topicBtn')
      if (!topicButton) return { ok: false, reason: 'xiaohongshu native topic button missing' }
      // The sticky publish footer can visually cover this toolbar near the viewport
      // bottom, so a real pointer click may land on the footer. Calling the native
      // Vue click handler still uses the site's own editor command to begin a topic.
      topicButton.click()
      editor.focus(); const selection = window.getSelection(); const range = document.createRange()
      range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range)
      const text = String(editor.innerText || editor.textContent || '')
      return { ok: document.activeElement === editor && text.trimEnd().endsWith('#'), active: document.activeElement === editor, text }
    })()`);
    if (!started.ok) { failure={ ...started, reason: started.reason || 'xiaohongshu native topic entry did not start',tag }; break; }
    await cdp('Input.insertText', { text: queryTag });
    await wait(1.2);
    const typed=await js(String.raw`((tag) => {const editors=[...document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')];const editor=editors.find(el=>/话题|creator-editor/i.test(String(el.className||'')))||editors[0];const text=String(editor?.innerText||editor?.textContent||'').replace(/\u200b/g,'').trimEnd();return {ok:text.replace(/\s+/g,'').toLowerCase().endsWith(('#'+String(tag)).toLowerCase()),text}})(${JSON.stringify(queryTag)})`);
    if(!typed.ok){failure={ok:false,reason:'xiaohongshu topic query did not persist exactly',tag,typed};break;}
    let clicked = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      clicked = await js(String.raw`((tag) => {
      const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
      const normalize = value => String(value || '').replace(/\s+/g, '').toLowerCase()
      const tagLower = normalize(tag)
      const scopes = [...document.querySelectorAll('#creator-editor-topic-container, [data-tippy-root], .tippy-box, .tippy-content')]
      const rows = scopes.flatMap(scope => [...scope.querySelectorAll('.item, [role="option"], div, li')])
        .map(el => ({ el, text: compact(el.querySelector('.name')?.innerText || el.innerText || el.textContent || ''), rect: el.getBoundingClientRect() }))
        .filter(item => item.rect.width > 20 && item.rect.height > 10 && item.rect.height < 100)
        .map(item => {const match=item.text.match(/(?:\[话题\]\s*)?#([^\s#]+)/)||item.text.match(/^([^\s#]+)/);return {...item,topic:normalize(match?.[1]||'')}})
        .filter(item => item.topic === tagLower)
        .sort((a, b) => (a.rect.width*a.rect.height)-(b.rect.width*b.rect.height) || a.text.length-b.text.length)
      const row = rows[0]
      if (!row) return { ok: false, reason: 'exact topic suggestion missing', tag, visible: scopes.flatMap(scope=>[...scope.querySelectorAll('.item,[role="option"],li')]).map(el=>compact(el.innerText||el.textContent||'')).filter(Boolean).slice(0,12) }
      row.el.click(); return { ok: true, text: row.text }
    })(${JSON.stringify(queryTag)})`);
      if (clicked.ok) break;
      await wait(0.75);
    }
    if (!clicked.ok) { failure={...clicked,tag}; break; }
    await wait(1.2);
    const committed = await js(String.raw`((tag) => [...document.querySelectorAll('[contenteditable] a')]
      .some(el => {let name='';try{name=JSON.parse(el.getAttribute('data-topic')||'{}').name||''}catch{};if(!name)name=String(el.innerText||el.textContent||'').replace(/^#|\[话题\]#.*$/g,'');return name.replace(/\s+/g,'').toLowerCase()===String(tag).replace(/\s+/g,'').toLowerCase()}))(${JSON.stringify(tag)})`);
    if (!committed) { failure={ ok: false, reason: 'topic entity did not commit', tag }; break; }
    await cdp('Input.insertText', { text: ' ' });
    }
    if(!failure){
      const verified=await inspectXiaohongshu();
      if(verified.gates.tags.ok&&verified.gates.description.ok)return {ok:true,rebuildAttempt,attempts:[...attempts,{rebuildAttempt,result:'committed'}]};
      failure={ok:false,reason:'xiaohongshu topic entities did not pass exact post-build verification',evidence:verified.gates.tags.evidence};
    }
    attempts.push({rebuildAttempt,...failure});
    if(rebuildAttempt<3)await wait(2*rebuildAttempt);
  }
  const last=attempts.at(-1)||{};
  return {ok:false,reason:'xiaohongshu exact topics did not commit after bounded whole-set rebuilds',lastFailure:last,attempts};
}

async function ensureXhsOriginal() {
  await removeExactStaleMask(/笔记完成原创声明后|原创声明须知|声明原创/);
  let inspected = await inspectXiaohongshu();
  if (inspected.gates.original.ok) return { ok: true, already: true };
  const control = await js(String.raw`(() => {
    const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
    const labels = [...document.querySelectorAll('div,section,label,span')].filter(el => compact(el.innerText || el.textContent || '') === '原创声明').sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})
    const label=labels[0]||null;const ancestors=[];for(let el=label;el&&ancestors.length<8;el=el.parentElement)ancestors.push(el)
    const selectors='.custom-switch-switch, .d-switch, [role="switch"], input[type="checkbox"]'
    const row=ancestors.find(el=>el.matches?.(selectors)||el.querySelector?.(selectors))||ancestors.find(el=>{const s=getComputedStyle(el);return compact(el.innerText||el.textContent||'')==='原创声明'&&(parseFloat(s.borderRadius)>0||s.backgroundColor!=='rgba(0, 0, 0, 0)')})||label?.parentElement
    const target=row?.querySelector?.('.d-switch-simulator')||(row?.matches?.('.d-switch-simulator')?row:null)||(row?.matches?.(selectors)?row:row?.querySelector(selectors))||row
    if (!target) return { ok: false, reason: 'xiaohongshu original switch missing' }
    target.id='vp2-xhs-original-control';target.scrollIntoView({block:'center',inline:'center'});return {ok:true,selector:'#vp2-xhs-original-control',className:String(target.className||''),tag:target.tagName,role:target.getAttribute?.('role')||''}
  })()`);
  if (!control.ok) return control;
  try { await click(control.selector,{label:'enable xhs original declaration'}); }
  catch (error) { return { ok: false, reason: `xiaohongshu original switch click failed: ${String(error?.message || error)}`, control }; }
  await wait(1.5);
  const agreement = await js(String.raw`(() => {
    const modal = [...document.querySelectorAll('.d-modal')].find(el => /笔记完成原创声明后|原创声明须知/.test(el.innerText || el.textContent || ''))
    if (!modal) return { ok: true, modal: false, alreadyClosed: true }
    const input = modal.querySelector('input[type="checkbox"]')
    if (!input) return { ok: false, reason: 'xiaohongshu original agreement checkbox missing' }
    if (input.checked) return { ok: true, modal: true, alreadyChecked: true }
    const checkbox = modal.querySelector('.d-checkbox-simulator') || input.closest('.d-checkbox') || input
    checkbox.id='vp2-xhs-original-agreement';checkbox.scrollIntoView({block:'center',inline:'center'})
    return { ok: true, modal: true, selector: '#vp2-xhs-original-agreement' }
  })()`);
  if (!agreement.ok) return { ...agreement, control };
  if (agreement.selector) {
    try { await click(agreement.selector, { label: 'accept xhs original declaration agreement' }); }
    catch (error) { return { ok: false, reason: `xiaohongshu original agreement click failed: ${String(error?.message || error)}`, control, agreement }; }
    await wait(.75);
  }
  let modalResult = { ok: true, modal: agreement.modal === true, alreadyClosed: agreement.alreadyClosed === true };
  if (agreement.modal) {
    let confirm = { ok: false, reason: 'xiaohongshu original confirm disabled' };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      confirm = await js(String.raw`(() => {
        const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
        const modal = [...document.querySelectorAll('.d-modal')].find(el => /笔记完成原创声明后|原创声明须知/.test(el.innerText || el.textContent || ''))
        if (!modal) return { ok: true, alreadyClosed: true }
        const input = modal.querySelector('input[type="checkbox"]')
        const button = [...modal.querySelectorAll('button')].find(el => compact(el.innerText || el.textContent || '') === '声明原创')
        if (!input?.checked || !button || button.disabled) return { ok: false, waiting: true, agreementChecked: Boolean(input?.checked), buttonDisabled: Boolean(button?.disabled) }
        button.id='vp2-xhs-original-confirm';button.scrollIntoView({block:'center',inline:'center'})
        return { ok: true, selector: '#vp2-xhs-original-confirm' }
      })()`);
      if (confirm.ok) break;
      await wait(.25);
    }
    if (!confirm.ok) return { ok: false, reason: 'xiaohongshu original confirm disabled', control, agreement, confirm };
    if (confirm.selector) {
      try { await click(confirm.selector, { label: 'confirm xhs original declaration' }); }
      catch (error) { return { ok: false, reason: `xiaohongshu original confirm click failed: ${String(error?.message || error)}`, control, agreement, confirm }; }
    }
    modalResult = { ok: true, modal: true, confirm };
  }
  await wait(2);
  inspected = await inspectXiaohongshu();
  if (!inspected.gates.noBlockingDialog.ok) return { ok: false, reason: 'xiaohongshu original declaration dialog did not close', control, agreement, modalResult, evidence: inspected.gates.noBlockingDialog.evidence };
  return inspected.gates.original.ok ? { ok: true, control, modalResult } : { ok: false, reason: 'xiaohongshu original declaration did not persist', control, modalResult };
}

async function uploadXhsCover() {
  if (!xhsCustomCover) return { ok: true, skipped: true };
  const verifiedCover=await inspectXiaohongshu();
  if(verifiedCover.gates.cover.ok&&expectedReceipts.cover){
    if(!verifiedCover.gates.noBlockingDialog.ok){
      const close=await js(String.raw`(() => {const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true};const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible);if(modals.length!==1)return null;const buttons=[...modals[0].querySelectorAll('.d-modal-close,img.close-icon,[aria-label="关闭"],[aria-label="Close"]')].filter(visible);if(buttons.length!==1)return null;document.querySelectorAll('#vp2-xhs-close-verified-cover').forEach(el=>el.removeAttribute('id'));buttons[0].id='vp2-xhs-close-verified-cover';return '#vp2-xhs-close-verified-cover'})()`);
      if(close)await click(close,{label:'close unchanged verified cover editor'});
      else await pressKey('Escape');
      await wait(.5);
    }
    const current=await inspectXiaohongshu();
    return current.gates.cover.ok&&current.gates.noBlockingDialog.ok
      ? {ok:true,already:true,receipt:expectedReceipts.cover}
      : {ok:false,reason:'verified cover editor did not close without changing its accepted image',evidence:current.gates.noBlockingDialog.evidence};
  }
  const beforePreview = await readXhsCoverPreview();
  if (!beforePreview.ok) return { ok: false, reason: 'xiaohongshu native cover preview is missing or ambiguous', preview: beforePreview };
  const before = beforePreview.bg;
  let tab = { ok: false, reason: 'xiaohongshu upload-cover tab did not become visible' };
  for (let attempt = 0; attempt < 4 && !tab.ok; attempt += 1) {
    await removeExactStaleMask(/设置封面/);
    {
      const currentEditor = await js(String.raw`(() => {
        const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
        const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
        if(modals.length>1)return {ok:false,reason:'xiaohongshu active native cover editor ambiguous'}
        const modal=modals[0]
        if(!modal)return {ok:true}
        const imageInput=[...modal.querySelectorAll('input[type=file]')].find(el=>/image|png|jpe?g/i.test(el.accept||''))
        if(imageInput)return {ok:true,inputReady:true}
        const edits=[...modal.querySelectorAll('.video-panel-switch-item,button,[role="button"]')]
          .filter(el=>compact(el.innerText||el.textContent||'')==='编辑'&&visible(el)&&!String(el.className||'').split(/\s+/).includes('active'))
        if(edits.length>1)return {ok:false,reason:'xiaohongshu cover edit control ambiguous'}
        if(edits.length===1){document.querySelectorAll('#vp2-xhs-current-editor-edit').forEach(el=>el.removeAttribute('id'));edits[0].id='vp2-xhs-current-editor-edit';return {ok:true,selector:'#vp2-xhs-current-editor-edit',action:'edit'}}
        const clears=[...modal.querySelectorAll('.uploaded-thumbnail-clear,[aria-label="清除已上传封面"]')].filter(visible)
        if(clears.length>1)return {ok:false,reason:'xiaohongshu unbound thumbnail clear control ambiguous'}
        if(clears.length===1){document.querySelectorAll('#vp2-xhs-current-editor-clear').forEach(el=>el.removeAttribute('id'));clears[0].id='vp2-xhs-current-editor-clear';return {ok:true,selector:'#vp2-xhs-current-editor-clear',action:'clear'}}
        return {ok:true}
      })()`);
      if (!currentEditor.ok) return currentEditor;
      if (currentEditor.selector) {
        try { await click(currentEditor.selector, { label: `prepare xhs current cover editor ${currentEditor.action}` }); }
        catch (error) { return { ok: false, reason: `xiaohongshu current cover editor ${currentEditor.action} failed: ${String(error?.message || error)}` }; }
        await wait(0.5);
        if (currentEditor.action === 'edit') {
          const clear = await js(String.raw`(() => {
            const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
            const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
            if(modals.length!==1)return null
            const controls=[...modals[0].querySelectorAll('.uploaded-thumbnail-clear,[aria-label="清除已上传封面"]')].filter(visible)
            const el=controls.length===1?controls[0]:null
            if(!el)return null;document.querySelectorAll('#vp2-xhs-current-editor-clear').forEach(other=>other.removeAttribute('id'));el.id='vp2-xhs-current-editor-clear';return '#vp2-xhs-current-editor-clear'
          })()`);
          if (clear) {
            try { await click(clear, { label: 'clear unverified xhs cover before exact replacement' }); }
            catch (error) { return { ok: false, reason: `xiaohongshu unverified cover clear failed: ${String(error?.message || error)}` }; }
            await wait(0.5);
          }
        }
      }
    }
    const existingEditor = await exposeXhsCoverImageInput();
    if (existingEditor.ok) {
      tab = { ok: true, attempt: attempt + 1, mode: 'direct-image-input' };
      break;
    }
    if (existingEditor.modalCount > 1 || existingEditor.imageInputCount > 1) return existingEditor;
    const opener = await js(String.raw`((attempt) => {
      const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'}
      const exact=[...document.querySelectorAll('button,[role="button"],div,span')]
        .filter(el=>compact(el.innerText||el.textContent||'')==='编辑封面'&&visible(el))
        .sort((a,b)=>{const ab=a.matches('button,[role="button"]')?0:1,bb=b.matches('button,[role="button"]')?0:1;if(ab!==bb)return ab-b;const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})
      const currentEntry=[...document.querySelectorAll('.cover-edit-entry')].find(visible)
      const currentStack=[...document.querySelectorAll('.cover-edit-stack')].find(visible)
      const currentOperator=[...document.querySelectorAll('.operator.default')].find(visible)
      const previewCards=[...document.querySelectorAll('.cover-plugin-preview .default')].filter(el=>visible(el)&&!el.closest('.operator')&&Boolean(getComputedStyle(el).backgroundImage)&&getComputedStyle(el).backgroundImage!=='none')
      const preview=previewCards.length===1?previewCards[0]:null
      const targets=[currentEntry,currentStack,currentOperator,preview].filter(Boolean)
      const target=targets[attempt]||exact[0]||preview
      if(!target)return {ok:false,reason:'xiaohongshu cover editor opener missing'}
      target.scrollIntoView({block:'center',inline:'center'})
      if(target.matches('.cover-edit-entry')){target.click();return {ok:true,nativeHoverEntry:true,text:compact(target.innerText||target.textContent||'')}}
      document.querySelectorAll('#vp2-xhs-cover-opener').forEach(el=>el.removeAttribute('id'))
      target.id='vp2-xhs-cover-opener';return {ok:true,selector:'#vp2-xhs-cover-opener',text:compact(target.innerText||target.textContent||'')}
    })(${JSON.stringify(attempt)})`);
    if (!opener.ok) {
      tab = opener;
      continue;
    }
    if (!opener.nativeHoverEntry) {
      try {
        await click(opener.selector, { label: 'open xhs cover editor' });
      } catch (error) {
        tab = { ok: false, reason: `xiaohongshu cover preview click failed: ${String(error?.message || error)}` };
        continue;
      }
    }
    await wait(0.75);
    const openedAfterRealClick = await js(String.raw`(() => {
      const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'}
      const modal=[...document.querySelectorAll('.main-cover-editor-modal,.d-modal,[role="dialog"]')]
        .find(el=>(el.matches('.main-cover-editor-modal')||/设置封面/.test(compact(el.innerText||el.textContent||'')))&&visible(el))
      const input=[...(modal?.querySelectorAll('input[type=file]')||[])].find(el=>/image|png|jpe?g/i.test(el.accept||''))
      return Boolean(modal||input)
    })()`);
    if (!openedAfterRealClick) {
      await js(String.raw`(() => {
        const target=document.querySelector('.cover-plugin-preview .cover-edit-entry')||document.querySelector('#vp2-xhs-cover-opener')
        if(!target)return {ok:false,reason:'xiaohongshu cover opener disappeared before native fallback'}
        target.click();return {ok:true}
      })()`);
    }
    for (let index = 0; index < 20; index += 1) {
      const exposed = await js(String.raw`(() => {
        const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}return true}
        const modals=[...document.querySelectorAll('.main-cover-editor-modal')].filter(visible)
        if(modals.length!==1)return {ok:false,reason:'xiaohongshu active native cover editor missing or ambiguous',modalCount:modals.length}
        const scope=modals[0]
        const inputs=[...scope.querySelectorAll('input[type=file]')].filter(el=>/image|png|jpe?g/i.test(el.accept||'')&&!el.disabled)
        if(inputs.length>1)return {ok:false,reason:'xiaohongshu active native cover image input ambiguous',imageInputCount:inputs.length}
        if(inputs.length===1)return {ok:true,directInput:true}
        const item=[...scope.querySelectorAll('.d-tabs-header,[role="tab"],button,div,span')]
          .filter(el=>{const label=compact(el.innerText||el.textContent||'');return (/^(上传封面|上传)$/.test(label)||/^(上传图片|本地上传|从本地上传)$/.test(label))&&visible(el)})
          .sort((a,b)=>{const ap=a.matches('.d-tabs-header,[role="tab"],button')?0:1,bp=b.matches('.d-tabs-header,[role="tab"],button')?0:1;if(ap!==bp)return ap-bp;const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})[0]
        if(!item)return {ok:false,directInput:false}
        document.querySelectorAll('#vp2-xhs-upload-cover-tab').forEach(el=>el.removeAttribute('id'))
        item.id='vp2-xhs-upload-cover-tab';item.scrollIntoView({block:'center',inline:'center'});return {ok:true,selector:'#vp2-xhs-upload-cover-tab'}
      })()`);
      if (exposed.modalCount > 1 || exposed.imageInputCount > 1) return exposed;
      if (exposed.ok) {
        if (exposed.directInput) {
          tab = { ok: true, attempt: attempt + 1, waited: index * 0.5, mode: 'direct-image-input' };
          break;
        }
        try {
          await click(exposed.selector, { label: 'activate xhs upload-cover tab' });
          tab = { ok: true, attempt: attempt + 1, waited: index * 0.5 };
        } catch (error) {
          tab = { ok: false, reason: `xiaohongshu upload-cover tab click failed: ${String(error?.message || error)}` };
        }
        break;
      }
      await wait(0.5);
    }
  }
  if (!tab.ok) {
    const diagnostics = await js(String.raw`(() => {
      const compact=value=>String(value||'').replace(/\s+/g,' ').trim()
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'}
      const candidates=[...document.querySelectorAll('button,[role="button"],[role="tab"],div,span')]
        .filter(el=>visible(el)&&/封面|上传|本地|图片/.test(compact(el.innerText||el.textContent||'')))
        .map(el=>({tag:el.tagName,role:el.getAttribute?.('role')||'',className:String(el.className||'').slice(0,180),text:compact(el.innerText||el.textContent||'').slice(0,180)}))
        .filter((item,index,array)=>array.findIndex(other=>other.tag===item.tag&&other.role===item.role&&other.className===item.className&&other.text===item.text)===index)
        .slice(0,80)
      const dialogs=[...document.querySelectorAll('.main-cover-editor-modal,.d-modal,[role="dialog"],[class*="modal"],[class*="drawer"]')]
        .filter(visible)
        .map(el=>({tag:el.tagName,role:el.getAttribute?.('role')||'',className:String(el.className||'').slice(0,180),text:compact(el.innerText||el.textContent||'').slice(0,600)}))
        .slice(0,20)
      const inputs=[...document.querySelectorAll('input[type=file]')].map(el=>({accept:el.accept||'',className:String(el.className||''),outerHTML:String(el.outerHTML||'').slice(0,500)}))
      return {candidates,dialogs,inputs}
    })()`);
    return { ...tab, diagnostics };
  }
  await wait(1);
  const injection = await injectExactXhsCover();
  if (!injection.ok || injection.injected !== true) return injection;
  const uploadedSelection = await selectXhsInjectedCoverThumbnail(injection.thumbnailSource);
  if (!uploadedSelection.ok) return uploadedSelection;
  if (uploadedSelection.selector) {
    try { await click(uploadedSelection.selector, { label: 'select uploaded xhs cover in current editor' }); }
    catch (error) { return { ok: false, reason: `xiaohongshu uploaded cover selection failed: ${String(error?.message || error)}` }; }
    await wait(1);
  }
  const ratio = await selectXhsCoverNativeRatio();
  if (!ratio.ok) return ratio;
  await wait(1);
  const confirmed = await confirmXhsCoverEditor();
  if (!confirmed.ok) return confirmed;
  let after = '', accepted = null, lastCoverState = null;
  for (let index = 0; index < 60; index += 1) {
    const preview = await readXhsCoverPreview();
    const nativeDraft = await readXhsNativeDraft();
    const current = await inspectXiaohongshu();
    after = preview.bg;
    const afterUrl = (after.match(/url\(["']?([^"')]+)/) || [])[1] || after;
    const receipt = { version: 2, assetPath: xhsCoverPath, ratio: xhsCoverRatio,
      nativeRatio: xhsCoverRatio, nativeSlot: xhsCoverSlot,
      nativeFileId: nativeDraft.liveCover?.fileid || '', assetHash: injection.assetHash,
      beforeUrl: before, afterUrl, ...(injection.transport ? { transport: injection.transport } : {}) };
    lastCoverState = { preview, nativeCover: nativeDraft.liveCover, noBlockingDialog: current.gates.noBlockingDialog, uploading: current.gates.video.evidence?.uploading === true };
    if (after && after !== before && current.gates.noBlockingDialog.ok && !lastCoverState.uploading
      && xhsCoverReceiptMatches(receipt, preview, nativeDraft)) { accepted = receipt; break; }
    await wait(2);
  }
  await removeExactStaleMask(/设置封面/);
  if (!accepted) return { ok: false, reason: 'xiaohongshu accepted native cover ratio, slot or exported image is not verified', before, after, expectedRatio: xhsCoverRatio, expectedSlot: xhsCoverSlot, evidence: lastCoverState };
  return { ok: true, receipt: accepted };
}

async function ensureXiaohongshuEarlyMetadata(before) {
  const actions = {};
  if (!before.gates.title.ok) actions.title = await setNativeInputValue('input[placeholder*="填写标题"]', xhsTitle);
  let current = await inspectXiaohongshu();
  if (!current.gates.title.ok) {
    return { ok: false, actions, current, blocker: typedBlocker('ACTION_FAILED', '小红书标题没有持久化', { evidence: current.gates.title.evidence }) };
  }
  if (!current.gates.tags.ok || !current.gates.description.ok) actions.tags = await rebuildXhsTopics();
  if (actions.tags && !actions.tags.ok) {
    current = await inspectXiaohongshu();
    return { ok: false, actions, current, blocker: typedBlocker('ACTION_FAILED', actions.tags.reason, { evidence: actions.tags }) };
  }
  current = await inspectXiaohongshu();
  return { ok: current.gates.title.ok && current.gates.tags.ok && current.gates.description.ok, actions, current };
}

async function prefillXiaohongshu() {
  const before = await inspectXiaohongshu();
  if (!before.gates.authenticated.ok) {
    return { ...before, blocker: typedBlocker('AUTH_REQUIRED', '小红书登录状态失效', { requiresUser: true, evidence: before.gates.authenticated.evidence }) };
  }
  if (!before.gates.draftIdentity.ok) {
    return { ...before, blocker: typedBlocker('FOREIGN_DRAFT', '小红书当前编辑器属于其他视频草稿', { evidence: before.gates.draftIdentity.evidence }) };
  }
  const uploading = before.gates.video.evidence?.uploading === true;
  if (!before.gates.video.ok && (!uploading || before.evidence?.earlyMutation?.ready !== true)) {
    return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书上传中的编辑区尚未完整就绪', { retryable: true, evidence: before.evidence?.earlyMutation }) };
  }
  const metadata = await ensureXiaohongshuEarlyMetadata(before);
  if (!metadata.ok) return { ...metadata.current, actions: metadata.actions, blocker: metadata.blocker };
  return { ...metadata.current, actions: { ...metadata.actions, prefill: { completedDuringUpload: uploading } } };
}

async function mutateXiaohongshu() {
  const before = await inspectXiaohongshu();
  const coverRevision = typeof readBrowserCoverRevisionSource === 'function' ? readBrowserCoverRevisionSource() : null;
  if (coverRevision) {
    const required = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original'];
    const missing = required.filter(key => before.gates[key]?.ok !== true);
    const guard = await inspectFinalPublishGuard();
    if (guard.armed !== true || guard.blockedAttempts !== 0) missing.push('safety');
    if (missing.length) return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书封面替换时原稿字段或安全状态发生变化；禁止同时修改其他字段', { evidence: { missing, guard } }) };
    if (!before.gates.noBlockingDialog.ok && !(await onlyXhsCoverEditorDialogOpen())) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书封面替换遇到非封面弹窗；禁止继续修改', { evidence: before.gates.noBlockingDialog.evidence }) };
    }
    // A cover-only revision must never repair title, body, topics or rights.
    return await finishXhsCoverMutation({ coverOnly: true });
  }
  if (!before.gates.video.ok) return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书没有可修复的已上传视频') };
  const metadata = await ensureXiaohongshuEarlyMetadata(before);
  if (!metadata.ok) return { ...metadata.current, actions: metadata.actions, blocker: metadata.blocker };
  const actions = { ...metadata.actions };
  actions.original = await ensureXhsOriginal();
  if (!actions.original.ok) return { ...(await inspectXiaohongshu()), blocker: typedBlocker('ACTION_FAILED', actions.original.reason, { evidence: actions.original }) };
  return await finishXhsCoverMutation(actions);
}

async function finishXhsCoverMutation(actions) {
  actions.cover = await uploadXhsCover();
  if (!actions.cover.ok) return { ...(await inspectXiaohongshu()), blocker: typedBlocker('PLATFORM_REJECTED_ASSET', actions.cover.reason, { retryable: true, evidence: actions.cover }) };
  const receipts = actions.cover.receipt ? { cover: actions.cover.receipt } : {};
  actions.receiptCheckpoint = checkpointReceipts(receipts);
  const previousReceipts = expectedReceipts;
  expectedReceipts.cover = receipts.cover || expectedReceipts.cover;
  const after = await inspectXiaohongshu();
  Object.assign(expectedReceipts, previousReceipts, receipts);
  return { ...after, actions, receipts };
}

async function runPlatformPhase() {
  if (phase === 'inspect' || phase === 'verify') return await inspectXiaohongshu();
  if (phase === 'upload_start') return await startXiaohongshuUpload();
  if (phase === 'prefill') return await prefillXiaohongshu();
  if (phase === 'upload') return await uploadXiaohongshu();
  if (phase === 'mutate') return await mutateXiaohongshu();
  return { ...(await inspectXiaohongshu()), blocker: typedBlocker('ACTION_FAILED', `unsupported Xiaohongshu phase: ${phase}`) };
}

function xhsVideoRevisionPublished(state){
  return Boolean(state?.publication?.noteId||state?.publication?.hasBeenPublished||state?.publication?.hasBeenPublishSuccess);
}

function xhsReplacementMetadata(native){
  const s=native.live||{};return {title:s.title,description:s.description,descriptionHtml:s.descriptionHtml,original:s.original};
}

function xhsReplacementLocalFile(){
  const stat=fs.statSync(localMediaMetadata.path);
  return {path:localMediaMetadata.path,size:stat.size,lastModified:Math.trunc(stat.mtimeMs),
    sha256:createHash('sha256').update(fs.readFileSync(localMediaMetadata.path)).digest('hex')};
}

function xhsReplacementCoverHash(){
  return videoReplacementSnapshotHash({assetPath:xhsCoverPath,assetHash:xhsLocalCoverHash(),ratio:xhsCoverRatio});
}

async function readXhsReplacementVideoDetails(){
  return await js(String.raw`(() => {
    const apps=[...document.querySelectorAll('*')].map(el=>el.__vue_app__||el.__vueParentComponent?.appContext?.app).filter(Boolean);
    const pinia=apps.find(app=>app.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    const video=pinia?._s.get('draft')?.video||{},file=video.file||video.rawFile||{};
    return {fileid:String(video.fileid||''),size:Number(video.fsize||video.size||video.fileSize||file.size||0),name:String(video.name||video.filename||file.name||''),
      width:Number(video.width||0),height:Number(video.height||0),duration:Number(video.duration||0),
      ready:Boolean(video.fileid),localName:String(file.name||''),localSize:Number(file.size||0)};
  })()`);
}

async function xhsReplacementEvidence(journal,observation,native){
  const p=journal.plan,details=await readXhsReplacementVideoDetails(),currentMetadataHash=videoReplacementSnapshotHash(xhsReplacementMetadata(native)),currentCoverHash=xhsReplacementCoverHash();
  return {...p,draftId:String(native.id||''),uid:native.uid,nativeFileIds:native.live?.videoFileId?[native.live.videoFileId]:[],
    currentMetadataHash,currentCoverHash,metadataUnchanged:currentMetadataHash===p.sourceMetadataHash,
    coversUnchanged:currentCoverHash===p.sourceCoverHash&&observation.gates.cover?.ok===true,
    uploadComplete:observation.gates.video?.ok===true&&details.ready&&details.fileid===native.live?.videoFileId&&details.size===localMediaMetadata.size,
    localFile:xhsReplacementLocalFile(),observedAt:new Date().toISOString(),nativeVideoSize:details.size};
}

async function readXhsVideoReplacementProof(observation,native){
  const journal=readVideoReplacementJournal(videoReplacementJournalPath,{platform,fingerprint:jobFingerprint});
  if(!journal||journal.status!=='confirmed')return failedGate({reason:'Original XHS video replacement is not confirmed'});
  const r=readBrowserVideoRevisionSource(),evidence=await xhsReplacementEvidence(journal,observation,native);
  return !xhsVideoRevisionPublished(native)&&native.available&&native.isFromDraft&&native.id===r.sourceDraftId&&native.uid===r.sourceUid
    &&JSON.stringify(evidence.nativeFileIds)===JSON.stringify(journal.evidence.nativeFileIds)&&validateVideoReplacementEvidence(evidence,journal.plan)
    ?okGate(evidence):failedGate({reason:'XHS original UUID, account, video file, metadata or approved cover changed',draftId:native.id,uid:native.uid,nativeFileIds:evidence.nativeFileIds});
}

async function openXhsOriginalVideoRevision(r){
  let url=await js('location.href');
  if(!/^https:\/\/creator\.xiaohongshu\.com\//.test(url)){
    if(url!=='about:blank')return {ok:false,reason:'replacement task contains an unrelated page'};
    await gotoAndWait(PLATFORM_URLS.xiaohongshu,{timeout:45,settle:2});await armFinalPublishGuard();
  }
  const stored=await readXhsStoredDraft(r.sourceDraftId),p=r.sourcePersistedDraft;
  const journal=readVideoReplacementJournal(videoReplacementJournalPath,{platform,fingerprint:jobFingerprint});
  if(journal){
    const native=await readXhsNativeDraft(r.sourceDraftId);
    return {ok:native.available&&native.isFromDraft&&native.id===r.sourceDraftId&&native.uid===r.sourceUid&&!xhsVideoRevisionPublished(native),recoveredIntent:true};
  }
  // This read-only IDB check precedes opening the historical editor and starting its autosave timer.
  if(stored.uid!==r.sourceUid||stored.record?.uid!==r.sourceUid||stored.record.id!==r.sourceDraftId
    ||stored.record.snapshot?.videoFileId!==r.sourceVideoFileId||xhsSnapshotHash(stored.record.snapshot)!==p.snapshotHash)
    return {ok:false,reason:'read-only account, UUID, original file or full source snapshot differs'};
  const before=await readXhsNativeDraft(r.sourceDraftId);
  if(xhsVideoRevisionPublished(before))return {ok:false,reason:'native editor reports that this content was published'};
  if(before.available&&before.isFromDraft&&before.id===r.sourceDraftId){
    return {ok:before.uid===r.sourceUid&&xhsSnapshotHash(before.live)===p.snapshotHash,alreadyOpen:true};
  }
  if(before.live?.videoFileId)return {ok:false,reason:'another video editor is open; navigating it could autosave unrelated content'};
  url=await js('location.href');
  if(!url.includes('/publish/publish')){await gotoAndWait(PLATFORM_URLS.xiaohongshu,{timeout:45,settle:2});await armFinalPublishGuard();}
  const opened=await js(`(() => {const entries=[...document.querySelectorAll('.draft-title-box')].filter(el=>el.getBoundingClientRect().width>0&&/^草稿箱/.test(el.innerText));if(entries.length!==1)return false;entries[0].click();return true})()`);
  if(!opened)return {ok:false,reason:'native XHS draft list entry unavailable'};
  let clicked=false;
  for(let n=0;n<20&&!clicked;n++){
    clicked=await js(`(p=>{const rows=[...document.querySelectorAll('.draft-item[data-draft-type="video"]')].filter(el=>el.dataset.draftId===p.id&&el.getBoundingClientRect().width>0);if(rows.length!==1||rows[0].querySelector('.draft-title-text')?.textContent.trim()!==p.title)return false;const edits=[...rows[0].querySelectorAll('.draft-actions .btn')].filter(el=>el.innerText.trim()==='编辑'&&el.getBoundingClientRect().width>0);if(edits.length!==1)return false;edits[0].click();return true})(${JSON.stringify({id:r.sourceDraftId,title:stored.record.snapshot.title})})`);
    if(!clicked)await wait(.5);
  }
  if(!clicked)return {ok:false,reason:'exact UUID and title draft edit action is missing or ambiguous'};
  for(let n=0;n<30;n++){
    const native=await readXhsNativeDraft(r.sourceDraftId);
    if(native.available&&native.isFromDraft&&native.id===r.sourceDraftId&&native.uid===r.sourceUid&&native.live?.videoFileId===r.sourceVideoFileId&&xhsSnapshotHash(native.live)===p.snapshotHash){await armFinalPublishGuard();return {ok:true,openedOriginal:true};}
    await wait(1);
  }
  return {ok:false,reason:'native editor did not restore the exact original UUID, account and content'};
}

async function injectXhsOriginalVideoReplacement(r){
  const exposed=await js(String.raw`((id,uid)=>{
    const apps=[...document.querySelectorAll('*')].map(el=>el.__vue_app__||el.__vueParentComponent?.appContext?.app).filter(Boolean),pinia=apps.find(app=>app.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    if(pinia?._s.get('publisher')?.draftId!==id||pinia?._s.get('user')?.userInfo?.id!==uid)return {ok:false,reason:'original UUID or account changed'};
    const buttons=[...document.querySelectorAll('.video-plugin-title-action')].filter(el=>el.getBoundingClientRect().width>0&&String(el.innerText||el.textContent||'').trim()==='重新上传');
    const inputs=[...document.querySelectorAll('input.upload-input[type=file]')].filter(el=>/video|\.mp4|\.mov/i.test(el.accept||''));
    if(buttons.length!==1||inputs.length!==1)return {ok:false,reason:'native reupload command or dedicated input missing or ambiguous'};
    for(const node of document.querySelectorAll('#vp2-xhs-original-video-reupload'))node.removeAttribute('id');inputs[0].id='vp2-xhs-original-video-reupload';
    return {ok:true,selector:'#vp2-xhs-original-video-reupload'};
  })(${JSON.stringify(r.sourceDraftId)},${JSON.stringify(r.sourceUid)})`);
  if(!exposed.ok)return exposed;
  // This existing editor input is the native reupload source, not the initial upload/reset path.
  await uploadFile(exposed.selector,videoPath);
  return {ok:true,mode:'original_native_reupload'};
}

async function replaceOriginalDraftVideo(){
  const r=readBrowserVideoRevisionSource(),identity={platform,fingerprint:jobFingerprint};
  if(!r||Number(activeTaskSpace.id)!==r.sourceTaskSpaceId)return {gates:{},blocker:typedBlocker('STATE_AMBIGUOUS','小红书替换缺少批准的原稿和当前任务空间绑定')};
  const opened=await openXhsOriginalVideoRevision(r);
  if(!opened.ok)return {gates:{},blocker:typedBlocker('PERSISTENCE_UNVERIFIED','小红书原稿只读核对或重开失败',{evidence:opened})};
  let native=await readXhsNativeDraft(r.sourceDraftId),current=await inspectXiaohongshu();
  if(!native.available||!native.isFromDraft||native.id!==r.sourceDraftId||native.uid!==r.sourceUid||xhsVideoRevisionPublished(native))return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','小红书当前原稿 UUID、账号或发布状态不一致')};
  let journal=readVideoReplacementJournal(videoReplacementJournalPath,identity),recoveringIntent=journal?.status==='intent';
  if(journal?.status==='confirmed')return current.gates.replaceVideo?.ok?current:{...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','小红书当前媒体不再匹配已确认替换；禁止重传')};
  if(!journal){
    const missing=['authenticated','draftIdentity','video','title','description','tags','original','cover','noBlockingDialog','finalButton'].filter(key=>current.gates[key]?.ok!==true),local=xhsReplacementLocalFile();
    if(missing.length||xhsVideoRevisionPublished(native)||local.sha256!==r.nextVideoIdentity.sha256||local.size!==localMediaMetadata.size||local.lastModified!==localMediaMetadata.lastModified)
      return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','小红书原稿字段、发布状态或批准的新文件未通过',{evidence:{missing}})};
    const plan={sourceDraftId:r.sourceDraftId,sourceTaskSpaceId:r.sourceTaskSpaceId,sourceNativeFileIds:[r.sourceVideoFileId],sourceVideoSha256:r.sourceVideoIdentity.sha256,nextVideoSha256:r.nextVideoIdentity.sha256,
      sourceMetadataHash:videoReplacementSnapshotHash(xhsReplacementMetadata(native)),sourceCoverHash:xhsReplacementCoverHash(),originalDraftVerified:true,liveSourceDraftId:native.id,
      nextVideoPath:local.path,nextVideoSize:local.size,nextVideoMtimeMs:local.lastModified};
    journal=beginVideoReplacement(videoReplacementJournalPath,identity,plan);
    const injected=await injectXhsOriginalVideoReplacement(r);
    if(!injected.ok)return {...current,blocker:typedBlocker('UPLOAD_NOT_STARTED',injected.reason)};
  }
  for(let n=0;n<180;n++){
    native=await readXhsNativeDraft(r.sourceDraftId);const details=await readXhsReplacementVideoDetails();
    if(!native.available||native.id!==r.sourceDraftId||native.uid!==r.sourceUid||xhsVideoRevisionPublished(native))return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','小红书重新上传过程中原 UUID、账号或发布状态发生变化')};
    const changed=Boolean(native.live?.videoFileId)&&native.live.videoFileId!==r.sourceVideoFileId;
    current=await inspectXiaohongshu();
    if(changed&&current.gates.video?.ok&&details.size===localMediaMetadata.size){
      const metadata=await ensureXiaohongshuEarlyMetadata(current);if(!metadata.ok)return {...metadata.current,blocker:metadata.blocker};
      const original=await ensureXhsOriginal();if(!original.ok)return {...current,blocker:typedBlocker('ACTION_FAILED',original.reason)};
      current=await inspectXiaohongshu();
      if(!current.gates.cover?.ok){current=await finishXhsCoverMutation({videoReplacement:true});if(current.blocker)return current;}
      native=await readXhsNativeDraft(r.sourceDraftId);const evidence=await xhsReplacementEvidence(journal,current,native);
      if(!validateVideoReplacementEvidence(evidence,journal.plan))return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','小红书新版视频、原文案或批准的封面未保持一致')};
      journal=confirmVideoReplacement(videoReplacementJournalPath,identity,journal.attemptId,evidence);
      return await inspectXiaohongshu();
    }
    if(n===0&&recoveringIntent&&!changed&&current.gates.video?.ok)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','小红书已有重新上传意图但仍为旧文件；禁止再次注入')};
    await wait(5);
  }
  return {...current,blocker:typedBlocker('UPLOAD_STALLED','小红书原稿重新上传尚未稳定完成；保留意图并仅允许核对')};
}
