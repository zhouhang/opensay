import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildIdentity } from "../lib/identity.mjs";
import { readPackage } from "../../lib/content-package.mjs";
import { defaultConfig } from "../../lib/config.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const bytesHash = value => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(callback) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-xhs-cover-identity-"));
  try {
    const cover = { uploadCustomCover: true };
    for (const key of ["vertical3x4Path", "horizontal4x3Path", "horizontal16x9Path"]) {
      cover[key] = path.join(root, `${key}.png`);
      await fs.promises.writeFile(cover[key], key);
    }
    const videoPath = path.join(root, "video.mp4");
    await fs.promises.writeFile(videoPath, "approved-video");
    const read = async value => {
      const packagePath = path.join(root, "package.json");
      await fs.promises.writeFile(packagePath, JSON.stringify({ title: "封面身份测试", videoPath, xhsTopics: ["AI"], cover: value }));
      return readPackage(packagePath, { config: defaultConfig() });
    };
    await callback({ cover, videoPath, root, read });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test("Xiaohongshu without nativeRatio retains the exact pre-selector identity formulas", async () => {
  await fixture(async ({ cover, videoPath, read }) => {
    const pkg = await read(cover);
    const identity = await buildIdentity(pkg);
    const assets = [cover.vertical3x4Path, cover.horizontal4x3Path, cover.horizontal16x9Path].map(assetPath => {
      const bytes = fs.readFileSync(assetPath);
      return { path: assetPath, size: bytes.length, sha256: bytesHash(bytes) };
    });
    const videoBytes = fs.readFileSync(videoPath);
    const video = { path: videoPath, size: videoBytes.length, sha256: bytesHash(videoBytes) };
    assert.equal(identity.fingerprint, digest({ package: pkg, video, assets }));
    assert.equal(identity.coverFingerprint, digest({ cover: pkg.cover, assets }));
    assert.equal(identity.coverFingerprints.xiaohongshu, digest({ enabled: true, vertical: assets[0] }));
    const { cover: _cover, ...contentPackage } = pkg;
    assert.equal(identity.contentFingerprint, digest({ package: contentPackage, video }));
    const oldPackage = { ...pkg, cover: {
      uploadCustomCover: true, vertical3x4Path: cover.vertical3x4Path,
      horizontal4x3Path: cover.horizontal4x3Path, horizontal16x9Path: cover.horizontal16x9Path,
    } };
    assert.equal(identity.legacyFingerprint, digest({ package: oldPackage, video, assets: assets.slice(0, 2) }));
    assert.equal(identity.previousFingerprint, digest({ package: oldPackage, video, assets }));
  });
});

test("explicit Xiaohongshu ratio changes only its platform cover fingerprint and preserves content identity", async () => {
  await fixture(async ({ cover, read }) => {
    const baseline = await buildIdentity(await read(cover));
    for (const nativeRatio of ["3:4", "4:3", "16:9"]) {
      const changed = await buildIdentity(await read({ ...cover, platforms: { xiaohongshu: { nativeRatio } } }));
      assert.notEqual(baseline.coverFingerprints.xiaohongshu, changed.coverFingerprints.xiaohongshu);
      assert.equal(baseline.contentFingerprint, changed.contentFingerprint);
      assert.equal(baseline.video.sha256, changed.video.sha256);
      for (const platform of ["douyin", "bilibili", "wechat_channels", "youtube"]) {
        assert.equal(baseline.coverFingerprints[platform], changed.coverFingerprints[platform]);
      }
    }
  });
});

test("explicit Xiaohongshu ratio fingerprints the selected asset rather than an unused portrait", async () => {
  await fixture(async ({ cover, root, read }) => {
    const portrait = path.join(root, "xhs-portrait.png");
    const landscape = path.join(root, "xhs-landscape.png");
    await fs.promises.writeFile(portrait, "portrait-before");
    await fs.promises.writeFile(landscape, "landscape-before");
    const pkg = await read({ ...cover, platforms: { xiaohongshu: {
      nativeRatio: "4:3", vertical3x4Path: portrait, horizontal4x3Path: landscape,
    } } });
    const before = await buildIdentity(pkg);
    await fs.promises.writeFile(portrait, "portrait-after");
    const unusedChanged = await buildIdentity(pkg);
    assert.equal(before.coverFingerprints.xiaohongshu, unusedChanged.coverFingerprints.xiaohongshu);
    await fs.promises.writeFile(landscape, "landscape-after");
    const selectedChanged = await buildIdentity(pkg);
    assert.notEqual(unusedChanged.coverFingerprints.xiaohongshu, selectedChanged.coverFingerprints.xiaohongshu);
    assert.equal(before.contentFingerprint, selectedChanged.contentFingerprint);
    for (const platform of ["douyin", "bilibili", "wechat_channels", "youtube"]) {
      assert.equal(before.coverFingerprints[platform], selectedChanged.coverFingerprints[platform]);
    }
  });
});

test("Xiaohongshu explicit portrait and widescreen identities bind their selected asset hashes", async () => {
  await fixture(async ({ cover, read }) => {
    for (const [nativeRatio, key] of [["3:4", "vertical3x4Path"], ["16:9", "horizontal16x9Path"]]) {
      const pkg = await read({ ...cover, platforms: { xiaohongshu: { nativeRatio } } });
      const identity = await buildIdentity(pkg);
      const selected = identity.assets.find(asset => asset.path === cover[key]);
      assert.equal(identity.coverFingerprints.xiaohongshu, digest({ enabled: true, nativeRatio, asset: selected }));
    }
  });
});
