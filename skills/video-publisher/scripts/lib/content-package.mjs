import fs from "node:fs";
import { loadConfig } from "./config.mjs";

export function stripHash(tag) {
  return String(tag || "").trim().replace(/^#+\s*/, "").trim();
}

export function uniqueCleanTags(tags = []) {
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    const tag = stripHash(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function hasLiteralEscapedNewline(value) {
  return String(value || "").includes("\\n");
}

export function normalizeDescription(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

export function xiaohongshuTitleLength(value) {
  let halfUnits = 0;
  for (const character of Array.from(String(value || ""))) {
    halfUnits += character.codePointAt(0) <= 0x7f ? 1 : 2;
  }
  return halfUnits / 2;
}

export function getImageDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP") {
    // Header-only inspection; this does not decode/validate compressed pixels.
    // https://developers.google.com/speed/webp/docs/riff_container
    const unknown = { width: 0, height: 0, format: "unknown" };
    const riffSize = buffer.readUInt32LE(4);
    if (riffSize < 4 || riffSize > 0xfffffff6 || riffSize % 2 !== 0
      || riffSize + 8 !== buffer.length) return unknown;
    let canvas;
    let image;
    for (let offset = 12; offset < buffer.length;) {
      if (offset + 8 > buffer.length) return unknown;
      const type = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      const next = end + (size % 2);
      if (next > buffer.length || (size % 2 && buffer[end] !== 0)) return unknown;
      let dimensions;
      if (type === "VP8X") {
        if (size < 10 || canvas) return unknown;
        canvas = {
          width: buffer.readUIntLE(start + 4, 3) + 1,
          height: buffer.readUIntLE(start + 7, 3) + 1,
          format: "webp",
        };
        if (canvas.width * canvas.height > 0xffffffff) return unknown;
      } else if (type === "VP8 ") {
        // RFC 6386: WebP uses a key frame, followed by the 9d 01 2a sync code.
        if (size < 10 || (buffer[start] & 1) !== 0
          || ((buffer[start] >> 1) & 7) > 3
          || buffer[start + 3] !== 0x9d || buffer[start + 4] !== 1
          || buffer[start + 5] !== 0x2a) return unknown;
        dimensions = {
          width: buffer.readUInt16LE(start + 6) & 0x3fff,
          height: buffer.readUInt16LE(start + 8) & 0x3fff,
          format: "webp",
        };
      } else if (type === "VP8L") {
        // Lossless header: signature, 14-bit width-1, 14-bit height-1,
        // alpha hint, and a three-bit version that must currently be zero.
        if (size < 5 || buffer[start] !== 0x2f) return unknown;
        const bits = buffer.readUInt32LE(start + 1);
        if (bits >>> 29 !== 0) return unknown;
        dimensions = {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
          format: "webp",
        };
      }
      if (dimensions) {
        if (!dimensions.width || !dimensions.height || image) return unknown;
        image = dimensions;
      }
      offset = next;
    }
    if (canvas && image
      && (canvas.width !== image.width || canvas.height !== image.height)) return unknown;
    return canvas || image || unknown;
  }
  if (buffer.length >= 24
    && buffer[0] === 0x89
    && buffer.toString("ascii", 1, 4) === "PNG") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      format: "png",
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: "jpeg",
        };
      }
      offset += 2 + size;
    }
  }
  return { width: 0, height: 0, format: "unknown" };
}

export function ratioOk(dimensions, expected) {
  if (!dimensions.width || !dimensions.height) return false;
  const actual = dimensions.width / dimensions.height;
  const target = {
    "3:4": 3 / 4,
    "4:3": 4 / 3,
    "16:9": 16 / 9,
  }[expected];
  if (!target) return false;
  return Math.abs(actual - target) < 0.01;
}

export function coverUploadEnabled(cover = {}) {
  return cover.uploadCustomCover === true;
}

export function coverForPlatform(pkg, platform) {
  const cover = pkg.cover || {};
  const override = cover.platforms?.[platform] || {};
  // Xiaohongshu has one ratio-selected native cover, not two independent slots.
  // Keep legacy packages byte-for-byte equivalent when the selector is absent.
  const { nativeRatio: _nativeRatio, ...sharedCover } = cover;
  return {
    ...sharedCover,
    ...Object.fromEntries(["vertical3x4Path", "horizontal4x3Path", "horizontal16x9Path"]
      .map(key => [key, String(override[key] || cover[key] || "").trim()])),
    ...(platform === "xiaohongshu" && Object.prototype.hasOwnProperty.call(override, "nativeRatio")
      ? { nativeRatio: String(override.nativeRatio ?? "").trim() }
      : {}),
  };
}

export function coverAssetsForPlatform(pkg, platform) {
  const cover = coverForPlatform(pkg, platform);
  const verticalPath = cover.vertical3x4Path;
  const horizontalPath = cover.horizontal4x3Path;
  const widescreenPath = cover.horizontal16x9Path;
  const xhsRatio = Object.prototype.hasOwnProperty.call(cover, "nativeRatio") ? cover.nativeRatio : "3:4";
  const xhsAsset = {
    "3:4": { slot: "portrait", ratio: "3:4", path: verticalPath },
    "4:3": { slot: "landscape", ratio: "4:3", path: horizontalPath },
    "16:9": { slot: "landscape", ratio: "16:9", path: widescreenPath },
  }[xhsRatio];
  const mapping = {
    xiaohongshu: xhsAsset?.path ? [xhsAsset] : [],
    wechat_channels: [
      ...(verticalPath ? [{ slot: "portrait", ratio: "3:4", path: verticalPath }] : []),
      ...(horizontalPath ? [{ slot: "landscape", ratio: "4:3", path: horizontalPath }] : []),
    ],
    bilibili: horizontalPath ? [{ slot: "homepage-master", ratio: "4:3", path: horizontalPath }] : [],
    douyin: [
      ...(verticalPath ? [{ slot: "portrait", ratio: "3:4", path: verticalPath }] : []),
      ...(horizontalPath ? [{ slot: "landscape", ratio: "4:3", path: horizontalPath }] : []),
    ],
    youtube: widescreenPath
      ? [{ slot: "thumbnail", ratio: "16:9", path: widescreenPath }]
      : [],
  };
  return mapping[platform] || [];
}

export function readPackage(packagePath, { config: suppliedConfig } = {}) {
  if (!packagePath) {
    throw new Error("Missing package JSON path");
  }
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const config = suppliedConfig || loadConfig();
  const title = String(parsed.title || "").trim();
  const platformTitle = {
    xiaohongshu: String(parsed.xhsTitle || parsed.xiaohongshuTitle || title).trim(),
    douyin: String(parsed.douyinTitle || title).trim(),
    bilibili: String(parsed.bilibiliTitle || title).trim(),
    wechat_channels: String(parsed.wechatTitle || parsed.wechatChannelsTitle || title).trim(),
    youtube: String(parsed.youtubeTitle || title).trim(),
  };
  const description = normalizeDescription(parsed.description || "");
  const douyinDescription = normalizeDescription(parsed.douyinDescription || parsed.description || "");
  const bilibiliDescription = normalizeDescription(parsed.bilibiliDescription || parsed.description || "");
  const wechatDescription = normalizeDescription(parsed.wechatDescription || parsed.description || "");
  const youtubeDescription = normalizeDescription(parsed.youtubeDescription || parsed.description || "");
  const cover = {
    uploadCustomCover: parsed.cover?.uploadCustomCover === true,
    vertical3x4Path: String(parsed.cover?.vertical3x4Path || "").trim(),
    horizontal4x3Path: String(parsed.cover?.horizontal4x3Path || "").trim(),
    horizontal16x9Path: String(parsed.cover?.horizontal16x9Path || "").trim(),
    platforms: Object.fromEntries(
      ["xiaohongshu", "douyin", "bilibili", "wechat_channels", "youtube"].map(platform => {
        const value = parsed.cover?.platforms?.[platform] || {};
        return [platform, {
          vertical3x4Path: String(value.vertical3x4Path || "").trim(),
          horizontal4x3Path: String(value.horizontal4x3Path || "").trim(),
          horizontal16x9Path: String(value.horizontal16x9Path || "").trim(),
          ...(platform === "xiaohongshu" && Object.prototype.hasOwnProperty.call(value, "nativeRatio")
            ? { nativeRatio: String(value.nativeRatio ?? "").trim() }
            : {}),
        }];
      }),
    ),
  };
  const douyinTopicSource = Array.isArray(parsed.douyinTopics)
    ? parsed.douyinTopics
    : Array.isArray(parsed.topics)
      ? parsed.topics
      : Array.isArray(parsed.tags)
        ? parsed.tags
        : config.platforms.douyin.defaultTopics;
  const douyinTopics = uniqueCleanTags(douyinTopicSource);
  const bilibiliTags = uniqueCleanTags(parsed.bilibiliTags || parsed.tags || []);
  const bilibiliAllowedAutoTags = uniqueCleanTags(
    Array.isArray(parsed.bilibiliAllowedAutoTags)
      ? parsed.bilibiliAllowedAutoTags
      : config.platforms.bilibili.allowedAutoTags,
  );
  const xhsTopics = uniqueCleanTags(parsed.xhsTopics || parsed.topics || parsed.tags || []);
  const wechatTags = uniqueCleanTags(parsed.wechatTags || parsed.topics || parsed.tags || []);
  const youtubeTags = uniqueCleanTags(parsed.youtubeTags || parsed.tags || parsed.topics || []);
  const youtubeAudience = String(parsed.youtubeAudience || "").trim();
  const youtubeVisibility = String(
    parsed.youtubeVisibility || config.platforms.youtube.defaultVisibility || "private",
  ).trim();
  const youtubeCategory = String(
    parsed.youtubeCategory ?? config.platforms.youtube.defaultCategory ?? "",
  ).trim();
  const youtubeLanguage = String(
    parsed.youtubeLanguage ?? config.platforms.youtube.defaultLanguage ?? "",
  ).trim();
  return {
    ...parsed,
    title,
    platformTitle,
    description,
    douyinDescription,
    bilibiliDescription,
    wechatDescription,
    youtubeDescription,
    cover,
    douyinTopics,
    bilibiliTags,
    bilibiliAllowedAutoTags,
    xhsTopics,
    wechatTags,
    youtubeTags,
    youtubeAudience,
    youtubeVisibility,
    youtubeCategory,
    youtubeLanguage,
    youtubePlaylist: String(parsed.youtubePlaylist || "").trim(),
    youtubeLicense: String(parsed.youtubeLicense || "standard_youtube").trim(),
    youtubePaidPromotion: parsed.youtubePaidPromotion === true,
    youtubeAlteredContent: parsed.youtubeAlteredContent === true,
    youtubeAllowEmbedding: parsed.youtubeAllowEmbedding !== false,
    youtubeNotifySubscribers: parsed.youtubeNotifySubscribers === true,
  };
}

export function validateCommonPackage(pkg) {
  const errors = [];
  if (!pkg.title) errors.push("title is required");
  if (hasLiteralEscapedNewline(pkg.title)) errors.push("title contains literal escaped newline");
  for (const key of ["description", "xhsDescription", "douyinDescription", "bilibiliDescription", "wechatDescription", "youtubeDescription"]) {
    if (hasLiteralEscapedNewline(pkg[key])) errors.push(`${key} contains literal escaped newline; use real newlines`);
  }
  const settings = pkg.platformSettings;
  if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings))) errors.push("platformSettings must be an object");
  for (const [platform, options] of Object.entries(settings || {})) {
    if (!["xiaohongshu", "bilibili", "wechat_channels"].includes(platform)) { errors.push(`unsupported platformSettings platform: ${platform}`); continue; }
    if (!options || typeof options !== "object" || Array.isArray(options)) { errors.push(`platformSettings.${platform} must be an object`); continue; }
    const allowed = ["aiGenerated", ...(platform === "xiaohongshu" ? ["groupChat"] : []), ...(platform === "wechat_channels" ? ["shortTitle"] : [])];
    for (const key of Object.keys(options)) if (!allowed.includes(key)) errors.push(`unsupported platformSettings.${platform}.${key}`);
    for (const key of ["aiGenerated", "groupChat"]) if (options[key] !== undefined && typeof options[key] !== "boolean") errors.push(`platformSettings.${platform}.${key} must be boolean`);
    if (options.shortTitle !== undefined && (typeof options.shortTitle !== "string" || codePointLength(options.shortTitle) > 16)) errors.push("wechat shortTitle must be a string of at most 16 codepoints");
  }
  return errors;
}

export function validateCoverPackage(pkg, platform) {
  const errors = [];
  const cover = coverForPlatform(pkg, platform);
  if (!coverUploadEnabled(cover)) return errors;
  if (platform === "xiaohongshu"
    && Object.prototype.hasOwnProperty.call(cover, "nativeRatio")
    && !["3:4", "4:3", "16:9"].includes(cover.nativeRatio)) {
    errors.push(`xiaohongshu nativeRatio must be 3:4, 4:3, or 16:9; got ${JSON.stringify(cover.nativeRatio)}`);
    return errors;
  }
  if (
    platform === "bilibili"
    && !cover.horizontal4x3Path
    && cover.horizontal16x9Path
  ) {
    errors.push("bilibili primary cover requires an exact 4:3 horizontal4x3Path; 16:9 is only a personal-space companion");
    return errors;
  }
  const assets = coverAssetsForPlatform(pkg, platform);
  if (!assets.length) {
    errors.push(`custom cover upload enabled, but no cover asset is mapped for ${platform}`);
    return errors;
  }
  if (platform === "douyin" && assets.length !== 2) {
    errors.push("douyin custom cover upload requires both 3:4 portrait and 4:3 landscape covers");
  }
  if (platform === "wechat_channels" && assets.length !== 2) {
    errors.push("wechat_channels custom cover upload requires both 3:4 personal-profile and 4:3 share-card covers");
  }
  if (platform === "youtube" && assets.length !== 1) {
    errors.push("youtube custom thumbnail upload requires one exact 16:9 horizontal16x9Path");
  }
  for (const asset of assets) {
    if (!asset.path || !fs.existsSync(asset.path)) {
      errors.push(`custom cover file not found for ${platform} ${asset.slot}: ${asset.path || "(missing path)"}`);
      continue;
    }
    const dimensions = getImageDimensions(asset.path);
    if (!ratioOk(dimensions, asset.ratio)) {
      errors.push(`custom cover ratio mismatch for ${platform} ${asset.slot}: expected ${asset.ratio}, got ${dimensions.width}x${dimensions.height || 0}`);
    }
  }
  return errors;
}

export function validateDouyinPackage(pkg) {
  const errors = validateCommonPackage(pkg);
  errors.push(...validateCoverPackage(pkg, "douyin"));
  const douyinTitle = String(pkg.platformTitle?.douyin || pkg.title || "");
  const douyinTitleLength = codePointLength(douyinTitle);
  if (douyinTitleLength > 30) errors.push(`douyin title is ${douyinTitleLength}/30`);
  if ((pkg.douyinDescription.match(/#[^\s#]+/g) || []).length) {
    errors.push("douyinDescription must not contain inline hashtags; use douyinTopics");
  }
  if (!pkg.douyinTopics.length) errors.push("douyinTopics are required");
  if (pkg.douyinTopics.length > 5) errors.push("douyin supports at most 5 topics");
  return errors;
}

export function validateBilibiliPackage(pkg) {
  const errors = validateCommonPackage(pkg);
  errors.push(...validateCoverPackage(pkg, "bilibili"));
  const bilibiliTitle = String(pkg.platformTitle?.bilibili || pkg.title || "");
  const bilibiliTitleLength = codePointLength(bilibiliTitle);
  if (bilibiliTitleLength > 80) errors.push(`bilibili title is ${bilibiliTitleLength}/80`);
  if (!pkg.bilibiliDescription) errors.push("bilibiliDescription is required");
  if (!pkg.bilibiliTags.length) errors.push("bilibiliTags are required");
  if (pkg.bilibiliTags.length > 10) errors.push("bilibili supports at most 10 tags");
  return errors;
}

export function validateXiaohongshuPackage(pkg) {
  const errors = validateCommonPackage(pkg);
  errors.push(...validateCoverPackage(pkg, "xiaohongshu"));
  const xhsTitle = String(pkg.platformTitle?.xiaohongshu || pkg.xhsTitle || pkg.xiaohongshuTitle || pkg.title || "").trim();
  const xhsTitleLength = xiaohongshuTitleLength(xhsTitle);
  if (xhsTitleLength > 20) errors.push(`xiaohongshu title is ${xhsTitleLength}/20`);
  if (!pkg.xhsTopics.length) errors.push("xhsTopics are required");
  const dottedTopics = pkg.xhsTopics.filter(topic => topic.includes("."));
  if (dottedTopics.length) {
    errors.push(`xiaohongshu topics do not support "."; use a dot-free label instead: ${dottedTopics.join(", ")}`);
  }
  return errors;
}

export function validateWechatChannelsPackage(pkg) {
  const errors = validateCommonPackage(pkg);
  errors.push(...validateCoverPackage(pkg, "wechat_channels"));
  if (!pkg.wechatDescription) errors.push("wechatDescription is required");
  if (!pkg.wechatTags.length) errors.push("wechatTags are required");
  return errors;
}

export function validateYoutubePackage(pkg) {
  const errors = validateCommonPackage(pkg);
  errors.push(...validateCoverPackage(pkg, "youtube"));
  const title = String(pkg.platformTitle?.youtube || pkg.title || "");
  if (codePointLength(title) > 100) errors.push(`youtube title is ${codePointLength(title)}/100`);
  if (!pkg.youtubeDescription) errors.push("youtubeDescription is required");
  if (codePointLength(pkg.youtubeDescription) > 5000) {
    errors.push(`youtube description is ${codePointLength(pkg.youtubeDescription)}/5000`);
  }
  if (/(?:https?:\/\/|www\.|(?:^|[\s(])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|ai|dev|app|co)(?:[\/\s)]|$))/iu.test(pkg.youtubeDescription)) {
    errors.push("youtubeDescription must not contain web links");
  }
  const serializedTagsLength = pkg.youtubeTags.join(",").length;
  if (serializedTagsLength > 500) errors.push(`youtube tags are ${serializedTagsLength}/500 characters`);
  if (!["made_for_kids", "not_made_for_kids"].includes(pkg.youtubeAudience)) {
    errors.push("youtubeAudience must be one of: made_for_kids, not_made_for_kids");
  }
  if (pkg.youtubeVisibility !== "private") errors.push("youtubeVisibility must be private");
  if (pkg.youtubeCategory && !/^\d+$/.test(pkg.youtubeCategory)) {
    errors.push("youtubeCategory must be a numeric YouTube category ID");
  }
  if (pkg.youtubePlaylist) errors.push("youtubePlaylist is not supported by the Data API adapter");
  if (pkg.youtubeNotifySubscribers !== false) errors.push("youtubeNotifySubscribers must be false");
  if (!["standard_youtube", "creative_commons"].includes(pkg.youtubeLicense)) {
    errors.push("youtubeLicense must be one of: standard_youtube, creative_commons");
  }
  return errors;
}

export function assertPackage(errors) {
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}
