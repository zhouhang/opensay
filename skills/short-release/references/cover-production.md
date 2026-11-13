# Cover contract — cn_social_covers_v2

What a cover must satisfy to enter a release package. **How** covers are made lives in the
`release-cover` skill; this file does not duplicate it.

## 1. Sizes and slots

| Variant id | Platform slot | Pixels | Unique asset | Safe rect |
|---|---|---:|---|
| `xiaohongshu_cover` | Xiaohongshu video-note cover | 1080×1440 (3:4) | `1080x1440` | (72, 86, 936, 954) |
| `douyin_cover` | Douyin custom cover | 1080×1440 (3:4) | `1080x1440` | same |
| `wechat_channels_home` | WeChat Channels homepage card | 1080×1440 (3:4) | `1080x1440` | same |
| `wechat_channels_share` | WeChat Channels share card | 1600×1200 (4:3) | `1600x1200` | (96, 96, 1408, 984) |
| `bilibili_cover` | Bilibili video cover | 1920×1080 (16:9) | `1920x1080` | (96, 72, 1728, 936) |

`v2` corrects `v1`, which recorded the Douyin and Xiaohongshu slots as 1600×1200 4:3. New
handoffs use `cover_asset_strategy=one_asset_per_dimensions`: the three 1080×1440 slots **must**
point to the same file and obey the strictest of their rules, which is the WeChat Channels homepage
bottom exclusion. Bilibili remains a configured additional slot and is required when it is a target.

## 2. Occlusion zones

- `wechat_channels_home`: `y ≥ 1040` is the platform statistics gradient. Shoulders and background
  only — no title, face, tag or other essential information.
- `wechat_channels_share`: the centre play button occupies roughly `(680, 480, 240, 240)`. Keeping
  the whole headline block above `y = 470` lets it use the full safe width.

Measure the headline block against these rectangles; do not eyeball it. A block starts below the
badge **and its gap**, and the stroke widens it on every side, so an origin computed from the safe
top alone silently overruns by tens of pixels — invisible at a glance, fatal at thumbnail size.

`release-cover` checks occupancy statistically (edge density inside the zone against the whole
frame) because generated covers have no glyph geometry to measure. That check is weaker than a
typesetter's rectangle test: it can confirm a zone looks empty, not that a specific glyph cleared
it. Its warnings are advisory and must be shown to the user, never silently dropped.

## 3. Title parity

`cover_headline_text` and `cover_headline_lines` must equal `title` after removing Unicode
whitespace. Line breaks are free; shortening, paraphrasing, changed punctuation, translated product
names or a different hook are not. The builder enforces this before writing a package, and
`release-cover` enforces it before generating, so a mismatch surfaces in seconds rather than at
package time.

## 4. Review before packaging

Export the slot simulations the packager writes: 180×240 for every 3:4 slot, 320×240 for the 4:3
share card with its play button, 320×180 for Bilibili, and the homepage card with its bottom statistics band. The
headline and the face must be legible without zooming. If they are not, the cover fails regardless
of what the validator says.

## 5. Known gaps

- Safe-rect numbers carry over from `v1` and have not been re-verified in the current publisher UIs.
- The occlusion check is statistical, not geometric (see §2).
- A code-typeset pipeline exists in the cover workspace and can place glyphs to the pixel, but it is
  **not** part of the release path: the account prefers the generated covers' finish, and mixing the
  two would give one account two visual languages.
