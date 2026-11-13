# YouTube Adapter Contract

Production uses `scripts/v2/platforms/youtube-api.mjs` through the same locked runner. It never calls Ego for YouTube. The historical `youtube.mjs` Studio adapter is not a fallback.

Read `youtube-api-setup.md` for authorization, quota, API limitations, and source documentation; read `persistence-verification.md` for mandatory readback evidence.

Stages:

```text
inspect: authenticate the exact channel and read the checkpoint's video ID
upload: start/resume the same resumable session, persist ID, await processing
mutate: write metadata and custom thumbnail
persist: independent API resource read, not a Studio Save button
verify: independent videos.list and thumbnail-byte verification
```

No browser prefill, task-space interaction, public/unlisted upload, final-publish button, or subscriber notification. An API private video is not a Studio draft.

READY requires all central gates plus persistence version 2. API write responses alone do not count. Missing thumbnail bytes, missing audience/settings properties, unfinished processing, wrong channel or mismatched fields fail closed.

OAuth files, resumable session URLs, access and refresh tokens must not appear in user-facing receipts. Failure messages contain status/reason codes, not raw credentials or response bodies.

Existing Studio drafts require explicit identity migration before API use; never duplicate-upload when provenance is uncertain.
