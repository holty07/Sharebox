# Sharebox

Free, self-hosted capture and auto-classification app for one person.

- **Capture.** From the Android share sheet (links, text and images) or with the **+** button in the app. PDFs aren't supported yet.
- **Collections.** You define them all. The only built-in one is a renamable "Uncategorized".
- **Classify.** A **Suggest** button on an item asks Google Gemini (`gemini-3.5-flash`, free tier) to pick a collection and add tags and a note. This runs server-side only; the key never reaches the browser.
- **Sync.** The app works offline-first in IndexedDB and syncs to your own Cloudflare Worker + D1 (row-level last-write-wins). You can review on your laptop in any browser.
- **Stack.** The frontend is a Vite + React + Dexie PWA. The backend is a Cloudflare Worker (Hono, D1) that also serves the built PWA.

## Local development

```sh
# one-time
cd backend && npm install && cp .dev.vars.example .dev.vars   # edit the secrets
npm run db:migrate:local
cd ../frontend && pnpm install

# run: build the PWA, then serve PWA + API from the Worker on :8787
cd frontend && pnpm build
cd ../backend && wrangler dev
# or, for UI hot reload: keep `wrangler dev` running and `cd frontend && pnpm dev` (:5173 proxies /api)

# smoke-test the API (registers the owner on an empty DB)
backend/scripts/smoke.sh http://localhost:8787 you@example.com 'your-password'
```

## Deploy

```sh
cd backend
wrangler d1 create sharebox                 # paste database_id into wrangler.toml
npm run db:migrate:remote
wrangler secret put SHAREBOX_JWT_SECRET     # any random string, 32+ characters
wrangler secret put GEMINI_API_KEY          # free key from Google AI Studio
cd ../frontend && pnpm build && cd ../backend && wrangler deploy
```

After deploying:
1. Open the Worker URL and choose **Create the owner account**. Registration closes after the first account.
2. On Android, open the URL in Chrome and pick **Install app**. **Sharebox** then shows up in the share sheet.
