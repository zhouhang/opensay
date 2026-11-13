# Shared handoff and package contract

## Interactive gate ownership

Package generation and public publishing are two separate decisions:

1. The producer (`carton-short`, `talking-short`, or another caller) finishes the approved master, captions and media QC. Obtain package authorization once; an explicit current-episode package request already satisfies it.
2. `short-release` takes the title, description and five tags the user typed in the chat (recorded verbatim by `scripts/record_user_release.py`), then uses same-title covers with one cover approval. No candidate-title generation or title reselection. Preserve unchanged approvals; never approve unseen text by inference. Only then write the full handoff and byte-bound `release-package-approval-v1` against the authorized package request. Without authorization, ask once before creating that receipt.
3. Validate the package. Draft/private delivery follows the user's delivery setting; otherwise keep it local. Public-platform preparation/submission remains a separate workflow with exact-account approval.

Approval of the full video, cover, package, another platform, an earlier revision, or an earlier episode cannot substitute for either applicable current decision.

## Sticker complete-preview handoff

When the user has set a conditional instruction (for example "after I confirm the full preview, build the package and save drafts"), record that instruction with the episode's actual confirmation; it never authorizes uploading historical works. Destinations are platform drafts or private uploads through `video-publisher`, plus X video-post drafts per [x-delivery.md](x-delivery.md); X stays `pending_login_and_adapter_validation` until its adapter is validated. A complete formal preview uses the final renderer, actual materials, the full voice/music/SFX/caption timeline and the final output specification. Show the user's title, description, tags, the covers and the destinations in the same review; ask only for items not yet shown or changed.

## Producer handoff

The producer writes `video-release-handoff.json` after the current full video is approved and its media validation passes. A qualified Sticker complete formal preview can be that same approved full video, with no separate sample or duplicate full-film review. Schema version is `video-release-handoff-v1`.

The machine-readable companion is [video-release-handoff.schema.json](video-release-handoff.schema.json). The builder still performs filesystem, image-dimension, media-report, and hash checks that JSON Schema alone cannot express.

Required fields:

| Field | Requirement |
| --- | --- |
| `schema_version` | Exact value `video-release-handoff-v1` |
| `producer_skill` | Non-empty producer identifier |
| `status` | Exact value `approved` |
| `revision` | Non-empty producer revision |
| `release_revision_id` | Non-empty immutable release identity |
| `orientation` | `portrait` or `landscape` |
| `title` | Upstream-approved title, copied verbatim; pool projects use `原创标题` |
| `title_source` | New text carries `policy=reuse-upstream-title-v1`, `field`, `value`, UTF-8 `sha256`, and actual `approval_note`; pool sources also carry `record_id`. Sticker handoffs require this. Existing non-sticker legacy handoffs remain readable. |
| `cover_headline_text` | Exact full cover headline; whitespace-normalized value must equal `title` |
| `cover_headline_lines` | Non-empty visual line array; whitespace-normalized joined value must equal `title` and `cover_headline_text` |
| `brand_name` | Approved account or brand name |
| `description` | Approved publication description |
| `description_interaction` | For `content-participation-v1` generated copy: Object with `type` (`discussion`, `interaction`, `experience`, or `help`), the exact participating invitation/question in `text`, and a non-empty `content_anchor` naming the video scene/viewpoint it draws on. Optional `answer_format` describes the intended easy answer. `text` must occur in `description` and in `platform_intro` when supplied, allowing only NFC/whitespace normalization. |
| `hashtags` | Exactly five non-empty strings |
| `video` | Absolute path to the approved CTA-inclusive master |
| `captions` | Absolute path to its exact captions |
| `cover_master` | Absolute path; legacy 1080×1920 portrait or 1920×1080 landscape. With `one_asset_per_dimensions`, may instead alias the exact primary variant and its mapped unique-size asset, retaining that slot's required dimensions. No cropping or extra master generation is required. |
| `release_media_validation` | Absolute path to a current report with `passed=true` |
| `cover_variants` | Object containing the four baseline ids; include `bilibili_cover` for a Bilibili target. Equal-size slots point to the same absolute path in new handoffs |
| `cover_asset_strategy` | Exact value `one_asset_per_dimensions` for new handoffs |
| `cover_assets_by_size` | One absolute path per unique pixel size, e.g. `1080x1440`, `1600x1200`, `1920x1080` |
| `platform_cover_map` | Maps each declared platform-slot id to its dimension key |

`primary_cover_variant_id` is optional and defaults to `douyin_cover`. Optional producer metadata such as `production_manifest`, `used_style_history`, `editable_project`, `jianying_draft`, `title_alternatives`, and `platform_intro` is retained when supplied.

`title_alternatives` is legacy metadata only; new packages do not generate alternatives.
The producer saves `release_title.json` as the following object and embeds it as
`title_source` in release copy and handoff (use actual values, never sample approval):

```json
{
  "policy": "reuse-upstream-title-v1",
  "field": "原创标题",
  "value": "前置阶段已确定并批准的标题原文",
  "sha256": "<SHA256 of the exact UTF-8 value>",
  "record_id": "<actual pool record ID>",
  "approval_note": "<actual user approval or message reference>"
}
```

Non-pool sources use `field=user-supplied` and need no `record_id`. The builder
checks exact title equality and the digest; it cannot prove an approval note was genuinely
spoken. Never fabricate it. A title change goes back to upstream approval and requires a new
release revision and matching cover, not an in-package rewrite. The package revision hash
binds `title_source` when supplied; old packages without it retain their original hash.

Release descriptions and tags are written by the user and recorded verbatim (`user-supplied-release-v1`). Legacy packages may still carry `doubao_source` generation evidence; the package preserves and hashes it when present, and old package hashes remain unchanged.

`cover_headline_text` and `cover_headline_lines` make title parity machine-checkable. They permit
line wrapping only. The comparison removes Unicode whitespace but preserves wording, case and
punctuation, so a shorter cover hook or a rewritten POV is rejected before package output. Packages
created before this metadata was introduced remain verifiable for compatibility; every newly built
handoff must provide it.

All newly built handoffs require `description_interaction`. The copy-writing step chooses
the question/invitation from the actual script or deliverables, and reviews relevance and
answerability before showing the combined copy set. The builder validates the metadata and
its presence in the final description; it does not generate a generic question from a title
or treat a question mark as proof of content relevance. It emits
`description_policy=content-participation-v1` and carries the interaction record unchanged.
Packages predating these fields remain verifiable with a legacy compatibility warning.
New records cannot omit the interaction field or lose its sentence in the credited intro.

The media-validation report must point to the same video when it declares `video`, and its `video_sha256` must match when supplied. The package builder refuses relative artifact paths so a package cannot silently resolve against a different working directory.

## User-supplied editorial source (sticker default)

`user_release_source` opt-in mode takes precedence over the generated-copy/interaction requirements above. The user supplies the title, final script, ≤50-non-whitespace-character description and five tags; the agent supplies only the earlier outline. Preserve the user description and tags exactly and do not call Doubao or add an interaction question. Keep `description_policy=user-supplied-release-v1`, `script_sha256` and `user_release_source` in the handoff and package.

`user_release_source` contains policy, absolute snapshot_path, snapshot_sha256, record_id and the actual authorization_note. The snapshot uses schema `sticker-user-editorial-snapshot-v1`: title, description, hashtags, final_script, script_sha256, source_fields, source_field_values, user_field_evidence (actual row-export path/hash), and authorization (actor=user, actual instruction/source). The shared validator checks actual bytes, title/description/tags agreement, raw user-field evidence, script hash and authorization. A source label alone does not establish provenance.

`description_interaction` is optional in this mode; validate its inclusion if supplied, never fabricate it. New evidence enters the release revision hash; changing source fields or bound files invalidates verification. Packages lacking this opt-in retain their former hash and participation rules. User source does not waive video QC, actual-media approval, cover parity, package authorization or publishing permissions.

## Package-approval receipt

Package assembly requires a separate `release-package-approval-v1` receipt. For other callers, the producer creates it only after the user explicitly approves package generation for the exact current revision. Sticker follows the complete-preview section above: its applicable conditional authorization plus the actual current-preview/release-asset confirmation and byte/QC conditions satisfy package authorization without another package question. Create the same exact-current-revision receipt:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py package-approve \
  --handoff <work>/video-release-handoff.json \
  --output-dir <publish-dir> \
  --confirmed-by-user \
  --output <publish-dir>/release_package_approval.json
```

The receipt is short-lived and binds the effective OS user, handoff path and bytes, producer and release identities, intended output directory, and the paths, sizes, and SHA-256 hashes of the video, captions, master cover, media-validation report, and every declared platform slot. Equal-size slot aliases are expected to bind the same bytes. It is not reusable after expiry or after any bound path or byte changes. For other callers, a full-video approval or a generic workflow preference is not a substitute for current package authorization. Sticker's qualified conditional authorization is governed by the complete-preview section above and still requires the exact current artifact conditions; a receipt for another revision is never a substitute.

## Fixed cover profile

`cn_social_covers_v2` is the account-tested baseline. It supersedes `cn_social_covers_v1`, whose
1600×1200 entries for Douyin and Xiaohongshu did not match those publishers' upload slots:

| Variant id | Platform slot | Pixels | Required treatment |
| --- | --- | ---: | --- |
| `douyin_cover` | Douyin custom cover | 1080×1440 | 3:4 composition; shares its specification with `xiaohongshu_cover` and may reuse the same pixels |
| `xiaohongshu_cover` | Xiaohongshu video-note cover | 1080×1440 | 3:4 composition; see above |
| `wechat_channels_home` | WeChat Channels homepage card | 1080×1440 | Native 3:4 reflow; no inset landscape frame or filler |
| `wechat_channels_share` | WeChat Channels share card | 1600×1200 | Protect the central play-button exclusion |
| `bilibili_cover` | Bilibili video cover | 1920×1080 | Native 16:9 composition; required for a Bilibili target |

In new handoffs, `douyin_cover`, `xiaohongshu_cover`, and `wechat_channels_home` all alias the same
1080×1440 file. That shared asset uses the stricter WeChat Channels homepage safe region. The five
platform slots therefore resolve to three generated assets instead of five separate generations.

`short-release` obtains these creative assets through `release-cover`. The shared builder verifies the pixels and creates display-slot simulations:

- 180×240 for every 3:4 slot; 320×240 for every 4:3 slot;
- 180×240 plus a bottom 28% statistics-risk overlay for the homepage card;
- a centered play-button overlay for the share-card simulation.

The manifest safe rectangles are `[96,96,1408,984]` for 4:3 covers and `[72,86,936,954]` for the homepage card. The share card additionally declares `[680,480,240,240]` as its overlay exclusion.

## Output contract

After validating that receipt, run:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py package \
  --handoff <work>/video-release-handoff.json \
  --output <publish-dir> \
  --approval <publish-dir>/release_package_approval.json
```

The caller-created approval receipt remains beside the generated package evidence:

```text
<publish-dir>/
  release_package_approval.json
  publish_copy.md
  publish_package.json
  publish_package_validation.json
  cover/platforms/
    platform-cover-specs.json
    previews/
      douyin_cover-preview.png
      xiaohongshu_cover-preview.png
      wechat_channels_home-preview.png
      wechat_channels_share-preview.png
      bilibili_cover-preview.png
```

`publish_package.json` keeps `status=approved`, `cover_profile_id=cn_social_covers_v2`, every declared platform-slot path, the unique-size asset and mapping metadata, the generated manifest, the selected primary alias, both validation report paths, the producer/release identities, and the validated `cover_headline_text` / `cover_headline_lines`. `cover_platform` is a strict alias of `cover_variants[primary_cover_variant_id]`.

The validation report hashes the video, captions, generated copy, master cover, manifest, and every platform cover. It also binds title, description, hashtags, orientation, primary cover, profile, status, and `release_revision_id` into `release_revision_hash`.
For packages with participation metadata, the hash also binds `description_policy`,
`description_interaction`, and `platform_intro` when supplied. Changing the question,
its type/content anchor, or the credited intro invalidates the stored validation. The hash
for a legacy package with neither participation field remains unchanged.

## Revision and cleanup gate

Any change to pixels, audio, timing, narration, captions, title, description, hashtags, master cover, platform cover, manifest, or copy invalidates the stored report. Assign a new release revision and rebuild from the earliest affected producer stage.

Producer queue cleanup requires all of the following:

1. `publish_package.json.status == "approved"`;
2. `release_media_validation.passed == true`;
3. `publish_package_validation.passed == true`;
4. stored artifact hashes and `release_revision_hash` equal a current recomputation.

Use `release.py verify`; producer skills must not maintain another hash implementation.
