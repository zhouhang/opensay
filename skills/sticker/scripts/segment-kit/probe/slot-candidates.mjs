/* Source hints are candidates only. They do not prove any module renders media. */
export function slotCandidates(rendererSrc, params) {
  const candidates = new Set(['text']);
  if (/:\s*number|number\(/i.test(params || '')) candidates.add('number');
  if (/new Image\(|createElement\(['"]img|<img\b/.test(rendererSrc)) candidates.add('image');
  if (/createElement\(['"]video|\.play\(\)|<video\b/.test(rendererSrc)) candidates.add('video');
  return [...candidates];
}
