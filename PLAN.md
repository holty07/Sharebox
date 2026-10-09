# Sharebox — Free personal capture & auto-classification app

> Handoff plan. Spawned in `/home/holty/dev/Sharebox`.

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
| Sync | Two-way sync to the user's own Cloudflare Worker + D1 |
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
├── README.md
├── PLAN.md                 (this file)
├── backend/
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json
│   ├── migrations/         (0001_init.sql for D1)
│   └── src/
│       ├── index.ts        (router: health, auth, collections, items, classify, sync)
│       ├── db.ts           (D1 schema + migrations runner)
│       ├── secrets.ts      (GEMINI_API_KEY access)
│       ├── classify.ts     (Gemini call + caching + retry on 429)
│       ├── sync.ts         (push/pull with op log + field-level HLC merge)
│       └── auth.ts         (Bearer JWT, register/login)
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    ├── manifest.webmanifest
    ├── public/
    │   └── shareintent/
    │       └── share.html  (deep link for Android share sheet)
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── db.tsx          (Dexie/IndexedDB client store, mirroring server entities)
        ├── api.ts          (fetch helpers: collections, items, classify, sync)
        ├── sync.ts         (local outbox + background push/pull loop, offline queue)
        ├── components/
        │   ├── CaptureView.tsx     (share-destination UI; pick collection or Uncategorized)
        │   ├── CollectionsView.tsx (flat list of user-created collections)
        │   ├── CollectionsManager.tsx (create/rename/delete collections)
        │   ├── ItemsView.tsx       (review items, filter by collection + search)
        │   ├── ItemDetail.tsx      (open a single item: content, metadata, re-classify, delete)
        │   └── SyncStatus.tsx      (sync state: online/offline/syncing/error)
        └── lib/
            ├── subject.ts        (build the "subject" string + hash from link/text/image)
            └── schema.ts         (types shared between client & worker)
```

## 5. Backend API (Cloudflare Worker + D1)

- **Auth**: `POST /auth/register` (create a personal workspace), `POST /auth/login` (Bearer JWT).
- **Collections**: `GET /collections`, `POST /collections` (name), `DELETE /collections/:id`, `PATCH /collections/:id` (rename/delete) — no pre-seeded rows.
- **Items**: `GET /items?collection=<id>&q=<search>`, `POST /items`, `GET /items/:id`, `DELETE /items/:id`.
- **Classify**: `POST /classify` — body `{ subject, subjectType, collectionIds[] }` → returns
  `{ collection, tags[], notes }`. Only reachable server-side via the Worker.
- **Sync**: `POST /sync/push`, `GET /sync/pull?since=<n>`, reusing the existing
  append-only op-log + field-level HLC merge pattern (spec 4.1–4.3.4).
- **Database**: D1 single SQLite file with tables `users`, `collections`
  (`id, name, created_at, updated_at, deleted_at`), `items`
  (`id, collection_id, subject, kind, content, tags, notes, status,
  created_at, updated_at, deleted_at`), `sync_op`.

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

## 8. Open items for the handoff agent

- User must supply a Google AI Studio API key (`GEMINI_API_KEY`) at deploy time.
- Whether to auto-create an "Uncategorized" collection on first run (recommended: yes, one row, renamable).
- Whether to expose a per-item "suggest collection" inline action in `ItemDetail`.
