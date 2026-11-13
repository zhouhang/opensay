import test from "node:test";
import assert from "node:assert/strict";
import { validateTagRevision } from "../lib/tag-revision.mjs";

const PLATFORMS = ["xiaohongshu", "douyin", "bilibili", "wechat_channels", "youtube"];

function fixture() {
  const pkg = {
    videoPath: "/approved/video.mp4",
    title: "Approved title",
    platformTitle: Object.fromEntries(PLATFORMS.map(platform => [platform, "Approved title"])),
    description: "Approved prose.\nSecond paragraph.",
    xhsDescription: "Approved XHS prose.",
    douyinDescription: "Approved Douyin prose.",
    bilibiliDescription: "Approved Bilibili prose.",
    wechatDescription: "Approved WeChat prose.\nSecond paragraph.\n\n#Before",
    youtubeDescription: "Approved YouTube prose.",
    tags: ["Before"],
    xhsTopics: ["Before"],
    douyinTopics: ["Before"],
    bilibiliTags: ["Before"],
    wechatTags: ["Before"],
    youtubeTags: ["Before"],
    youtubeAudience: "not_made_for_kids",
    youtubeVisibility: "private",
    youtubeCategory: "27",
    youtubeLicense: "standard_youtube",
    youtubePaidPromotion: false,
    cover: { uploadCustomCover: true, vertical3x4Path: "/approved/cover.png", platforms: {} },
    approvedSettings: { nested: { original: true }, values: [false, 1, "value"] },
  };
  const identity = {
    fingerprint: "old-package-fingerprint",
    contentFingerprint: "old-content-fingerprint",
    previousFingerprint: "old-previous-fingerprint",
    legacyFingerprint: "old-legacy-fingerprint",
    video: { path: "/approved/video.mp4", size: 10, sha256: "approved-video-hash" },
    assets: [{ path: "/approved/cover.png", size: 12, sha256: "approved-cover-hash" }],
    cover: structuredClone(pkg.cover),
    coverFingerprint: "approved-cover-fingerprint",
    coverFingerprints: Object.fromEntries(PLATFORMS.map(platform => [platform, `approved-${platform}-cover`])),
  };
  return {
    previousPackage: pkg,
    nextPackage: structuredClone(pkg),
    previousIdentity: identity,
    nextIdentity: { ...structuredClone(identity), fingerprint: "new-package-fingerprint", contentFingerprint: "new-content-fingerprint" },
    platforms: [...PLATFORMS],
    existingPlatforms: [...PLATFORMS],
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("each explicit tag array changes only its platform and preserves input objects", () => {
  const fields = { xhsTopics: "xiaohongshu", douyinTopics: "douyin", bilibiliTags: "bilibili", wechatTags: "wechat_channels", youtubeTags: "youtube" };
  for (const [field, platform] of Object.entries(fields)) {
    const input = fixture();
    input.nextPackage[field] = ["After", "Another"];
    input.platforms = [platform];
    const before = structuredClone(input);
    deepFreeze(input);
    assert.deepEqual(validateTagRevision(input), { affectedPlatforms: [platform] });
    assert.deepEqual(input, before);
  }
});

test("all platform tag arrays can change in one revision with deterministic ordering", () => {
  const input = fixture();
  for (const field of ["tags", "xhsTopics", "douyinTopics", "bilibiliTags", "wechatTags", "youtubeTags"]) input.nextPackage[field] = ["After"];
  input.platforms.reverse();
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: PLATFORMS });
});

test("shared tags affect every platform which falls back to them", () => {
  const input = fixture();
  for (const field of ["xhsTopics", "douyinTopics", "bilibiliTags", "wechatTags", "youtubeTags"]) {
    delete input.previousPackage[field];
    delete input.nextPackage[field];
  }
  input.nextPackage.tags = ["After"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: PLATFORMS });
});

test("topics fallback precedence and explicit empty arrays match readPackage", () => {
  const input = fixture();
  for (const field of ["xhsTopics", "douyinTopics", "bilibiliTags", "wechatTags", "youtubeTags"]) {
    delete input.previousPackage[field];
    delete input.nextPackage[field];
  }
  input.previousPackage.topics = ["Topic"];
  input.nextPackage.topics = ["Topic"];
  input.previousPackage.bilibiliTags = [];
  input.nextPackage.bilibiliTags = [];
  input.nextPackage.tags = ["After"];
  input.platforms = ["youtube"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["youtube"] });
});

test("tag ordering is exact while raw hashtag cleanup follows package normalization", () => {
  const input = fixture();
  input.previousPackage.youtubeTags = ["One", "Two"];
  input.nextPackage.youtubeTags = ["Two", "One"];
  input.platforms = ["youtube"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["youtube"] });
  input.nextPackage.youtubeTags = ["#One", " Two ", "One"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: [] });
});

test("no affected platforms is accepted for idempotent resume", () => {
  const input = fixture();
  input.nextIdentity = structuredClone(input.previousIdentity);
  input.platforms = ["youtube"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: [] });
  input.nextPackage.tags = ["Unused shared tags"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: [] });
});

test("every affected existing draft must be selected", () => {
  const input = fixture();
  input.nextPackage.xhsTopics = ["After"];
  input.nextPackage.youtubeTags = ["After"];
  input.platforms = ["youtube"];
  assert.throws(() => validateTagRevision(input), /every existing draft whose tags changed: xiaohongshu/);
});

test("changed tags for a platform absent from the job do not require targeting it", () => {
  const input = fixture();
  input.nextPackage.xhsTopics = ["After"];
  input.nextPackage.youtubeTags = ["After"];
  input.platforms = ["youtube"];
  input.existingPlatforms = { youtube: { status: "ready" } };
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["xiaohongshu", "youtube"] });
});

test("selected platforms absent from the job are rejected even for an unchanged package", () => {
  const input = fixture();
  input.existingPlatforms = ["youtube"];
  input.platforms = ["xiaohongshu", "youtube"];
  assert.throws(() => validateTagRevision(input), /platform absent from this job: xiaohongshu/);
});

test("unchanged selected platforms are accepted alongside an affected platform", () => {
  const input = fixture();
  input.nextPackage.youtubeTags = ["After"];
  input.platforms = ["douyin", "youtube"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["youtube"] });
});

test("title, prose, settings, cover paths and exact video path cannot change", () => {
  const edits = {
    title: pkg => { pkg.title += " "; },
    platformTitle: pkg => { pkg.platformTitle.youtube += "!"; },
    description: pkg => { pkg.description += "\n"; },
    xhsDescription: pkg => { pkg.xhsDescription += "!"; },
    douyinDescription: pkg => { pkg.douyinDescription += "!"; },
    bilibiliDescription: pkg => { pkg.bilibiliDescription += "!"; },
    youtubeDescription: pkg => { pkg.youtubeDescription += "!"; },
    youtubeAudience: pkg => { pkg.youtubeAudience = "made_for_kids"; },
    youtubeVisibility: pkg => { pkg.youtubeVisibility = "unlisted"; },
    youtubeCategory: pkg => { pkg.youtubeCategory = "28"; },
    youtubeLicense: pkg => { pkg.youtubeLicense = "creative_commons"; },
    youtubePaidPromotion: pkg => { pkg.youtubePaidPromotion = true; },
    cover: pkg => { pkg.cover.vertical3x4Path = "/different/cover.png"; },
    videoPath: pkg => { pkg.videoPath = "/approved/./video.mp4"; },
    approvedSettings: pkg => { pkg.approvedSettings.nested.original = false; },
  };
  for (const [field, edit] of Object.entries(edits)) {
    const input = fixture();
    input.nextPackage.youtubeTags = ["After"];
    edit(input.nextPackage);
    assert.throws(() => validateTagRevision(input), new RegExp(`${field} must stay unchanged`), field);
  }
});

test("unknown fields and non-allowed topics cannot be added, changed or removed", () => {
  for (const action of ["add", "change", "remove", "add-undefined"]) {
    const input = fixture();
    if (action === "add") input.nextPackage.unknownField = true;
    if (action === "change") { input.previousPackage.unknownField = { value: 1 }; input.nextPackage.unknownField = { value: 2 }; }
    if (action === "remove") input.previousPackage.unknownField = true;
    if (action === "add-undefined") input.nextPackage.unknownField = undefined;
    assert.throws(() => validateTagRevision(input), /unknownField must stay unchanged/, action);
  }
  const input = fixture();
  input.nextPackage.topics = ["New shared topics"];
  assert.throws(() => validateTagRevision(input), /topics must stay unchanged/);
});

test("object key order is immaterial but missing nested settings are rejected", () => {
  const input = fixture();
  input.nextPackage = Object.fromEntries(Object.entries(input.nextPackage).reverse());
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: [] });
  delete input.nextPackage.approvedSettings.nested.original;
  assert.throws(() => validateTagRevision(input), /approvedSettings must stay unchanged/);
});

test("wechatDescription can replace only its existing final hashtag line", () => {
  const input = fixture();
  input.nextPackage.wechatTags = ["After", "Another"];
  input.nextPackage.wechatDescription = "Approved WeChat prose.\nSecond paragraph.\n\n#After #Another";
  input.platforms = ["wechat_channels"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["wechat_channels"] });
});

test("WeChat tail edits preserve multiple preceding blank lines and CRLF exactly", () => {
  const input = fixture();
  input.previousPackage.wechatDescription = "Line one.\r\n\r\nLine two.\r\n\r\n\r\n#Before";
  input.nextPackage.wechatTags = ["After"];
  input.nextPackage.wechatDescription = "Line one.\r\n\r\nLine two.\r\n\r\n\r\n#After";
  input.platforms = ["wechat_channels"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["wechat_channels"] });
  input.nextPackage.wechatDescription = input.nextPackage.wechatDescription.replace(/\r\n/g, "\n");
  assert.throws(() => validateTagRevision(input), /exact wechatDescription prose/);
});

test("a WeChat tail correction affects WeChat even when its tag array is unchanged", () => {
  const input = fixture();
  input.previousPackage.wechatDescription = "Approved WeChat prose.\n\n#Older";
  input.nextPackage.wechatDescription = "Approved WeChat prose.\n\n#Before";
  input.platforms = ["wechat_channels"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["wechat_channels"] });
  input.platforms = ["youtube"];
  assert.throws(() => validateTagRevision(input), /every existing draft whose tags changed: wechat_channels/);
});

test("WeChat prose, spacing, tag order and unapproved tail cannot change", () => {
  const alternatives = [
    "Changed WeChat prose.\nSecond paragraph.\n\n#After #Another",
    "Approved WeChat prose. \nSecond paragraph.\n\n#After #Another",
    "Approved WeChat prose.\nSecond paragraph.\n\n\n#After #Another",
    "Approved WeChat prose.\nSecond paragraph.\n#After #Another",
    "Approved WeChat prose.\nSecond paragraph.\n\n#Another #After",
    "Approved WeChat prose.\nSecond paragraph.\n\n#After  #Another",
    "Approved WeChat prose.\nSecond paragraph.\n\n#After #Another #Extra",
    "Approved WeChat prose.\nSecond paragraph.\n\n#After #Another\n",
  ];
  for (const description of alternatives) {
    const input = fixture();
    input.nextPackage.wechatTags = ["After", "Another"];
    input.nextPackage.wechatDescription = description;
    assert.throws(() => validateTagRevision(input), /exact wechatDescription prose/, description);
  }
});

test("WeChat requires an existing standalone final hashtag tail", () => {
  for (const previous of ["Prose with no tail", "Prose\n#Before", "Prose\n\n#Before and prose", "Prose\n\n#Before\n", "Prose\n\n#Before\nMore prose"]) {
    const input = fixture();
    input.previousPackage.wechatDescription = previous;
    input.nextPackage.wechatDescription = "Prose\n\n#After";
    input.nextPackage.wechatTags = ["After"];
    assert.throws(() => validateTagRevision(input), /existing final blank-line hashtag tail/, previous);
  }
});

test("WeChat tail replacement follows shared tag fallbacks and cannot remove the tail", () => {
  const input = fixture();
  delete input.previousPackage.wechatTags;
  delete input.nextPackage.wechatTags;
  input.nextPackage.tags = ["After"];
  input.nextPackage.wechatDescription = "Approved WeChat prose.\nSecond paragraph.\n\n#After";
  input.platforms = ["wechat_channels"];
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["wechat_channels"] });
  input.nextPackage.tags = [];
  input.nextPackage.wechatDescription = "Approved WeChat prose.\nSecond paragraph.\n\n";
  assert.throws(() => validateTagRevision(input), /exact wechatDescription prose/);
});

test("video path, video hash and size must match exactly", () => {
  for (const [field, value] of Object.entries({ path: "/other/video.mp4", sha256: "different-video-hash", size: 11 })) {
    const input = fixture();
    input.nextIdentity.video[field] = value;
    assert.throws(() => validateTagRevision(input), /video must stay unchanged/, field);
  }
});

test("cover paths, cover hashes, cover settings and cover fingerprints must match exactly", () => {
  const edits = {
    assets: identity => { identity.assets[0].sha256 = "different-cover-hash"; },
    "assets path": identity => { identity.assets[0].path = "/other/cover.png"; },
    "assets size": identity => { identity.assets[0].size = 13; },
    cover: identity => { identity.cover.uploadCustomCover = false; },
    coverFingerprint: identity => { identity.coverFingerprint = "different-cover-fingerprint"; },
    coverFingerprints: identity => { identity.coverFingerprints.youtube = "different-platform-cover"; },
  };
  for (const [field, edit] of Object.entries(edits)) {
    const input = fixture();
    edit(input.nextIdentity);
    assert.throws(() => validateTagRevision(input), /cannot change the video or cover identity/, field);
  }
});

test("derived content fingerprints may change with tags", () => {
  const input = fixture();
  input.nextPackage.youtubeTags = ["After"];
  for (const field of ["fingerprint", "contentFingerprint", "previousFingerprint", "legacyFingerprint"]) input.nextIdentity[field] = `changed-${field}`;
  assert.deepEqual(validateTagRevision(input), { affectedPlatforms: ["youtube"] });
});

test("invalid package objects and non-array or non-string tags are rejected", () => {
  assert.throws(() => validateTagRevision(), /previous package object/);
  for (const side of ["previousPackage", "nextPackage"]) {
    const input = fixture();
    input[side] = null;
    assert.throws(() => validateTagRevision(input), /package object/);
    for (const field of ["tags", "xhsTopics", "douyinTopics", "bilibiliTags", "wechatTags", "youtubeTags"]) {
      for (const value of ["Before", null, undefined, ["Before", 1], ["Before", null]]) {
        const invalid = fixture();
        invalid[side][field] = value;
        assert.throws(() => validateTagRevision(invalid), /array of strings/, `${side}.${field}`);
      }
    }
  }
});

test("missing asset proof cannot be accepted even when both identities lack it", () => {
  const edits = [
    identity => { delete identity.video.path; },
    identity => { delete identity.video.sha256; },
    identity => { identity.video.size = -1; },
    identity => { delete identity.assets; },
    identity => { delete identity.assets[0].sha256; },
    identity => { delete identity.cover; },
    identity => { delete identity.coverFingerprint; },
    identity => { delete identity.coverFingerprints.youtube; },
  ];
  for (const edit of edits) {
    const input = fixture();
    edit(input.previousIdentity);
    edit(input.nextIdentity);
    assert.throws(() => validateTagRevision(input), /cannot prove/);
  }
});

test("unknown, duplicate and malformed selected or existing platforms are rejected", () => {
  for (const field of ["platforms", "existingPlatforms"]) {
    for (const value of [undefined, null, "youtube", ["unknown"], ["youtube", "youtube"]]) {
      const input = fixture();
      input[field] = value;
      assert.throws(() => validateTagRevision(input), /unique supported platforms/, field);
    }
  }
});

test("failure paths do not mutate frozen inputs", () => {
  const input = fixture();
  input.nextPackage.youtubeTags = ["After"];
  input.platforms = ["douyin"];
  const before = structuredClone(input);
  deepFreeze(input);
  assert.throws(() => validateTagRevision(input), /every existing draft whose tags changed/);
  assert.deepEqual(input, before);
});
