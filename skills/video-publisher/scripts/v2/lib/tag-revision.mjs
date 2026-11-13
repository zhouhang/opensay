import { isDeepStrictEqual } from "node:util";
import { uniqueCleanTags } from "../../lib/content-package.mjs";
import { PLATFORMS } from "./model.mjs";

const TAG_FIELDS = ["tags", "xhsTopics", "douyinTopics", "bilibiliTags", "wechatTags", "youtubeTags"];
const MUTABLE_FIELDS = new Set([...TAG_FIELDS, "wechatDescription"]);
const IDENTITY_FIELDS = ["video", "assets", "cover", "coverFingerprint", "coverFingerprints"];

function fail(message) {
  throw new Error(`revise-tags ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function sameField(left, right, key) {
  return Object.hasOwn(left, key) === Object.hasOwn(right, key)
    && isDeepStrictEqual(left[key], right[key]);
}

function validatePackage(pkg, label) {
  if (!record(pkg)) fail(`requires a ${label} package object`);
  for (const field of TAG_FIELDS) {
    if (!Object.hasOwn(pkg, field)) continue;
    if (!Array.isArray(pkg[field]) || pkg[field].some(tag => typeof tag !== "string")) {
      fail(`requires ${label} ${field} to be an array of strings`);
    }
  }
}

function validateAsset(asset, label) {
  if (!record(asset) || typeof asset.path !== "string" || !asset.path
    || typeof asset.sha256 !== "string" || !asset.sha256
    || !Number.isSafeInteger(asset.size) || asset.size < 0) {
    fail(`cannot prove the ${label} asset path, size and hash`);
  }
}

function validateIdentity(identity, label) {
  if (!record(identity)) fail(`requires a ${label} identity object`);
  validateAsset(identity.video, `${label} video`);
  if (!Array.isArray(identity.assets)) fail(`cannot prove the ${label} cover assets`);
  identity.assets.forEach(asset => validateAsset(asset, `${label} cover`));
  if (!record(identity.cover) || typeof identity.coverFingerprint !== "string" || !identity.coverFingerprint
    || !record(identity.coverFingerprints)
    || PLATFORMS.some(platform => typeof identity.coverFingerprints[platform] !== "string" || !identity.coverFingerprints[platform])) {
    fail(`cannot prove the ${label} cover identity`);
  }
}

function platformList(value, label, { allowObject = false } = {}) {
  const platforms = allowObject && record(value) ? Object.keys(value) : value;
  if (!Array.isArray(platforms)
    || platforms.some(platform => !PLATFORMS.includes(platform))
    || new Set(platforms).size !== platforms.length) {
    fail(`requires ${label} to contain unique supported platforms`);
  }
  return platforms;
}

// Keep the precedence used by readPackage. Its normalized packages already have
// explicit platform arrays; raw snapshots may still depend on shared arrays.
function effectiveTags(pkg, platform) {
  const fields = {
    xiaohongshu: ["xhsTopics", "topics", "tags"],
    douyin: ["douyinTopics", "topics", "tags"],
    bilibili: ["bilibiliTags", "tags"],
    wechat_channels: ["wechatTags", "topics", "tags"],
    youtube: ["youtubeTags", "tags", "topics"],
  }[platform];
  const source = fields.map(field => pkg[field]).find(Array.isArray) || [];
  return uniqueCleanTags(source);
}

function validateWechatTail(previousPackage, nextPackage) {
  if (sameField(previousPackage, nextPackage, "wechatDescription")) return false;
  const previous = previousPackage.wechatDescription;
  const next = nextPackage.wechatDescription;
  if (typeof previous !== "string" || typeof next !== "string") {
    fail("may change wechatDescription only by replacing an existing final blank-line hashtag tail");
  }
  const match = previous.match(/^([\s\S]*(?:\r?\n){2})(#[^\r\n]+)$/u);
  if (!match || !/^#[^\s#]+(?:[ \t]+#[^\s#]+)*$/u.test(match[2])) {
    fail("may change wechatDescription only by replacing an existing final blank-line hashtag tail");
  }
  const expectedTail = effectiveTags(nextPackage, "wechat_channels").map(tag => `#${tag}`).join(" ");
  if (!expectedTail || next !== `${match[1]}${expectedTail}`) {
    fail("must preserve the exact wechatDescription prose and replace only its final hashtag tail with wechatTags");
  }
  return true;
}

/** Validate a tag-only revision without changing packages, identities or state. */
export function validateTagRevision({ previousPackage, nextPackage, previousIdentity, nextIdentity, platforms, existingPlatforms } = {}) {
  validatePackage(previousPackage, "previous");
  validatePackage(nextPackage, "next");
  validateIdentity(previousIdentity, "previous");
  validateIdentity(nextIdentity, "next");
  const selected = platformList(platforms, "platforms");
  const existing = platformList(existingPlatforms, "existingPlatforms", { allowObject: true });
  const addedPlatforms = selected.filter(platform => !existing.includes(platform));
  if (addedPlatforms.length) {
    fail(`cannot target a platform absent from this job: ${addedPlatforms.join(", ")}`);
  }

  const immutableFields = [...new Set([...Object.keys(previousPackage), ...Object.keys(nextPackage)])]
    .filter(field => !MUTABLE_FIELDS.has(field)).sort();
  for (const field of immutableFields) {
    if (!sameField(previousPackage, nextPackage, field)) {
      fail(`may change only tag arrays and the final wechatDescription hashtag tail; ${field} must stay unchanged`);
    }
  }
  for (const field of IDENTITY_FIELDS) {
    if (!sameField(previousIdentity, nextIdentity, field)) {
      fail(`cannot change the video or cover identity: ${field} must stay unchanged`);
    }
  }

  const wechatTailChanged = validateWechatTail(previousPackage, nextPackage);
  const affectedPlatforms = PLATFORMS.filter(platform =>
    !isDeepStrictEqual(effectiveTags(previousPackage, platform), effectiveTags(nextPackage, platform))
      || (platform === "wechat_channels" && wechatTailChanged));
  const missingTargets = affectedPlatforms.filter(platform => existing.includes(platform) && !selected.includes(platform));
  if (missingTargets.length) {
    fail(`must include every existing draft whose tags changed: ${missingTargets.join(", ")}`);
  }
  return { affectedPlatforms };
}
