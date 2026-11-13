import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = new URL('../../run-safe-platforms.sh', import.meta.url);
test('wrapper faithfully forwards comma, space, positional and recovery args and core exit status', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-publisher-wrapper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeNode = path.join(root, 'node');
  fs.writeFileSync(fakeNode, '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(17)\n', { mode: 0o755 });
  for (const args of [
    ['--package', '/a package.json', '--platforms', 'xiaohongshu,bilibili,youtube'],
    ['/package.json', 'suffix', 'xiaohongshu', 'bilibili', 'youtube'],
    ['--package', '/package.json', '--platform', 'xiaohongshu', '--platform', 'bilibili'],
    ['--package', '/package.json', '--operation', 'resume', '--job-id', 'original'],
    ['--package', '/package.json', '--inspect-only'],
    ['--package', '/package.json', '--operation', 'replace-cover', '--job-id', 'original'],
    ['--package', '/package.json', '--operation', 'update-tags', '--confirm-tag-change', '--job-id', 'original'],
  ]) {
    const result = spawnSync('/bin/bash', [wrapper.pathname, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
    assert.equal(result.status, 17, result.stderr);
    const forwarded = JSON.parse(result.stdout);
    assert.match(forwarded.shift(), /v2\/publisher\.mjs$/);
    assert.deepEqual(forwarded, args);
  }
  const source = fs.readFileSync(wrapper, 'utf8');
  assert.doesNotMatch(source, /pool_draftbox|grep|reset|fail-open|SKIP/);
});
