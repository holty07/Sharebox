# Sharebox

Free, self-contained personal capture + auto-classification app.

- **Capture**: Android share sheet, anything (links, text, images). PDFs excluded for now.
- **Classify**: Google Gemini free tier (`gemini-3.5-flash`), server-side only.
- **Collections**: fully user-defined — no built-in collections or folders.
- **Capture flow**: pick an existing collection, or "Uncategorized" -> review later and classify into a collection.
- **Sync**: to your own Cloudflare Worker + D1, browser review on your laptop.
- **Frontend**: Vite + React + Dexie PWA. **Backend**: Cloudflare Worker (D1 + free Gemini API).

## Setup (for the person deploying)

1. `cd backend && wrangler deploy` (needs a Cloudflare account + D1)
2. `wrangler secret put GEMINI_API_KEY` (Google AI Studio free key)
3. `cd frontend && pnpm install && pnpm build`
4. Point `VITE_WORKER_URL` to your deployed worker URL.
5. Open the PWA in a browser (install to desktop for app-like use).
