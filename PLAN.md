# Sharebox — Free personal capture & auto-classification app

> Handoff plan. Spawned in `/home/holty/dev/Sharebox`.
>
> **Status (2026-10-09):** the core was rebuilt on branch `rebuild-core`, and the backend and frontend both run end-to-end locally (see §9). There are a few deliberate changes from the original plan:
> - API routes live under `/api/*`, and the Worker serves the PWA.
> - The app has a single owner.
> - Sync is row-level LWW instead of field-level merge.
> - Items no longer have a `status` field.
>
> These are marked inline below.

## 1. Problem

The user doesn't like how the `albo.inc` app works for them. They want a
self-contained replacement: something that captures anything they share
(links, text, images) and auto-classifies it into collections *they* define.
No built-in collections/folders. Free. Syncable to their laptop browser for
later review.

## 2. Decisions locked

| Area | Decision |
|---|---|
| Platform | **Android** (capture via the system share sheet) + **web browser** on laptop for later review |
| Free LLM | **Google Gemini free tier**, model `gemini-3.5-flash` (see §3) |
| PDF support | **Dropped** for v1. Link + text + images only. |
| Collections | Fully user-defined (created in-app). **Nothing pre-baked.** |
| Capture flow | Share -> pick collection (or "Uncategorized" -> later) -> item saved |
| Sync | Two-way sync to the user's own Cloudflare Worker + D1 (row-level last-write-wins by HLC) |
| Users | **Single owner.** Registration closes once the first account exists |
| Laptop review | Same app in a normal browser at the worker's URL |

## 3. Free LLM decision: Google Gemini free tier (`gemini-3.5-flash`)

The previous `Gemini2API` local-proxy setup did not work reliably, so it is
**deleted** and replaced with the direct, official Google Gemini API using the
**free tier** of `gemini-3.5-flash`. No paid subscription required for
personal use.

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`
- **Auth:** `X-Goog-Api-Key: <GEMINI_API_KEY>` (header), **no** OAuth flow needed.
- **Prompt guidance:** include a short system prompt telling the model to act
  as a personal content classifier and output only a JSON body:
  `{ "collection": "<collectionName|UNCLASSIFIED>", "tags": [...], "notes": "..." }`
- **Rate limits:** Google's free tier is rate-limited (per-minute and
  daily caps). The worker exposes a tiny local cache/memoizer keyed on
  (contentHash, collection) so an item is classified at most once per
  collection; retries on `429` are exponential-backoff with a short wait.
- **Secret handling:** the API key lives in the worker as a Cloudflare secret,
  **never** in the repo and **never** in the frontend.
- **What the classifier sees:** for a *link*, it fetches the page (`fetch` from
  the Worker — safe, no client exposure) and classifies the *title + text*;
  for *text*, the text itself; for *images*, it sends the image bytes to a
  vision-capable Gemini model (`gemini-3.5-flash` supports image input).

> The user must still obtain a free Google AI Studio API key (one-time, at
> account-setup time) and hand it to `wrangler secret put GEMINI_API_KEY` on
> the Worker they own.

## 4. Project layout (`~/dev/Sharebox`)

```
Sharebox/
├── README.md, PLAN.md
├── backend/
│   ├── wrangler.toml            (D1 binding, [assets] -> ../frontend/dist, run_worker_first /api/*)
│   ├── .dev.vars.example        (local secrets template; real .dev.vars is gitignored)
│   ├── migrations/0001_init.sql
│   ├── scripts/smoke.sh         (curl checks against a running worker)
│   └── src/
│       ├── index.ts             (Hono router under /api)
│       ├── auth.ts              (PBKDF2 passwords, HS256 JWT)
│       ├── sync.ts              (row validation, LWW applyOp, pull)
│       ├── classify.ts          (Gemini call, memo, 429 backoff)
│       └── env.ts
└── frontend/
    ├── vite.config.ts           (PWA manifest incl. share_target, injectManifest, /api dev proxy)
    └── src/
        ├── main.tsx, App.tsx, styles.css
        ├── sw.ts                (precache + POST /share handler)
        ├── api.ts               (fetch helpers + session)
        ├── db.ts                (Dexie store, HLC, local writes -> outbox)
        ├── sync.ts              (push outbox, pull + LWW apply, status store)
        ├── components/          (AuthView, ItemsView, ItemCard, ItemDetail, CaptureView,
        │                         CollectionsManager, SyncStatus, Sheet)
        └── lib/                 (schema.ts, subject.ts, share.ts)
```

## 5. Backend API (Cloudflare Worker + D1)

The Worker serves the built PWA as static assets. API routes sit under `/api/*`, so they never collide with SPA routes.

- **Auth:** `POST /api/auth/register` works only while no user exists, and creates the `uncategorized` collection. `POST /api/auth/login` returns `{ token, user }`, a 30-day HS256 JWT. Passwords use PBKDF2-SHA256 through WebCrypto. `GET /api/me`.
- **Collections:** `GET`, `POST /api/collections`, `PATCH`, `DELETE /api/collections/:id`. Uncategorized can't be deleted.
- **Items:** `GET /api/items?collection=&q=`, `POST /api/items`, `GET`, `PATCH`, `DELETE /api/items/:id`.
- **Classify:** `POST /api/classify { itemId }` returns `{ collectionId | null, tags[], notes }`. The Worker reads the item itself. Collections are offered to Gemini by name, and links are fetched server-side.
- **Sync:** `POST /api/sync/push { actor, ops: [{ entity, row }] }` returns per-row `accepted`. `GET /api/sync/pull?since=N` returns `{ ops, serverMaxSeq, more }`.
  - Every write, whether REST or push, is a full-row put that carries an HLC (`<13-digit ms>-<4-digit counter>-<node>`, string-comparable).
  - A put is stored only when its HLC is newer than the stored row's.
  - Accepted puts are appended to `sync_op`. Deletes are tombstones (`deleted_at`).
- **Database:** see `backend/migrations/0001_init.sql`. Tables: `users`, `collections`, `items` (each with `hlc`) and `sync_op`.

## 6. Frontend (Vite + React + Dexie PWA)

- **Capture**: registered as a share target via `share_target` in the web manifest
  (Android share sheet -> deep link to the app). A single "Add to Sharebox" entry
  appears in the system share sheet.
- **Capture flow**: user taps the share destination, picks an existing collection
  (a flat list of their collections) **or** "Uncategorized". Item is saved locally
  as `status=uncategorised` (if Uncategorized) or `status=queued` and pushed.
- **Uncategorized**: an item shared with no collection lands here; the user can
  later open their items list and re-classify into a collection.
- **Review**: `ItemsView` filters by collection + search. Tapping an item opens a
  detail screen (full content, tags, notes, collection, delete, or "re-classify").
- **Sync**: background loop pushes local outbox, pulls from server, applies ops
  with the HLC merge. Offline-capable; writes queue locally.

## 7. Build & verify steps (for the handoff agent)

1. Scaffold Worker + D1 (wrangler) and the Vite+React+Dexie frontend.
2. Implement backend: auth, collections, items, classify (with Gemini call), sync.
3. Implement frontend: capture view, collection list manager, items list/detail, sync loop.
4. Wire jsdelivr/cloudflare assets for the worker to serve the built PWA.
5. **Verify with real tool calls** (not assertions):
   - `wrangler dev`, `curl /health` → `{ok:true}`.
   - `curl /auth/register` then login → bearer token.
   - `curl /collections` (+ `POST` new collection) → returns it, no pre-seeded rows.
   - `curl /sync/push` a test op → `seq` bumps, `GET /sync/pull?since=` returns it.
   - Classify exactly **one real item** (a known link) → check the response is valid JSON
     with a `collection` string; confirm it is server-side only, no key in client bundle.
6. Build the frontend (`vite build`) and confirm the Worker serves `index.html` at `/`.
7. Check `git status` / `.gitignore` before any commit; do not rewrite history.

## 8. Open items

- User must supply a Google AI Studio API key (`GEMINI_API_KEY`) at deploy time.
- ~~Auto-create "Uncategorized"~~: done. It's created at register with id `uncategorized`, can be renamed, and can't be deleted.
- ~~Per-item "suggest collection"~~: done, as the **Suggest** button in ItemDetail. It's manual; nothing classifies items automatically on capture.
- Not yet verified: a real Gemini classification (needs a key), and the Android share sheet on a real device (needs the deployed HTTPS URL with the PWA installed).

## 9. Verified locally (2026-10-09)

- `backend/scripts/smoke.sh` against `wrangler dev`: 18/18 checks pass. They cover health, auth, single-owner registration, collections and items CRUD, push/pull, LWW rejecting a stale write, and tombstones.
- A Playwright run with a phone context and a laptop context covered these steps, with no console errors:
  - sign in on both
  - create a collection
  - capture a link and a note
  - filter by collection on the laptop
  - edit there and see the edit reach the phone
  - delete and see the delete sync
  - send a share-target POST through the service worker with an image, which was downscaled to 1024px and synced
  - write offline and see it sync after reconnecting
- The built `dist/` contains no secret names, no Gemini endpoint and no JWT secret.
