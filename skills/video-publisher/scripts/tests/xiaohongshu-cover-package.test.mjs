import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../lib/config.mjs";
import { coverAssetsForPlatform, coverForPlatform, readPackage, validateXiaohongshuPackage } from "../lib/content-package.mjs";

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0x89;
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function fixture(callback) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-xhs-cover-package-"));
  try {
    const cover = { uploadCustomCover: true };
    for (const [key, width, height] of [
      ["vertical3x4Path", 1080, 1440],
      ["horizontal4x3Path", 1600, 1200],
      ["horizontal16x9Path", 1920, 1080],
    ]) {
      cover[key] = path.join(root, `${key}.png`);
      await fs.promises.writeFile(cover[key], pngHeader(width, height));
    }
    const read = async value => {
      const packagePath = path.join(root, "package.json");
      await fs.promises.writeFile(packagePath, JSON.stringify({ title: "封面测试", xhsTopics: ["AI"], cover: value }));
      return readPackage(packagePath, { config: defaultConfig() });
    };
    await callback({ cover, read });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test("Xiaohongshu absent nativeRatio preserves the legacy normalized cover shape and mapping", async () => {
  await fixture(async ({ cover, read }) => {
    const pkg = await read(cover);
    assert.deepEqual(pkg.cover.platforms.xiaohongshu, {
      vertical3x4Path: "", horizontal4x3Path: "", horizontal16x9Path: "",
    });
    assert.equal(Object.hasOwn(pkg.cover.platforms.xiaohongshu, "nativeRatio"), false);
    assert.equal(Object.hasOwn(coverForPlatform(pkg, "xiaohongshu"), "nativeRatio"), false);
    assert.deepEqual(coverAssetsForPlatform(pkg, "xiaohongshu"), [
      { slot: "portrait", ratio: "3:4", path: cover.vertical3x4Path },
    ]);
    assert.deepEqual(validateXiaohongshuPackage(pkg), []);
  });
});

for (const [nativeRatio, key, slot] of [
  ["3:4", "vertical3x4Path", "portrait"],
  ["4:3", "horizontal4x3Path", "landscape"],
  ["16:9", "horizontal16x9Path", "landscape"],
]) {
  test(`Xiaohongshu explicit ${nativeRatio} selects only the corresponding native cover asset`, async () => {
    await fixture(async ({ cover, read }) => {
      const pkg = await read({ ...cover, platforms: { xiaohongshu: { nativeRatio: ` ${nativeRatio} ` } } });
      assert.equal(pkg.cover.platforms.xiaohongshu.nativeRatio, nativeRatio);
      assert.equal(coverForPlatform(pkg, "xiaohongshu").nativeRatio, nativeRatio);
      assert.deepEqual(coverAssetsForPlatform(pkg, "xiaohongshu"), [{ slot, ratio: nativeRatio, path: cover[key] }]);
      assert.deepEqual(validateXiaohongshuPackage(pkg), []);
    });
  });
}

test("Xiaohongshu nativeRatio remains platform-specific and does not leak to sibling adapters", async () => {
  await fixture(async ({ cover, read }) => {
    const pkg = await read({ ...cover, nativeRatio: "16:9", platforms: {
      xiaohongshu: { nativeRatio: "4:3" },
      youtube: { nativeRatio: "3:4" },
    } });
    assert.equal(Object.hasOwn(pkg.cover, "nativeRatio"), false);
    assert.equal(Object.hasOwn(pkg.cover.platforms.youtube, "nativeRatio"), false);
    for (const platform of ["douyin", "bilibili", "wechat_channels", "youtube"]) {
      assert.equal(Object.hasOwn(coverForPlatform(pkg, platform), "nativeRatio"), false);
    }
    assert.deepEqual(coverAssetsForPlatform(pkg, "youtube"), [
      { slot: "thumbnail", ratio: "16:9", path: cover.horizontal16x9Path },
    ]);
    assert.equal(Object.hasOwn(coverForPlatform({ cover: { ...cover, nativeRatio: "4:3" } }, "youtube"), "nativeRatio"), false);
  });
});

test("Xiaohongshu rejects unknown or explicitly empty native ratios instead of falling back to portrait", async () => {
  await fixture(async ({ cover, read }) => {
    for (const nativeRatio of ["1:1", "landscape", "", null, 0]) {
      const pkg = await read({ ...cover, platforms: { xiaohongshu: { nativeRatio } } });
      assert.equal(Object.hasOwn(pkg.cover.platforms.xiaohongshu, "nativeRatio"), true);
      assert.deepEqual(coverAssetsForPlatform(pkg, "xiaohongshu"), []);
      assert.match(validateXiaohongshuPackage(pkg).join("; "), /nativeRatio must be 3:4, 4:3, or 16:9/);
    }
  });
});

test("Xiaohongshu explicit landscape ratio rejects a missing landscape asset despite an available portrait", async () => {
  await fixture(async ({ cover, read }) => {
    for (const nativeRatio of ["4:3", "16:9"]) {
      const pkg = await read({ uploadCustomCover: true, vertical3x4Path: cover.vertical3x4Path,
        platforms: { xiaohongshu: { nativeRatio } } });
      assert.deepEqual(coverAssetsForPlatform(pkg, "xiaohongshu"), []);
      assert.match(validateXiaohongshuPackage(pkg).join("; "), /no cover asset is mapped for xiaohongshu/);
    }
  });
});

test("Xiaohongshu rejects reversed native-cover image dimensions in both directions", async () => {
  await fixture(async ({ cover, read }) => {
    for (const [nativeRatio, key, incorrectPath] of [
      ["4:3", "horizontal4x3Path", cover.vertical3x4Path],
      ["3:4", "vertical3x4Path", cover.horizontal4x3Path],
      ["16:9", "horizontal16x9Path", cover.horizontal4x3Path],
    ]) {
      const pkg = await read({ ...cover, platforms: { xiaohongshu: { nativeRatio, [key]: incorrectPath } } });
      assert.match(validateXiaohongshuPackage(pkg).join("; "), new RegExp(`expected ${nativeRatio}, got`));
    }
  });
});

test("Xiaohongshu selected cover honors its per-platform path override only", async () => {
  await fixture(async ({ cover, read }) => {
    const pkg = await read({ ...cover, platforms: { xiaohongshu: {
      nativeRatio: "4:3", horizontal4x3Path: cover.horizontal4x3Path,
    } } });
    assert.deepEqual(coverAssetsForPlatform(pkg, "xiaohongshu"), [
      { slot: "landscape", ratio: "4:3", path: cover.horizontal4x3Path },
    ]);
    assert.equal(coverAssetsForPlatform(pkg, "bilibili")[0].path, cover.horizontal4x3Path);
  });
});
