import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');
const helpers = source.slice(0, source.indexOf('async function inspectXiaohongshu'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function element({ text = '', classes = '', parent = null, visible = true, disabled = false, ariaDisabled = null, tag = 'BUTTON' } = {}) {
  return {
    tagName: tag, innerText: text, textContent: text, className: classes, parentElement: parent, disabled,
    style: { display: visible ? 'block' : 'none', visibility: 'visible', opacity: '1' },
    getAttribute(name) { return name === 'aria-disabled' ? ariaDisabled : null; },
    removeAttribute(name) { if (name === 'id') delete this.id; },
    getBoundingClientRect() { return { width: 100, height: 40 }; },
    querySelector() { return null; },
  };
}

function editorFixture({ mode = 'preview', disabledEdit = false, ariaDisabledEdit = null, hiddenEdit = false,
  hiddenEditAncestor = false, hiddenPreview = false, duplicateModal = false, missingModal = false,
  hiddenModal = false, nonButtonEdit = false, transitionWaits = 0, stuckPreview = false, editClickFails = false } = {}) {
  let edited = mode === 'edit' || mode === 'legacy';
  let cropOpen = false, pending = false, remaining = transitionWaits;
  const actions = [], waits = [];
  const modal = element({ classes: 'main-cover-editor-modal', visible: !hiddenModal, tag: 'DIV' });
  const hiddenParent = element({ parent: modal, visible: false, tag: 'DIV' });
  const edit = element({ text: '编辑', classes: 'video-panel-switch-item' + (mode === 'edit' ? ' active' : ''),
    parent: hiddenEditAncestor ? hiddenParent : modal, visible: !hiddenEdit, disabled: disabledEdit,
    ariaDisabled: ariaDisabledEdit, tag: nonButtonEdit ? 'DIV' : 'BUTTON' });
  const preview = element({ text: '预览', classes: 'video-panel-switch-item' + (mode === 'preview' ? ' active' : ''), parent: modal, visible: !hiddenPreview });
  let switches = mode === 'legacy' ? [] : [edit, preview];
  if (mode === 'missing-edit') { switches = [preview]; preview.className += ' active'; }
  if (mode === 'missing-preview') { switches = [edit]; edit.className += ' active'; }
  if (mode === 'duplicate-edit') { switches.push(element({ text: '编辑', classes: 'video-panel-switch-item', parent: modal })); preview.className += ' active'; }
  if (mode === 'ambiguous-active') { edit.className += ' active'; preview.className += ' active'; }
  if (mode === 'no-active') { edit.className = preview.className = 'video-panel-switch-item'; }
  const crop = element({ text: '裁剪', classes: 'item', parent: modal });
  const unrelatedToolbar = element({ text: 'AI修改', classes: 'item active', parent: modal });
  const ratios = ['4:3', '3:4'].map(label => {
    const el = element({ classes: 'ratio-option' + (label === '4:3' ? ' active' : ''), parent: modal });
    el.querySelector = selector => selector === '.ratio-label' ? element({ text: label, parent: el }) : null;
    return el;
  });
  modal.querySelectorAll = selector => selector === '.video-panel-switch-item' ? switches
    : selector === '.items .item' ? edited ? [unrelatedToolbar, crop] : [unrelatedToolbar]
      : selector === '.crop-panel .ratio-list button.ratio-option' && edited && cropOpen ? ratios : [];
  const all = [modal, edit, preview, crop, ...ratios];
  const document = { querySelectorAll: selector => selector === '.main-cover-editor-modal'
    ? missingModal ? [] : duplicateModal ? [modal, element({ tag: 'DIV' })] : [modal]
    : selector.startsWith('#') ? all.filter(el => el.id === selector.slice(1)) : [] };
  const js = expression => vm.runInNewContext(expression, { document, getComputedStyle: el => el.style });
  const activateEdit = () => { edited = true; edit.className = 'video-panel-switch-item active'; preview.className = 'video-panel-switch-item'; };
  const click = async selector => {
    const exact = document.querySelectorAll(selector);
    assert.equal(exact.length, 1, 'click must target one marked native control');
    if (selector === '#vp2-xhs-native-cover-edit') {
      assert.equal(exact[0], edit);
      actions.push('edit');
      if (editClickFails) throw new Error('native click failed');
      pending = true;
      if (!remaining && !stuckPreview) activateEdit();
      return;
    }
    assert.equal(edited, true, 'ratio/crop work cannot precede actual edit mode');
    if (selector === '#vp2-xhs-native-crop') { actions.push('crop'); cropOpen = true; return; }
    if (selector === '#vp2-xhs-native-ratio') {
      actions.push('ratio');
      assert.equal(cropOpen, true);
      ratios.forEach(el => { el.className = 'ratio-option' + (el === exact[0] ? ' active' : ''); });
      return;
    }
    assert.fail('unexpected control: ' + selector);
  };
  const wait = async seconds => {
    waits.push(seconds);
    if (pending && !stuckPreview && --remaining <= 0) activateEdit();
  };
  const run = new AsyncFunction('pkg', 'videoPath', 'js', 'click', 'wait', `${helpers}\nreturn selectXhsCoverNativeRatio();`);
  return { actions, waits, select: () => run({ platformTitle: { xiaohongshu: 'Approved' }, xhsTopics: [], cover: { nativeRatio: '3:4', vertical3x4Path: '/approved/portrait.png' } }, '/video.mp4', js, click, wait) };
}

test('XHS observed preview mode switches via the real edit button before native crop and ratio selection', async () => {
  const fixture = editorFixture();
  const result = await fixture.select();
  assert.equal(result.ok, true);
  assert.equal(result.actual, '3:4');
  assert.deepEqual(fixture.actions, ['edit', 'crop', 'ratio']);
});

test('XHS waits for observed edit activation before opening crop, without a second mode click', async () => {
  const fixture = editorFixture({ transitionWaits: 2 });
  assert.equal((await fixture.select()).ok, true);
  assert.deepEqual(fixture.actions, ['edit', 'crop', 'ratio']);
  assert.deepEqual(fixture.waits.slice(0, 2), [.25, .25]);
});

test('XHS already-edit and old no-switch layouts retain the original native crop path', async () => {
  for (const mode of ['edit', 'legacy']) {
    const fixture = editorFixture({ mode });
    assert.equal((await fixture.select()).ok, true);
    assert.deepEqual(fixture.actions, ['crop', 'ratio']);
  }
});

test('XHS mode controls missing, duplicated, hidden, disabled or non-button block before crop clicks', async () => {
  for (const options of [
    { mode: 'missing-edit' }, { mode: 'missing-preview' }, { mode: 'duplicate-edit' },
    { mode: 'ambiguous-active' }, { mode: 'no-active' }, { hiddenEdit: true },
    { hiddenEditAncestor: true }, { hiddenPreview: true }, { disabledEdit: true },
    { ariaDisabledEdit: 'true' }, { nonButtonEdit: true },
    { duplicateModal: true }, { missingModal: true }, { hiddenModal: true },
  ]) {
    const fixture = editorFixture(options);
    assert.equal((await fixture.select()).ok, false, JSON.stringify(options));
    assert.deepEqual(fixture.actions, [], JSON.stringify(options));
  }
});

test('XHS unconfirmed mode activation times out within two seconds and never attempts crop', async () => {
  const fixture = editorFixture({ stuckPreview: true });
  const result = await fixture.select();
  assert.equal(result.ok, false);
  assert.match(result.reason, /edit mode did not become active/);
  assert.deepEqual(fixture.actions, ['edit']);
  assert.equal(fixture.waits.length, 8);
  assert.equal(fixture.waits.reduce((sum, seconds) => sum + seconds, 0), 2);
});

test('XHS edit click failure does not reach crop, confirmation or any publishing control', async () => {
  const fixture = editorFixture({ editClickFails: true });
  const result = await fixture.select();
  assert.equal(result.ok, false);
  assert.match(result.reason, /native click failed/);
  assert.deepEqual(fixture.actions, ['edit']);
});
