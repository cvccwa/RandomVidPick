# Random Video Picker

A private PWA that picks a random video from your Google Drive and opens it in VLC.

## How it's hosted
- **App:** GitHub Pages serves `index.html`, `app.js` and `sw.js` from `main`.
- **API:** Google Cloud Run builds the root `Dockerfile` on every merge to `main`. `server/server.mjs` serves the handlers in `api/`: stream (signed, expiring links), sign, thumbnail, meta (tags, durations, watched history) and keepalive.
- **Data:** Upstash Redis (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` on the Cloud Run service).
- **Drive access:** the Cloud Run service runs as the service account the video folder is shared with. No keys are stored.
- **Keep-alive:** the Cloud Scheduler job `rvp-keepalive` calls `/api/keepalive` daily so Upstash doesn't archive the database.

## Adding Videos
Just drop video files into your designated Google Drive folder (or any subfolder). No app changes needed.
