import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from 'node:vm';
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.join(DIR, "..", "platforms");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("Xiaohongshu topics start through the native editor command", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu.mjs"), "utf8");
  const start = source.indexOf("async function rebuildXhsTopics");
  const end = source.indexOf("async function ensureXhsOriginal", start);
  assert.ok(start >= 0 && end > start, "topic rebuild function must remain discoverable");
  const topicFlow = source.slice(start, end);
  const lifecycle = topicFlow.indexOf("activateXhsTopicLifecycle()");
  const nativeStart = topicFlow.indexOf("topicButton.click()");
  const explicitFocus = topicFlow.indexOf("editor.focus()", nativeStart);
  const bareQuery = topicFlow.indexOf("await cdp('Input.insertText', { text: queryTag })", explicitFocus);
  assert.ok(lifecycle >= 0 && lifecycle < nativeStart, "the hidden post-crash page must be activated before topic input");
  assert.match(source, /Page\.setWebLifecycleState', \{ state: 'active' \}/);
  assert.ok(nativeStart >= 0, "the platform topic command must insert the leading hash");
  assert.ok(explicitFocus > nativeStart, "the editor must be refocused after the native command");
  assert.ok(bareQuery > explicitFocus, "only the bare topic query may be inserted after refocus");
  assert.doesNotMatch(topicFlow, /Input\.insertText', \{ text: `#\$\{queryTag\}` \}/);
  assert.match(topicFlow, /rebuildAttempt<=3/, "candidate failures must retry the whole exact topic set with a finite bound");
  assert.match(topicFlow, /attempt < 12/, "each native suggestion request must get a bounded high-load wait window");
});

test("Douyin preserves committed topic entities while retrying a failed tail query", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  const cleanupStart = source.indexOf("async function removeDouyinTrailingTopicQuery");
  const cleanupEnd = source.indexOf("async function addDouyinTopic", cleanupStart);
  const addEnd = source.indexOf("async function recoverDouyinTopicPrefix", cleanupEnd);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart && addEnd > cleanupEnd);
  const cleanup = source.slice(cleanupStart, cleanupEnd);
  const add = source.slice(cleanupEnd, addEnd);
  assert.match(cleanup, /expected\.startsWith\(initial\)/, "cleanup must prove the visible tail belongs to the missing topic");
  assert.match(cleanup, /entitiesUnchanged/, "cleanup must verify existing topic entities were preserved");
  assert.match(source, /value\.startsWith\(expectedDescription\)/, "the first topic query must be isolated from a shared description text node");
  assert.match(add, /attempt<=3/, "suggestion lookup must use a finite retry bound");
  assert.match(add, /removeDouyinTrailingTopicQuery\(queryTag,committedBefore\)/, "a failed lookup must remove only its own plain query");
  assert.match(add, /querySelectorAll\('\[class\*=\"mention-suggest-item-container\"\]'\)/, "current Douyin must click the real suggestion row before falling back to descendants");
  assert.match(add, /direct\.length\?direct:legacy/, "legacy suggestion descendants remain a bounded fallback");
  assert.match(add, /hashes===1/, "a multi-topic suggestion container must never be treated as one exact row");
  assert.match(add, /elementFromPoint\(x,y\)/, "the exact suggestion click must prove its native hit target");
  assert.match(add, /click\(\[row\.x,row\.y\]/, "topic selection must use a real pointer click on the proven exact row");
  assert.match(add, /unexpected_entity_after_exact_candidate/, "a platform-side wrong selection must be repaired and retried within the finite bound");
});

test("Douyin recovery removes a provable plain tail before deleting an unexpected entity", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  const cleanupStart = source.indexOf("async function removeDouyinTrailingTopicQuery");
  const cleanupEnd = source.indexOf("async function addDouyinTopic", cleanupStart);
  const recoveryStart = source.indexOf("async function recoverDouyinTopicPrefix", cleanupEnd);
  const recoveryEnd = source.indexOf("async function removeDouyinUnexpectedFinalTopic", recoveryStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart && recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);
  const recovery = source.slice(recoveryStart, recoveryEnd);
  assert.match(cleanup, /expectedEntityNames/, "tail cleanup must support preserving the complete entity sequence");
  assert.match(cleanup, /allEntitiesUnchanged/, "tail cleanup must verify unexpected entities were not altered implicitly");
  const tailCleanup = recovery.indexOf("cleanupBeforeEntityRepair");
  const entityRepair = recovery.indexOf("removeDouyinUnexpectedFinalTopic");
  assert.ok(tailCleanup >= 0 && entityRepair > tailCleanup, "plain tail cleanup must happen before deleting the unexpected final entity");
  assert.match(recovery, /evidence\.entityNames\|\|\[\]/, "recovery must bind cleanup to the full live entity sequence");
});

test("Douyin prefill requires live editable-upload evidence and defers covers", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  const start = source.indexOf("async function prefillDouyin");
  const end = source.indexOf("async function mutateDouyin", start);
  assert.ok(start >= 0 && end > start, "Douyin prefill function must remain discoverable");
  const prefill = source.slice(start, end);
  assert.match(source, /stage:'editable_uploading'/, "upload start must expose an explicit editable-uploading stage");
  assert.match(prefill, /early\.ready===true/, "prefill must require freshly proven editor readiness");
  assert.match(prefill, /video\.evidence\?\.uploading===true/, "prefill must remain bound to an active upload when video is incomplete");
  assert.match(prefill, /ensureDouyinMetadata\(before\)/, "prefill must use the same idempotent metadata repair as final mutation");
  assert.doesNotMatch(prefill, /uploadDouyinCoverSlot|repairDelayedDouyinCoverReceipt/, "custom covers stay after upload completion");
});

test("Douyin accepts a removed cross-post control only when no sync state exists", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  assert.match(source, /!state\.settingsReady&&!state\.syncFound&&!state\.syncOn&&!state\.simultaneousChecked/, "an absent control is safe only when every live sync signal is off");
  assert.match(source, /controlAbsent:!state\.settingsReady&&!state\.syncFound/, "the readback must disclose that the platform removed the control");
  assert.match(source, /absent\.gates\.settings\.ok\?\{ok:true,controlAbsent:true/, "mutation must re-inspect page truth before accepting a missing control");
});

test("Douyin rewrites persisted paragraph markers with a native editor select-all", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  assert.match(source, /douyinPersistedDescriptionArtifact/);
  assert.match(source, /isDouyinKnownArtifactDamage/, "an interrupted legacy three-character deletion must remain recoverable only by an exact bounded pattern");
  assert.match(source, /\['meta',4\],\['control',2\]/, "both native select-all modifier variants must be tried");
  assert.match(source, /normalize\(selected\)===normalize\(text\)/, "deletion must require proof that the whole editor is selected");
  assert.match(source, /Input\.insertText',\{text:douyinInputDescription\}/, "the proven complete selection must be replaced in one native input operation");
  assert.doesNotMatch(source, /document\.execCommand\('delete'/, "cross-block deletion is unsafe in the current Douyin editor");
  assert.match(source, /__publisherDouyinNeedsResave/, "the controlled repair must be marked before editing for crash recovery");
});

test("Douyin inserts directly into a focused already-empty body and preserves body failure evidence", async () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "douyin.mjs"), "utf8");
  const bodyStart = source.indexOf("async function clearAndFillDouyinBody");
  const bodyEnd = source.indexOf("const normalizeDouyinTopic", bodyStart);
  const metadataStart = source.indexOf("async function ensureDouyinMetadata");
  const metadataEnd = source.indexOf("async function prefillDouyin", metadataStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart && metadataStart >= 0 && metadataEnd > metadataStart);

  const run = new AsyncFunction("fixture", `
    const calls=[];
    const douyinInputDescription=fixture.expected;
    let locateCount=0;
    const locateDouyinEditor=async()=>locateCount++===0
      ? {ok:true,text:' \\u200b\\u00a0\\n',point:{x:10,y:20}}
      : {ok:true,text:fixture.expected,point:{x:10,y:20}};
    const click=async()=>{calls.push({type:'click'})};
    const js=async()=>({ok:true,normalizedLength:0,activeTag:'DIV',activeId:'vp2-douyin-editor'});
    const cdp=async(method,payload)=>{calls.push({type:'cdp',method,payload})};
    const wait=async()=>{};
    ${source.slice(bodyStart, bodyEnd)}
    return {result:await clearAndFillDouyinBody(),calls};
  `);
  const { result, calls } = await run({ expected: "审核通过的正文" });
  assert.equal(result.ok, true);
  assert.equal(result.selectionMethod, "already-empty");
  assert.deepEqual(calls.filter(call => call.type === "cdp"), [
    { type: "cdp", method: "Input.insertText", payload: { text: "审核通过的正文" } },
  ], "an empty editor must not receive select-all or deletion input before insertion");

  const runNonEmpty = new AsyncFunction("fixture", `
    const calls=[];
    const douyinInputDescription=fixture.expected;
    const locateDouyinEditor=async()=>({ok:true,text:'旧正文',point:{x:10,y:20}});
    const click=async()=>{};
    const js=async expression=>{
      if(expression.includes('normalizedLength:normalize(text).length'))return {ok:true,normalizedLength:3};
      if(expression.includes('normalize(selected)===normalize(text)'))return {ok:false,selectedLength:0,textLength:3};
      return true;
    };
    const cdp=async(method,payload)=>{calls.push({method,payload})};
    const wait=async()=>{};
    ${source.slice(bodyStart, bodyEnd)}
    return {result:await clearAndFillDouyinBody(),calls};
  `);
  const nonEmpty = await runNonEmpty({ expected: "审核通过的正文" });
  assert.equal(nonEmpty.result.ok, false);
  assert.equal(nonEmpty.result.selectionMethod, "dom-range");
  assert.equal(nonEmpty.calls.some(call => call.method === "Input.insertText"), false,
    "a non-empty editor must never be replaced when full-selection proof fails");

  const metadata = source.slice(metadataStart, metadataEnd);
  assert.match(metadata, /typedBlocker\('ACTION_FAILED', actions\.body\.reason, \{ evidence: actions\.body \}\)/,
    "a body repair blocker must retain the complete actions.body evidence");
});

test("Xiaohongshu prefill requires live title and topic controls and defers rights and cover", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu.mjs"), "utf8");
  const start = source.indexOf("async function prefillXiaohongshu");
  const end = source.indexOf("async function mutateXiaohongshu", start);
  assert.ok(start >= 0 && end > start);
  const prefill = source.slice(start, end);
  assert.match(source, /stage: 'editable_uploading'/);
  assert.match(source, /controls: \{ title: visible\(titleInput\), topics:/);
  assert.match(prefill, /ensureXiaohongshuEarlyMetadata\(before\)/);
  assert.doesNotMatch(prefill, /ensureXhsOriginal|uploadXhsCover/);
});

test("Xiaohongshu cover repair supports the current upload editor labels", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu.mjs"), "utf8");
  const start = source.indexOf("async function uploadXhsCover");
  const end = source.indexOf("async function ensureXiaohongshuEarlyMetadata", start);
  assert.ok(start >= 0 && end > start, "cover upload function must remain discoverable");
  const coverFlow = source.slice(start, end);
  assert.match(coverFlow, /\.main-cover-editor-modal/, "the current cover-editor root must be recognized");
  assert.match(coverFlow, /\^\(上传封面\|上传\)\$/, "both old and current upload labels must remain supported");
  assert.match(source, /\^\(确定\|完成\)\$/, "both old and current confirmation labels must remain supported");
  assert.match(coverFlow, /input\[type=file\]/, "a direct image input must take precedence over tab text");
  assert.match(coverFlow, /openedAfterRealClick/, "the cover opener must verify that the asynchronous editor materialized");
  assert.match(coverFlow, /native fallback/, "a missing asynchronous editor must retry through the page's native click handler");
  assert.doesNotMatch(coverFlow, /resume-uploaded-thumbnail|alreadyUploaded/, "an unbound old thumbnail must never skip exact cover injection");
  assert.match(coverFlow, /await injectExactXhsCover\(\)/, "only a validated accepted receipt may skip injection of the exact requested cover");
  assert.doesNotMatch(source, /inferredFromUploadedThumbnail/, "an uploaded source image cannot prove the native exported crop ratio");
  assert.match(source, /Math\.abs\(Number\(cover\.width\) \/ Number\(cover\.height\) - width \/ height\) < 0\.01/, "the native exported cover dimensions must tightly match the requested ratio");
  assert.match(source, /\.crop-panel \.ratio-list button\.ratio-option/, "the current native crop-panel controls must be read and selected");
  assert.match(source, /attempt < 20/, "the native crop controls must get a bounded initialization window before ratio failure");
  assert.match(coverFlow, /video-panel-switch-item/, "the current editor must switch from preview to edit mode");
  assert.match(coverFlow, /clear unverified xhs cover before exact replacement/, "an unbound current-editor image must be replaced, not accepted by appearance");
  assert.match(coverFlow, /select uploaded xhs cover in current editor/, "the current editor must apply the uploaded thumbnail before completion");
  assert.match(source, /xhsCoverObjectKey/, "reopened cover verification must use the stable spectrum object key");
  assert.match(source, /\(\?:\^\|\\\/\)spectrum\\\//,
    "the object-key parser must accept both native spectrum/... ids and URL /spectrum/... paths");
  assert.match(source, /acceptedKey = xhsCoverObjectKey\(receipt\?\.afterUrl\)/, "rotating preview hosts and signatures must not invalidate the same uploaded cover");
  assert.match(source, /xhsCoverObjectKey\(preview\.bg\) !== acceptedKey/, "the unique native card must expose the accepted cover object key");
  assert.match(source, /xhsCoverObjectKey\(nativeDraft\.live\?\.coverFileId\) !== acceptedKey/, "page preview alone cannot prove the native draft cover was updated");
});

test("WeChat draft-list readback waits for the native store after navigation", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels-persistence.mjs"), "utf8");
  const start = source.indexOf("async function readWechatDraftList");
  const end = source.indexOf("async function readWechatRestoredIdentity", start);
  const readback = source.slice(start, end);
  assert.match(readback, /attempt < 20/, "the native store needs a bounded post-navigation readiness window");
  assert.match(readback, /await wait\(0\.5\)/, "store retries must yield for the Vue page to initialize");
  assert.match(readback, /includes\('WeChat native draft store unavailable'\)/, "only the known transient store error may be retried");
});

test("Xiaohongshu confirmed snapshot drift cannot trigger an automatic second save", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu-persistence.mjs"), "utf8");
  assert.match(source, /if \(!snapshotMatchesPlan\)/);
  assert.match(source, /自动恢复禁止再次暂存/);
  assert.doesNotMatch(source, /restartConfirmedDraftSave/);
});

test("Xiaohongshu reads the persisted Mojito cover before the legacy draft cover", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu-persistence.mjs"), "utf8");
  assert.match(source, /pinia\?\._s\.get\('context'\)/,
    "live verification must read the current cover editor store");
  assert.match(source, /c\?\.coverContext\?\.cover\?\.fileid \|\| d\.cover\?\.fileid/,
    "the persisted current-editor cover must win while legacy drafts remain supported");
  assert.match(source, /record\.content\?\.contextStore/,
    "reopen verification must read the same current-editor field from IndexedDB");
});

test("Xiaohongshu original declaration never treats unchecked as checked", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu.mjs"), "utf8");
  const inspectStart = source.indexOf("async function inspectXiaohongshu");
  const inspectEnd = source.indexOf("async function waitXiaohongshuUploadCompletion", inspectStart);
  const ensureStart = source.indexOf("async function ensureXhsOriginal");
  const ensureEnd = source.indexOf("async function uploadXhsCover", ensureStart);
  const inspectFlow = source.slice(inspectStart, inspectEnd);
  const ensureFlow = source.slice(ensureStart, ensureEnd);
  assert.match(inspectFlow, /originalInput\?\.checked === true/, "the real checkbox must be authoritative when present");
  assert.match(inspectFlow, /simulatorTokens\.some\(token => \['checked', 'active', 'open', 'enabled'\]\.includes\(token\)\)/, "state classes must be matched as exact tokens");
  assert.doesNotMatch(inspectFlow, /\/checked\|active\|open\|enabled\//, "substring matching would make unchecked a false positive");
  assert.match(ensureFlow, /querySelector\?\.\('\.d-switch-simulator'\)/, "the proven interactive simulator is the preferred click target");
  assert.match(ensureFlow, /accept xhs original declaration agreement/, "the agreement must be a separate real interaction");
  assert.match(ensureFlow, /attempt < 12/, "the Vue confirmation state needs a bounded readiness wait");
  assert.match(ensureFlow, /if \(!confirm\.ok\) return/, "a disabled confirmation must stop mutation instead of being ignored");
  assert.match(ensureFlow, /original declaration dialog did not close/, "success requires an independently closed dialog");
});

test("Xiaohongshu opens the hover-only cover editor through its native handler", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "xiaohongshu.mjs"), "utf8");
  const start = source.indexOf("async function uploadXhsCover");
  const end = source.indexOf("async function ensureXiaohongshuEarlyMetadata", start);
  const coverFlow = source.slice(start, end);
  assert.match(coverFlow, /target\.matches\('\.cover-edit-entry'\)\)\{target\.click\(\);return \{ok:true,nativeHoverEntry:true/, "the hover entry must fire before pointer movement can remove it");
  assert.match(coverFlow, /if \(!opener\.nativeHoverEntry\)/, "ordinary stable controls should still use the real click path");
  assert.match(coverFlow, /document\.querySelector\('\.cover-plugin-preview \.cover-edit-entry'\)\|\|document\.querySelector\('#vp2-xhs-cover-opener'\)/, "the native fallback must prefer a fresh hover entry over a stale id");
});

test("Bilibili prefill is limited to live title and tag controls", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const start = source.indexOf("async function prefillBilibili");
  const end = source.indexOf("async function mutateBilibili", start);
  assert.ok(start >= 0 && end > start);
  const prefill = source.slice(start, end);
  assert.match(source, /stage:'editable_uploading'/);
  assert.match(source, /controls:\{title:visible\(titleInput\),tags:visible\(tagInput\)\}/);
  assert.match(prefill, /ensureBilibiliEarlyMetadata\(before\)/);
  assert.doesNotMatch(prefill, /setBilibiliDescriptionV2|ensureBilibiliDeclarationV2|uploadBilibiliCoverV2/);
});

test("Bilibili description uses the Quill model and verifies the delayed gate", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const start = source.indexOf("async function setBilibiliDescriptionV2");
  const end = source.indexOf("async function ensureBilibiliDeclarationV2", start);
  assert.ok(start >= 0 && end > start);
  const description = source.slice(start, end);
  assert.match(description, /\.ql-container/);
  assert.match(description, /__quill\.setText\(value,'user'\)/);
  assert.match(description, /__quill\.getText\(\)/, "the immediate Quill model must match before waiting");
  assert.match(description, /await wait\(/);
  assert.match(description, /await inspectBilibili\(\)/);
  assert.match(description, /after\.gates\.description\.ok/);
  assert.doesNotMatch(description, /execCommand|dispatchEvent/, "DOM text and synthetic events cannot prove Quill state");
});

test("Bilibili tag repair waits for stability, converges one chip at a time, and preserves input failures", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const start = source.indexOf("async function waitForBilibiliTagSetStable");
  const end = source.indexOf("async function uploadBilibiliCoverV2", start);
  assert.ok(start >= 0 && end > start, "the bounded tag convergence flow must remain discoverable");
  const tagFlow = source.slice(start, end);
  assert.match(tagFlow, /stablePolls/, "tag mutation must begin only after repeated stable chip observations");
  assert.match(tagFlow, /unexpected\[0\]/, "each convergence step removes at most one unexpected chip");
  assert.match(tagFlow, /missing\[0\]/, "each convergence step adds at most one missing chip");
  assert.match(tagFlow, /finalCleanup/, "a final stable pass must clean automatic tags that arrive after requested chips");
  assert.match(tagFlow, /inputProbe/, "each insertion attempt must record the visible input and focus probe");
  assert.match(source, /\.toaster-v2-wrp \.msg-text/, "the current Bilibili toaster feedback must be captured verbatim");
  assert.match(source, /rawFeedback/, "the probe must expose raw feedback, not only preclassified messages");
  assert.match(tagFlow, /feedbackSeen/, "feedback from every validation poll must be retained");
  assert.match(source, /同名话题/);
  assert.match(source, /参与话题/, "same-name topic guidance is an explicit custom-tag rejection");
  assert.match(tagFlow, /addExistingBilibiliTopicV2/, "topic-only tags must use the bounded exact-topic fallback");
  assert.match(tagFlow, /topic_id/);
  assert.match(tagFlow, /mission_id/);
  assert.match(tagFlow, /show_activity_icon/);
  assert.match(tagFlow, /\.topic-tag-name/, "DOM topic selection must be name-based, not position-based");
  assert.match(tagFlow, /\.submit-add/, "the exact topic must be committed through the real topic dialog");
  assert.match(tagFlow, /创建话题行（topic_id=-1）/, "the fallback must explicitly reject a create-topic row");
  assert.match(tagFlow, /explicitPlatformRejection/, "only visible platform rejection evidence may classify a tag as rejected");
  assert.doesNotMatch(tagFlow, /\.catch\(\(\)=>\{\}\)/, "real input exceptions must not be swallowed");
});

test("Bilibili classifies only explicit tag feedback as PLATFORM_REJECTED_METADATA", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const start = source.indexOf("function bilibiliTagFailureBlocker");
  const end = source.indexOf("async function prefillBilibili", start);
  assert.ok(start >= 0 && end > start, "the tag failure classifier must remain discoverable");
  const classifier = source.slice(start, end);
  assert.match(classifier, /result\.explicitPlatformRejection===true\?'PLATFORM_REJECTED_METADATA':'ACTION_FAILED'/);
  assert.match(classifier, /retryable:result\.requiresUser!==true/, "ordinary action failures remain recoverable while unresolved topic semantics require the user");
  assert.match(classifier, /requiresUser:result\.requiresUser===true/);
});

test("Bilibili foreign-draft quarantine is journaled and verified through the native draft list", () => {
  const adapter = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const persistence = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili-persistence.mjs"), "utf8");
  const start = adapter.indexOf("async function quarantineBilibili");
  const end = adapter.indexOf("async function runPlatformPhase", start);
  const quarantine = adapter.slice(start, end);
  assert.match(quarantine, /quarantineBiliForeignDraft\(before\)/);
  assert.doesNotMatch(quarantine, /querySelectorAll\('button,\[role="button"\],div,span'\)/,
    "quarantine must not text-search arbitrary elements and invoke DOM click");
  assert.match(persistence, /\.quarantine-draft-save\.json/);
  assert.match(persistence, /clickDedicatedDraftSelector\('span\.submit-draft', '存草稿', 'SPAN'\)/);
  assert.match(persistence, /findBiliDraft\(await readBiliDraftList\(\), journal\.plan\)/);
  assert.match(persistence, /confirmDraftSave\(file, identity, journal\.attemptId/);
});

test("Dedicated draft selectors scroll into view and prove their hit target", () => {
  const source = fs.readFileSync(path.join(DIR, "..", "ego", "semantic-controls.mjs"), "utf8");
  const start = source.indexOf("async function clickDedicatedDraftSelector");
  const end = source.indexOf("async function armClosedShadowPublishGuards", start);
  const flow = source.slice(start, end);
  assert.match(flow, /scrollIntoView\(\{ block: 'center', inline: 'center' \}\)/);
  assert.match(flow, /document\.elementFromPoint\(x, y\)/);
  assert.match(flow, /nodes\[0\]\.contains\(hit\)/);
});

test("WeChat Channels prefill uses a task-space-bound upload receipt and defers original and covers", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  const start = source.indexOf("async function prefillWechatChannels");
  const end = source.indexOf("async function mutateWechatChannels", start);
  assert.ok(start >= 0 && end > start);
  const prefill = source.slice(start, end);
  assert.match(source, /正在处理文件\|处理中\|生成中/, "processing and generated-cover text must keep the upload incomplete");
  assert.match(source, /uploadStartReceipt\?\.fingerprint===jobFingerprint/);
  assert.match(source, /completeWechatUploadStartObservation\(current,mode,'editable_uploading'/);
  assert.match(prefill, /ensureWechatEarlyMetadata\(before\)/);
  assert.doesNotMatch(prefill, /ensureWechatOriginal|uploadWechatCover/);
});

test("WeChat confirmed draft recovery runs before any upload injection", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  const start = source.indexOf("async function startWechatChannelsUpload");
  const end = source.indexOf("async function uploadWechatChannels", start);
  const flow = source.slice(start, end);
  const journal = flow.indexOf("confirmedJournal");
  const recovery = flow.indexOf("persistWechatDraft(inspectWechatChannels)");
  const injection = flow.indexOf("injectWechatVideo()");
  assert.ok(journal >= 0 && recovery > journal && injection > recovery, "a confirmed object ID must be reopened before upload code can run");
});

test("WeChat Channels cover flow supports both slot-specific and generic editors", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  const start = source.indexOf("async function dismissWechatCoverEditor");
  const end = source.indexOf("async function ensureWechatEarlyMetadata", start);
  const coverFlow = source.slice(start, end);
  assert.match(coverFlow, /编辑个人主页卡片\|编辑分享卡片\|编辑封面\|裁剪封面图/, "recovery must recognize every live cover-dialog title");
  assert.match(coverFlow, /querySelectorAll\('\.weui-desktop-dialog__wrp'\)/, "cover lookup must not depend on the removed edit-cover-dialog ancestor");
  assert.match(coverFlow, /dialogs\.find\(el=>String\(el\.innerText\|\|el\.textContent\|\|'\'\)\.includes\(title\)\)\|\|dialogs\.find/, "the exact slot title remains preferred before the generic fallback");
  assert.match(coverFlow, /\/编辑封面\/\.test\(text\)&&\/上传封面\/\.test\(text\)&&\/取消\/\.test\(text\)&&\/确认\/\.test\(text\)/, "the generic fallback must still prove a complete cover editor");
});

test("WeChat cover entry is revealed and clicked through a proven native hit target", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  const start = source.indexOf("async function uploadWechatCover");
  const end = source.indexOf("async function ensureWechatEarlyMetadata", start);
  const flow = source.slice(start, end);
  assert.match(flow, /Input\.dispatchMouseEvent',\{type:'mouseMoved',x:prepared\.x,y:prepared\.y\}/, "hover-only edit controls must be revealed through cross-root coordinates");
  assert.match(flow, /roots\.map\(root=>root\.querySelector\(selector\)\)/, "the prepared cover card must be rediscovered across open shadow roots");
  assert.match(flow, /root\.elementFromPoint\(x,y\)/, "the edit click must prove its hit target inside the element's own root");
  assert.match(flow, /click\(\[entry\.x,entry\.y\]/, "the editor must open through a native pointer click");
  assert.match(flow, /if\(!dialogOpened\)return/, "upload must not begin until the cover dialog is visibly open");
});

test("WeChat current combined 3:4 cover layout does not require a removed horizontal slot", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  assert.match(source, /个人主页和分享卡片\\s\*\\\(3:4\\\)/, "the merged current-platform label must be detected exactly");
  assert.match(source, /combined_3x4/, "cover receipts must disclose the merged layout");
  assert.match(source, /filter\(asset=>asset\.slot==='vertical'\)/, "only the existing 3:4 slot may be required in merged layout");
  assert.match(source, /item\?\.confirmed===true/, "a current native upload confirmation receipt remains mandatory");
});

test("Ego task-space selection rejects a recycled id with another name", () => {
  const source = fs.readFileSync(path.join(DIR, "..", "ego", "core.mjs"), "utf8");
  const start = source.indexOf("async function selectTaskSpace");
  const end = source.indexOf("async function selectPlatformTab", start);
  assert.ok(start >= 0 && end > start, "task-space selector must remain discoverable");
  const selection = source.slice(start, end);
  assert.match(selection, /activeTaskSpace\.name !== taskName/);
  assert.match(selection, /reason: 'task_space_identity_mismatch'/);
  assert.match(selection, /activeTaskSpace = await useOrCreateTaskSpace\(taskName\)/);
});

test("Ego platform tab selection prefers the active matching tab", () => {
  const source = fs.readFileSync(path.join(DIR, "..", "ego", "core.mjs"), "utf8");
  const start = source.indexOf("async function selectPlatformTab");
  const end = source.indexOf("async function armFinalPublishGuard", start);
  assert.ok(start >= 0 && end > start, "platform-tab selector must remain discoverable");
  const selection = source.slice(start, end);
  assert.match(selection, /tabs\.filter\(tab => PLATFORM_HOSTS\[platform\]/);
  assert.match(selection, /matches\.find\(tab => tab\.active === true\) \|\| matches\[0\]/,
    "a responsive active platform tab must win over a stale background duplicate");
});

test("Bilibili upload waits for a real input and performs one bounded route recovery", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  const start = source.indexOf("async function waitForBilibiliUploadEntry");
  const end = source.indexOf("async function waitBilibiliUploadCompletion", start);
  assert.ok(start >= 0 && end > start, "upload-entry recovery must remain discoverable");
  const recovery = source.slice(start, end);
  assert.match(recovery, /attempt<=24/, "entry discovery needs a finite wait bound");
  assert.match(recovery, /attempt===6&&navigationAttempts===0/, "only one delayed route recovery may be attempted");
  assert.match(recovery, /videoEvidence\.anyUploaded!==true/, "route recovery must not navigate away from an uploaded draft");
  assert.match(recovery, /gotoAndWait\(PLATFORM_URLS\.bilibili/, "the recovery must use the exact maintained upload URL");
  assert.match(recovery, /const guard=await armFinalPublishGuard\(\)/, "route recovery must re-arm the final-publish guard after navigation");
  assert.match(recovery, /B站定向恢复后无法重新挂载最终发布保护/, "a missing post-navigation guard must fail closed");
  assert.match(recovery, /await activateBilibiliUploadLifecycle\(\);\s*await wait\(2\)/, "the newly navigated upload page must be activated before its input is accepted");
  assert.match(recovery, /resumeBilibiliLocalDraftIfPresent/, "a restore banner must be resolved inside the same readiness loop");
  assert.match(recovery, /exposeBilibiliVideoInput/, "success still requires the platform's real file input");
  assert.doesNotMatch(recovery, /createElement\(['"]input['"]\)/, "the adapter must never create a fake upload input");
  assert.match(source, /\.bcc-upload-wrapper input\[type=file\]/, "the active uploader input must be scoped away from Bilibili's detached file inputs");
  assert.match(source, /async function waitForBilibiliUploadStart/, "file injection must have a bounded upload-start verifier");
  assert.match(source, /attempt<=20/, "a silent injection failure must stop quickly instead of consuming the full upload window");
});

test("Bilibili cover repair continues after a rejected tag and preserves the blocker", async () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  for (const coverAccepted of [true, false]) {
    const calls = [];
    let coverOk = false;
    const receipt = { version: 2, assetPath: '/approved-4x3.webp', ratio: '4:3',
      afterUrl: 'https://archive.biliimg.com/bfs/archive/new.jpg' };
    const inspect = async () => ({ gates: {
      video: { ok: true }, title: { ok: true }, description: { ok: true }, original: { ok: true },
      tags: { ok: false }, cover: { ok: coverOk },
    } });
    const context = vm.createContext({
      pkg: { platformTitle: { bilibili: 'Approved title' }, bilibiliDescription: 'Approved body',
        bilibiliTags: ['AI'], bilibiliAllowedAutoTags: [],
        cover: { uploadCustomCover: true, horizontal4x3Path: receipt.assetPath } },
      videoPath: '/approved-video.mp4', expectedReceipts: {},
      readBrowserCoverRevisionSource: () => null,
      inspectStub: inspect,
      tagsStub: async () => { calls.push('tags'); return { ok: false, explicitPlatformRejection: true,
        requiresUser: true, reason: 'requested tag rejected' }; },
      coverStub: async () => { calls.push('cover'); coverOk = coverAccepted;
        return coverAccepted ? { ok: true, receipt } : { ok: false, reason: 'cover rejected' }; },
      checkpointReceipts: receipts => { calls.push('checkpoint'); return { ok: true }; },
      typedBlocker: (code, message, options) => ({ code, message, ...options }),
    });
    vm.runInContext(source + '\ninspectBilibili=inspectStub;rebuildBilibiliTagsV2=tagsStub;uploadBilibiliCoverV2=coverStub;', context);
    const result = await vm.runInContext('mutateBilibili()', context);
    assert.deepEqual(calls, ['tags', 'cover', 'checkpoint'], 'tag failure must not bypass independent cover repair');
    assert.equal(result.blocker.code, 'PLATFORM_REJECTED_METADATA');
    assert.equal(result.blocker.message, 'requested tag rejected');
    assert.equal(result.blocker.requiresUser, true);
    assert.equal(result.gates.cover.ok, coverAccepted);
    assert.equal(result.mutationBlockers.length, coverAccepted ? 1 : 2);
    assert.equal(result.receipts.cover?.afterUrl, coverAccepted ? receipt.afterUrl : undefined);
  }
});

test("Bilibili uses the 4:3 homepage master and receipt ratio", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "bilibili.mjs"), "utf8");
  assert.match(source, /pkg\.cover\?\.horizontal4x3Path/);
  assert.match(source, /添加主封面\|添加封面/, "cover entry repair must support the current 添加封面 label");
  assert.match(source, /receipt\.ratio==='4:3'/);
  assert.match(source, /ratio:'4:3'/);
  assert.match(source, /slots:\['homepage-4:3'\]/, 'do not claim a second slot without verification');
  assert.doesNotMatch(source, /pkg\.cover\?\.horizontal16x9Path/);
});

test('Bilibili rejects stale, unproven unchanged, blob and off-slot custom-cover receipts', () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, 'bilibili.mjs'), 'utf8');
  assert.match(source, /cover-content \.cover-main \.cover-module-main/);
  const matcher = source.slice(source.indexOf('function bilibiliCoverReceiptMatches('), source.indexOf('async function inspectBilibili('));
  const validUrl = 'https://archive.biliimg.com/bfs/archive/new.jpg';
  const oldUrl = 'https://archive.biliimg.com/bfs/archive/old.jpg';
  const asset = { ok: true, assetHash: 'a'.repeat(64) };
  const comparison = { ok: true, sourcePixelSha256: 'b'.repeat(64), nativePixelSha256: 'c'.repeat(64), comparisonMetrics: { rmse: 1, correlation: .999 } };
  const receipt = { version: 2, assetPath: '/cover.png', assetHash: asset.assetHash, ratio: '4:3', afterUrl: validUrl, beforeUrls: [oldUrl],
    verification: 'source-native-pixels-v1', sourcePixelSha256: comparison.sourcePixelSha256, nativePixelSha256: comparison.nativePixelSha256,
    comparisonMetrics: comparison.comparisonMetrics, sourcePreview: { fresh: true, assetHash: asset.assetHash, sourcePixelSha256: comparison.sourcePixelSha256 } };
  const check = (r, urls = [validUrl], current = comparison) => vm.runInNewContext(matcher + '\nbilibiliCoverReceiptMatches(receipt,urls,asset,comparison)', {
    bilibiliCoverPath: '/cover.png', receipt: r, urls, asset, comparison: current,
  });
  assert.equal(check(receipt), true);
  for (const patch of [{ version: 1 }, { assetHash: undefined }, { nativePixelSha256: 'f'.repeat(64) },
    { afterUrl: 'blob:https://member.bilibili.com/local' }, { assetPath: '/wrong.png' }, { sourcePreview: { fresh: false } }]) {
    assert.equal(check({ ...receipt, ...patch }, [patch.afterUrl || validUrl]), false);
  }
  assert.equal(check({ ...receipt, afterUrl: oldUrl, deduplicated: true }, [oldUrl]), true,
    'same URL still requires fresh source paint and independent current source/native pixel proof');
  assert.equal(check({ ...receipt, afterUrl: oldUrl, deduplicated: true, sourcePreview: undefined }, [oldUrl]), false);
  assert.equal(check(receipt, [validUrl], { ...comparison, ok: false }), false, 'black or wrong pixels cannot pass because their URL matches');
  assert.equal(check(receipt, [oldUrl]), false);
  assert.match(source, /deduplicated:before\.includes\(afterUrl\)/);
});

test("WeChat Channels refuses an unproven uploaded draft with an empty description", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "wechat-channels.mjs"), "utf8");
  assert.match(source, /identityAmbiguous=uploaded&&!description&&!trustedVideoReceipt/);
  assert.match(source, /expectedVideoReceipt\?\.fingerprint===jobFingerprint/);
  assert.match(source, /current\.gates\.draftIdentity=okGate\(\{trustedUploadAction:true,mode,uploadStartReceipt:/);
  assert.match(source, /if\(!before\.gates\.draftIdentity\.ok\)return/);
});

test("YouTube prefill repairs full details but defers thumbnail, visibility, and final save", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "youtube.mjs"), "utf8");
  const start = source.indexOf("async function prefillYoutube");
  const end = source.indexOf("async function mutateYoutube", start);
  assert.ok(start >= 0 && end > start, "YouTube prefill function must remain discoverable");
  const prefill = source.slice(start, end);
  assert.match(source, /stage: 'editable_uploading'/);
  assert.match(source, /controls: \{ title: visible\(titleEditor\), description: visible\(descriptionEditor\) \}/);
  assert.match(prefill, /ensureYoutubeMetadata\(before\)/);
  assert.doesNotMatch(prefill, /uploadYoutubeThumbnail|advanceYoutubeToVisibility|ensureYoutubeVisibility/);
  assert.doesNotMatch(source, /click\([^)]*done-button|click\([^)]*final/i, "the adapter must never click YouTube's final action");
});

test("YouTube final guard covers localized Save, Publish, and Schedule labels only on YouTube", () => {
  const source = fs.readFileSync(path.join(DIR, "..", "ego", "core.mjs"), "utf8");
  assert.match(source, /YOUTUBE_FINAL_TEXT = \/\^\(保存\|发布\|安排时间\|Save\|Publish\|Schedule\)\$\//);
  assert.match(source, /platform === 'youtube' \? YOUTUBE_FINAL_TEXT : FINAL_TEXT/);
});

test("YouTube corrections can clear all tags and replace a stale details receipt", () => {
  const source = fs.readFileSync(path.join(PLATFORM_DIR, "youtube.mjs"), "utf8");
  assert.match(source, /for \(const tag of youtubeTags\)/, "an empty requested list must skip additions after removing old chips");
  assert.match(source, /const detailsGatesReady = \['title', 'description', 'tags', 'audience', 'settings'\]/);
  assert.match(source, /currentDetailsComparable/);
  assert.match(source, /expectedReceipts\.details = receipts\.details/);
});
