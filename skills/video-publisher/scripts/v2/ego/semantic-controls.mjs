async function semanticButtons(pattern) {
  const tree = await cdp('Accessibility.getFullAXTree', {});
  const matches = value => { pattern.lastIndex = 0; return pattern.test(value); };
  const candidates = (tree.nodes || []).filter(node => !node.ignored && node.role?.value === 'button'
    && matches(node.name?.value || '') && node.backendDOMNodeId);
  const result = [];
  for (const node of candidates) {
    const resolved = await cdp('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) continue;
    const inspected = await cdp('Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect(), style = getComputedStyle(this);
        const root = this.getRootNode();
        return { text: String(this.innerText || this.textContent || '').trim(), tag: this.tagName,
          disabled: Boolean(this.disabled) || this.getAttribute('aria-disabled') === 'true',
          connected: this.isConnected, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          width: rect.width, height: rect.height, shadowMode: root.mode || null, hostTag: root.host?.tagName || null };
      }` });
    if (inspected.exceptionDetails) throw new Error('Native button inspection failed');
    const value = inspected.result?.value;
    if (value?.connected && value.visible && value.tag === 'BUTTON' && matches(value.text)) {
      result.push({ ...value, objectId, backendNodeId: node.backendDOMNodeId, buttonish: true, source: 'accessibility' });
    }
  }
  return result;
}

async function clickDedicatedDraftButton(labels) {
  if (phase !== 'persist') throw new Error('Draft save is allowed only in persist phase');
  // Only draft-saving labels are allowed here, never an arbitrary caller label.
  const allowed = ['暂存离开', '保存草稿', '存草稿'];
  if (!labels.length || labels.some(label => !allowed.includes(label))) throw new Error('Unsafe draft control label');
  const pattern = new RegExp(`^(?:${labels.join('|')})$`);
  const buttons = (await semanticButtons(pattern)).filter(button => !button.disabled);
  if (buttons.length !== 1) return { ok: false, reason: 'dedicated draft control not unique or disabled', count: buttons.length };
  await armFinalPublishGuard();
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { ok: false, reason: 'publish safety guard failed' };
  const response = await cdp('Runtime.callFunctionOn', { objectId: buttons[0].objectId,
    arguments: [{ value: labels }], returnByValue: true,
    functionDeclaration: `function(labels) {
      const text = String(this.innerText || this.textContent || '').trim();
      const rect = this.getBoundingClientRect(), style = getComputedStyle(this);
      if (this.tagName !== 'BUTTON' || !this.isConnected || this.disabled || this.getAttribute('aria-disabled') === 'true'
        || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden'
        || !labels.includes(text)) return {ok:false};
      this.click(); return {ok:true, label:text};
    }` });
  if (response.exceptionDetails) throw new Error('Draft save result is uncertain; do not retry blindly');
  return response.result?.value || { ok: false, reason: 'draft control disappeared' };
}

async function clickDedicatedDraftSelector(selector, label, tagName) {
  if (!['persist', 'quarantine'].includes(phase)) throw new Error('Draft save is allowed only in persist or quarantine phase');
  if (!['暂存离开', '保存草稿', '存草稿'].includes(label)) throw new Error('Unsafe draft control label');
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { ok: false, reason: 'publish safety guard failed' };
  const point = await js(`(args => {
    const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll(args.selector)].filter(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return el.tagName === args.tagName && compact(el.innerText || el.textContent || '') === args.label
        && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    });
    if (nodes.length !== 1) return { ok: false, count: nodes.length };
    nodes[0].scrollIntoView({ block: 'center', inline: 'center' });
    const rect = nodes[0].getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { ok: hit === nodes[0] || nodes[0].contains(hit), x, y,
      viewport: { width: innerWidth, height: innerHeight }, hit: hit ? { tag: hit.tagName, className: String(hit.className || '') } : null };
  })(${JSON.stringify({ selector, label, tagName })})`);
  if (!point.ok) return { ok: false, reason: 'dedicated draft selector changed or remained outside the actionable viewport', count: point.count, evidence: point };
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return { ok: true, label, selector };
}

async function armClosedShadowPublishGuards(pattern) {
  const buttons = await semanticButtons(pattern);
  for (const button of buttons.filter(button => button.shadowMode === 'closed')) {
    const response = await cdp('Runtime.callFunctionOn', { objectId: button.objectId, returnByValue: true,
      arguments: [{ value: FINAL_GUARD_KEY }, { value: pattern.source }, { value: pattern.flags }],
      functionDeclaration: `function(key, source, flags) {
        const root = this.getRootNode(), state = this.ownerDocument.defaultView[key];
        if (!state?.armed || root.mode !== 'closed') return {ok:false};
        if (root[key]?.state === state) return {ok:true};
        if (root[key]?.guard) {
          root.removeEventListener('click', root[key].guard, true);
          root.removeEventListener('submit', root[key].guard, true);
        }
        const re = new RegExp(source, flags);
        const guard = event => {
          const label = [event.submitter, ...event.composedPath()].filter(Boolean)
            .filter(el => el.matches?.('button,input[type=submit],[role=button]'))
            .map(el => String(el.value || el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim())
            .find(text => { re.lastIndex = 0; return re.test(text); });
          if (!label) return;
          event.preventDefault(); event.stopImmediatePropagation();
          state.blockedAttempts.push({type:event.type,label,at:new Date().toISOString(),scope:'closed-shadow'});
        };
        root.addEventListener('click', guard, true); root.addEventListener('submit', guard, true);
        root[key] = {state,guard}; return {ok:true};
      }` });
    if (response.result?.value?.ok !== true) throw new Error('Closed-shadow publish guard could not be armed');
  }
}

async function inspectClosedShadowPublishGuards(pattern) {
  const buttons = await semanticButtons(pattern);
  let protectedButtons = 0;
  for (const button of buttons.filter(button => button.shadowMode === 'closed')) {
    const response = await cdp('Runtime.callFunctionOn', { objectId: button.objectId, returnByValue: true,
      arguments: [{ value: FINAL_GUARD_KEY }],
      functionDeclaration: `function(key) {
        const root = this.getRootNode(), state = this.ownerDocument.defaultView[key];
        return this.isConnected && state?.armed === true && root[key]?.state === state && typeof root[key]?.guard === 'function';
      }` });
    if (response.result?.value !== true || response.exceptionDetails) return { ok: false, protectedButtons };
    protectedButtons++;
  }
  return { ok: true, protectedButtons };
}
