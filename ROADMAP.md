# ShopBot Roadmap

## Phase 1 — Core (In Progress)
- [ ] Strip Supabase + approval page from code
- [ ] Add Telegram inline buttons (Activate / Edit)
- [ ] Test end-to-end locally
- [ ] Deploy to Render

## Phase 2 — Better Listings
- [ ] Expand to 7-9 product images via Stability AI (lifestyle, close-up, size comparison)
- [ ] Rich banner generation via Canva API (one-time template setup) — join waitlist at canva.com/developers
- [ ] Amazon Brand Registry enrollment (unlocks A+ Content)

## Phase 3 — Marketplaces
- [ ] Amazon SP-API keys + go live
- [ ] Flipkart Seller API keys + go live
- [ ] One-tap Activate button per platform

## Phase 4 — Scale
- [ ] Bulk upload (multiple photos at once)
- [ ] Edit listing via Telegram before activating
- [ ] Analytics — which listings get the most clicks/sales

---

## API Keys Tracker
| API | Purpose | Status |
|-----|---------|--------|
| Telegram Bot Token | Bot interface | ✅ Ready |
| Anthropic (Claude) | Image validation + listing generation | ⏳ Needed |
| Stability AI | Multi-angle image generation | ⏳ Needed |
| remove.bg | Background removal | ⏳ Optional |
| Amazon SP-API | Marketplace listing | ⏳ Phase 3 |
| Flipkart Seller API | Marketplace listing | ⏳ Phase 3 |
| Canva API | Rich banner generation | ⏳ Phase 2 (waitlist) |
