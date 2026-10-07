# RandomVidPick: notes for Claude

A private PWA for one owner. It browses a large Google Drive video library (2,000+ files, with subfolders), tags it, and opens videos in **VLC on Android**. The repo is **public**.

## Working agreements (owner's preferences)
- **One feature per branch** (`claude/<name>`), pushed with a PR. **Merge only when the owner says "merge N"**. After merging: cancel any check-in, unsubscribe from the PR, `git checkout main && git pull`, then confirm both deploys (see below).
- **Never put real video titles, Drive file IDs, purchase-site names or credentials** in commits, PR text, issues or code. Use placeholders in tests.
- Never read or decrypt secret values (env vars, keys).
- Every client change bumps `APP_VERSION` in `app.js` **and** the `CACHE` name in `sw.js` (`vN` / `rvp-vN`) together. The footer shows the version, which is how the owner checks an update is live.
- The owner tests on a phone and reports back. Explain things in plain terms, give cost implications up front, and recommend rather than list options.
- The owner would rather Claude handle cloud changes directly when a Google Cloud connector is available (Cloud CLI MCP). Otherwise give exact console clicks.

## Architecture
| Piece | Where | Notes |
|---|---|---|
| App (`index.html`, `app.js`, `sw.js`) | GitHub Pages, from `main` | `https://cvccwa.github.io/RandomVidPick/` |
| API (`api/*.js`, served by `server/server.mjs`) | Google Cloud Run `randomvidpick`, region `us-east1`, 1 vCPU / 512 MiB, max 2 instances, request-based billing | Builds the root `Dockerfile` on every merge to `main` (Cloud Build trigger). `API_BASE` in `app.js`. |
| Compilation service (planned) | Cloud Run `rvp-compile`, same image, 8 vCPU / 4 GiB, max 1 instance | See draft PR #38. `COMPILE_BASE` in `app.js`. It's separate because Cloud Run bills every vCPU for every active request, and normal playback must stay on the small service. |
| Data | Upstash Redis (REST), created through Vercel's marketplace | Env vars `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (`KV_REST_API_*` is also accepted) |
| Drive access | Cloud Run runs as service account `rvp-stream@…`, which the video folder is shared with | Token comes from the metadata server. **No keys exist**; the old JSON key was deleted. |
| Keep-alive | Cloud Scheduler job `rvp-keepalive` (us-east1), daily `17 9 * * *` UTC → `/api/keepalive` | Stops Upstash archiving the DB from inactivity (this happened once). |
| Image cleanup | Artifact Registry repo `cloud-run-source-deploy`: keep the latest 2 | |
| Vercel | Project **paused**, not deleted | It still posts a red "Deployment was blocked" status on PRs. That's expected and not a failure of the PR. The Upstash DB lives under the Vercel account, so don't delete the account or the integration. |

GCP project: "Random Video Picker" (`random-video-picker-497818`). A $5/month budget alert is set.

### API endpoints
- `/api/stream?id&exp&sig`: Drive proxy with Range support, capped to 8 MB chunks. **Requires signed, expiring links** (12 h HMAC; secret from `STREAM_SIGNING_KEY` or auto-generated in KV `rvp:streamkey`).
- `/api/sign` (POST `{ids}`): issues stream signatures. Owner only.
- `/api/meta`: durations, watched history and tags (KV hashes `rvp:dur`, `rvp:watched`, `rvp:tags`). Owner only.
- `/api/thumbnail?id`: Drive thumbnail proxy. `&report=` logs client-side frame-grab failures.
- `/api/compile`: compilation mode (see below).
- `/api/keepalive`: daily KV ping.
- "Owner only" means the caller's Google token must be able to read the library root folder (`api/_lib/auth.js`). The result is cached in KV by token hash.

### Client highlights (`app.js`)
- The library is the home screen after sign-in. The landing page is sign-in only.
- Videos open in VLC via an Android `intent://…;package=org.videolan.vlc` URL built from a signed stream link (`streamUrl()` batches and caches signatures).
- **Tags** are KV `{tag: source}` maps per file; source is `m` manual, `f` filename-derived, or `i` imported (reserved). Creator tags are stored as `creator:<name>`.
- Filters are tri-state (include/exclude) pickers for creators and tags. Long-press a card for the tag editor. Prefs are kept in `localStorage`.
- Thumbnails fall back to a client-side frame grab cached in IndexedDB.

### Compilation mode (`api/compile.js`)
- 🎬 takes random ~10 s clips from the current view and plays them as one HLS stream in VLC. The session is stored in KV `rvp:comp:<sid>` for 12 h; the sid in the URL is the credential.
- **Original:** ffmpeg stream copy (H.264/HEVC as-is; MPEG-4 Part 2 gets `dump_extra`; other codecs are swapped for another clip). There's a discontinuity between clips, which causes a brief flash.
- **Smooth (draft PR #38):** re-encode to one format, an exact 10 s per clip on one continuous timeline (`-output_ts_offset`), with no discontinuities. Encodes one clip ahead. Long-press 🎬 for Original / Smooth Auto / 4K / 1440p / 1080p. Auto picks the class that at least half the clips reach, judged by each video's short side.

## Testing approach
- No test suite lives in the repo. Tests are Playwright scripts run in a scratchpad against a local static server, with mocked Google/Drive/KV routes. Real touch input is simulated through CDP `Input.dispatchTouchEvent`.
- Server handlers are tested by running `server/server.mjs` under Node 22 with a fetch mock (metadata, Drive, KV) and a fake Drive HTTP server with byte ranges for ffmpeg. Segments are checked with PyAV (the static ffmpeg build segfaults reading TS in the sandbox).
- The sandbox **can't reach** `*.run.app` or `vercel.app`; ask the owner to open URLs on their phone. Deploy status is visible from GitHub check runs on the merge commit: `google-cloud-build` covers the server, `github-actions` covers Pages.

## Costs (request-based Cloud Run, us-east1)
- Free tier, shared across services: 180,000 vCPU-s and 360,000 GiB-s a month; 1 GiB/month of internet egress, then about $0.08–0.12/GB.
- Drive → Cloud Run ingress is free. Billed egress is what reaches the phone (the "internet" kind of `container/network/sent_bytes_count`).
- Rough guide: normal playback ~3,600 vCPU-s per hour watched; 1080p Smooth on the compile service ~7,200 vCPU-s per hour; 4K Smooth is several times that.

## Backlog
1. **Finish PR #38:** create the `rvp-compile` service, set `COMPILE_BASE`, then test 4K speed on the phone.
2. **Smart clip selection:** a background job samples each video for loudness/motion peaks and stores them in KV, and compilations cut from those peaks.
3. **Download manager + auto-tagging:** port the owner's Colab downloader (from their main purchase site) to a Cloud Run Job, and tag on download (source `i`). Open questions:
   - Service accounts can't own files in a personal Drive, so writing needs the owner's OAuth.
   - Site credentials must go in Secret Manager.
   - Site-specific code may belong in a private repo.
4. **Optional:** move Upstash off the Vercel account; disconnect Vercel's GitHub integration.
