# YouTube Data API Setup

YouTube now uses the official Data API, not Ego Studio automation. The old Studio adapter remains historical code and is not selected by the production runner. No Playwright is installed or required.

## Quota And Cost

Use the API's default quota; do not enable billing, buy quota, or automatically apply for increases. On quota/rate-limit responses, return `QUOTA_EXCEEDED` and retain the upload checkpoint. Official documentation checked on 2026-09-12 gives `videos.insert` and `search.list` separate default buckets of 100 calls per day, with each call costing 1 unit in its own bucket; other methods share a default 10,000-unit daily bucket. The metadata update and custom-thumbnail methods currently cost 50 units each from that general bucket. The project's live Quotas page is authoritative and can change.

Official references:
- https://developers.google.com/youtube/v3/getting-started
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/docs/videos/insert
- https://developers.google.com/youtube/v3/guides/resumable_upload_protocol
- https://developers.google.com/youtube/v3/docs/thumbnails/set
- https://developers.google.com/identity/protocols/oauth2/native-app

## One-Time User Authorization

1. Open the Google API Console's APIs & Services dashboard directly, create or select a project, and enable YouTube Data API v3. Ignore any `Start free` / `$300 for 90 days` banner: that is the optional Google Cloud Free Trial and is not part of this setup. Do not enter payment details or activate billing for this workflow. If the direct APIs & Services dashboard itself redirects this account to mandatory payment verification, stop with `API_CONFIGURATION_REQUIRED`; do not suggest a fake card, a paid Cloud service, or another person's credentials.
2. Configure the project's OAuth consent screen and create an OAuth client whose application type is `Desktop app`. This is only a credential type; there is no YouTube desktop application to install. The signed-in user may need to be added as a test user.
3. Keep the downloaded client JSON outside the skill and release package. Do not paste secrets into chat or commit them.
4. Choose the exact target YouTube channel ID and numeric category ID.
5. Run from the skill directory:

```bash
node scripts/youtube-api-config.mjs status
node scripts/youtube-api-config.mjs authorize /absolute/path/client.json CHANNEL_ID CATEGORY_ID
```

When an already uploaded private video must be adopted by a new v2 job, initialize that exact job with `--inspect-only`, then use the explicit migration command below. It performs `channels.list` and `videos.list`, verifies the owner channel, private/processed state, and exact approved title, description, and tags before atomically writing the API checkpoint. It never calls `videos.insert`.

```bash
node scripts/youtube-api-config.mjs bind-existing /absolute/path/package.json /absolute/path/state-root JOB_ID VIDEO_ID
```

The authorization command prints Google's consent URL and waits up to five minutes on a loopback-only callback. It uses PKCE and state validation, verifies the authorized channel, and stores a refresh token in a mode-0600 file. It does not upload a video. The default path is `~/.config/video-publisher/youtube-oauth.json`; override with `VIDEO_PUBLISHER_YOUTUBE_OAUTH_FILE`.

The user must complete Google consent. Missing configuration is `API_CONFIGURATION_REQUIRED`; revoked/expired consent is `AUTH_REQUIRED`. Do not read browser cookies as a substitute or fall back to Studio.

## Upload Policy

- Only `youtubeVisibility: private` is accepted. No public/unlisted or subscriber notifications. `notifySubscribers=false` is a write-only API request policy, not a read-back field.
- `youtubeCategory` must be a numeric category ID, or use the explicit `default_category_id` chosen during OAuth setup. Requested playlists currently block before upload instead of being silently dropped.
- The full title, description, tags, audience, license, embedding, synthetic-content declaration, paid-promotion declaration and optional language are sent and read back. Missing API fields remain unverified rather than being coerced to false.
- Processing must report succeeded/processed. Copyright review is not exposed by this API and must not be claimed as verified.
- Exact PNG/JPEG thumbnail, no more than 2 MB. Do not resize or convert the approved asset silently.
- Preserve the resumable session URL and upload intent atomically before sending video bytes. Probe that session on retry. If session creation/completion is ambiguous or the session expires, block instead of issuing another videos.insert.
- The API checkpoint is private and separate from browser receipts. An existing Studio receipt blocks implicit migration; bind and verify its video ID explicitly before any migration. A new job is not an excuse to duplicate an existing video.
- API live acceptance requires a real OAuth account. Mock tests do not certify an upload succeeded.
