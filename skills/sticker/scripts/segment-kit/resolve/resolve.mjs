/* resolve：把「探测事实 + 模板声明（可选）+ 引擎政策」合并成引擎唯一认的 resolved contract。
 *
 * 权责（与 SKILL 一致）：
 *   - 政策（合格线）：引擎独占，声明不能覆盖
 *   - 事实（可测量）：以实测为准；声明作为待验清单，通过核对才采纳
 *   - 语义（测不出）：声明优先
 *
 * 用法：
 *   node resolve/resolve.mjs --probe .cache/x.probe.json \
 *     [--declaration /path/to/capability/segments.v2.json] \
 *     --out .cache/x.resolved.json --report .cache/x.report.json
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const probePath = path.resolve(val('probe'));
const declPath = val('declaration') ? path.resolve(val('declaration')) : null;
const outPath = path.resolve(val('out', '.cache/resolved.json'));
const reportPath = val('report') ? path.resolve(val('report')) : outPath.replace(/\.json$/, '.report.json');

const ENGINE_VERSION = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'VERSION'), 'utf8').trim();
const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));

// ── 引擎政策（声明不可覆盖）─────────────────────────────
const POLICY = {
  version: ENGINE_VERSION,
  minShotSeconds: 2.5,
  // 底部 8% 以上被片段自身内容占用 → 字幕压上去会打架，收窄字幕带
  captionCollisionThreshold: 0.08,
  captionBandNormal: [0.80, 0.97],
  captionBandCollision: [0.90, 0.97],
  // 片段动效结束后还能撑多久（有环境动 vs 完全静止）
  holdWithAmbient: 4.5,
  holdWithoutAmbient: 2.0,
  // 每镜至少要有的结构性变化间隔上限（秒）
  maxGapBetweenChanges: 2.5,
};

let declaration = null;
if (declPath && fs.existsSync(declPath)) {
  declaration = JSON.parse(fs.readFileSync(declPath, 'utf8'));
}
const declById = new Map((declaration?.segments || []).map(s => [s.id, s]));
const declUsable = !!declaration
  && declaration.contractVersion === 'segment-v2'
  && declaration.rendererSha256 === probe.rendererSha256;

const report = {
  engineVersion: ENGINE_VERSION,
  templateId: probe.templateId,
  templatePath: probe.templatePath,
  rendererSha256: probe.rendererSha256,
  declaration: declPath ? { path: declPath, present: true, usable: declUsable, reason: declUsable ? 'ok' : (declaration?.rendererSha256 === probe.rendererSha256 ? 'contractVersion mismatch' : 'rendererSha256 mismatch') } : { present: false, usable: false, reason: '模板未带 capability/segments.v2.json（本次纯探测）' },
  policy: POLICY,
  segments: [],
};

const resolved = {
  contractVersion: 'segment-v2',
  source: 'resolved',
  engineVersion: ENGINE_VERSION,
  templateId: probe.templateId,
  templatePath: probe.templatePath,
  rendererSha256: probe.rendererSha256,
  resolvedAt: new Date().toISOString(),
  canvas: probe.canvas,
  segments: [],
};

for (const seg of probe.segments) {
  if (seg.error) {
    resolved.segments.push({ id: seg.id, error: seg.error });
    report.segments.push({ id: seg.id, status: 'failed', error: seg.error });
    continue;
  }
  const decl = declUsable ? declById.get(seg.id) : null;
  const accepted = [];
  const overridden = [];

  // 事实字段：实测优先；声明值仅用于核对
  const fact = {
    states: seg.states,
    settleSeconds: seg.settleSeconds,
    ambient: seg.ambient,
    suggestedShot: { ...seg.suggestedShot },
    assetSlots: seg.assetSlotsVerified === true ? (seg.assetSlots || []) : [],
    assetSlotsVerified: seg.assetSlotsVerified === true,
  };
  if (decl?.states?.length) {
    const declaredAt = decl.states.map(s => s.at).sort((a, b) => a - b);
    const measuredAt = fact.states.map(s => s.at);
    const matched = declaredAt.filter(t => measuredAt.some(m => Math.abs(m - t) <= 0.25)).length;
    if (matched / declaredAt.length >= 0.7) accepted.push(`states(${matched}/${declaredAt.length} 核对命中)`);
    else overridden.push({ field: 'states', declared: declaredAt, measured: measuredAt, reason: '声明切点与实测不符' });
  }
  if (decl?.settleSeconds != null) {
    if (Math.abs(decl.settleSeconds - fact.settleSeconds) <= 0.35) accepted.push('settleSeconds');
    else overridden.push({ field: 'settleSeconds', declared: decl.settleSeconds, measured: fact.settleSeconds, reason: '最后结构性变化时间以实测为准' });
  }
  if (decl?.assetSlots) {
    const missing = decl.assetSlots.filter(s => !fact.assetSlots.includes(s));
    if (missing.length) overridden.push({ field: 'assetSlots', declared: decl.assetSlots, measured: fact.assetSlots, reason: `逐模块素材渲染未验证：${missing.join('/')}（declared-but-unverified；源码提示不能证明支持或不支持）` });
    else if (fact.assetSlotsVerified) accepted.push('assetSlots');
  }

  // 政策字段
  const collision = seg.bottomOccupancy > POLICY.captionCollisionThreshold;
  const captionBand = collision ? POLICY.captionBandCollision : POLICY.captionBandNormal;
  const hold = seg.ambient ? POLICY.holdWithAmbient : POLICY.holdWithoutAmbient;
  const maxShot = Math.round(Math.min(20, Math.max(fact.suggestedShot.max, fact.settleSeconds + hold)) * 2) / 2;
  const minShot = Math.max(POLICY.minShotSeconds, fact.suggestedShot.min);
  const ideal = Math.min(maxShot, Math.max(minShot, Math.round((fact.settleSeconds + 0.4) * 2) / 2));

  // This is measured source cadence, not semantic or production certification.
  const points = [0, ...(fact.states || []).map(s => Number(s.at))].sort((a, b) => a - b);
  const cadenceGaps = [];
  for (let i = 1; i < points.length; i++) {
    const seconds = points[i] - points[i - 1];
    if (!Number.isFinite(seconds) || seconds > POLICY.maxGapBetweenChanges + 0.001)
      cadenceGaps.push({ from: points[i - 1], to: points[i], seconds });
  }
  const cadencePassed = cadenceGaps.length === 0 && points.length > 1;
  const diagnosticPassed = cadencePassed && fact.assetSlotsVerified && seg.probeConfidence !== 'low';
  // Source cadence and slots alone never certify the full consumer contract.
  const productionReady = false;

  resolved.segments.push({
    id: seg.id,
    name: decl?.name || seg.name,
    expresses: decl?.expresses || seg.expresses,
    notExpresses: decl?.notExpresses || seg.notExpresses,
    sourceReference: seg.sourceReference,
    states: fact.states,
    settleSeconds: fact.settleSeconds,
    ambient: fact.ambient,
    changeRate: seg.changeRate,
    suggestedShot: { min: minShot, ideal, max: maxShot },
    assetSlots: fact.assetSlots,
    assetSlotsVerified: fact.assetSlotsVerified,
    assetSlotCandidates: seg.assetSlotCandidates || [],
    captionSafeBand: captionBand,
    bottomOccupancy: seg.bottomOccupancy,
    captionCollision: collision,
    probeConfidence: seg.probeConfidence,
    policyApplied: ['captionSafeBand', 'suggestedShot.max'],
    cadencePolicy: { maxGapBetweenChanges: POLICY.maxGapBetweenChanges, passed: cadencePassed, gaps: cadenceGaps },
    production_ready: productionReady,
  });
  report.segments.push({ id: seg.id, status: diagnosticPassed ? 'diagnostic-ok' : 'needs-review', accepted, overridden, captionCollision: collision, cadencePassed, cadenceGaps, production_ready: productionReady, production_check: 'shared-consumer-required', reasons: [...(!cadencePassed ? ['SOURCE_CADENCE_GAP: review reading/semantic events in the actual shot'] : []), ...(!fact.assetSlotsVerified ? ['MEDIA_SLOTS_UNVERIFIED: run per-module media fixtures through shared builder-check'] : [])] });
}

report.production_ready = report.segments.length > 0 && report.segments.every(s => s.production_ready === true);
resolved.production_ready = report.production_ready;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(resolved, null, 1) + '\n');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({
  out: path.relative(process.cwd(), outPath), report: path.relative(process.cwd(), reportPath),
  segments: resolved.segments.length,
  declarationUsed: declUsable,
  production_ready: report.production_ready,
  collisions: resolved.segments.filter(s => s.captionCollision).map(s => s.id),
}));

if (report.segments.some(s => s.status === 'failed' || s.cadencePassed === false)) process.exitCode = 2;
