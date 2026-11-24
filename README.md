# MealTrack

A phone app for scanning food barcodes and tracking your nutrition. It's an installable
web app (PWA), so it works on both iPhone and Android with no app store.

## Features

- **Barcode scanning** with the phone camera (EAN-13/8, UPC-A/E). Nutrition data comes from
  [Open Food Facts](https://world.openfoodfacts.org), a free, open database.
- **Restaurant & everyday food search** (e.g. "subway teriyaki", "big mac") via
  [USDA FoodData Central](https://fdc.nal.usda.gov), plus packaged products from Open Food Facts.
  Without a key it uses a shared demo key with a low hourly limit; add a
  [free personal key](https://fdc.nal.usda.gov/api-key-signup) in Settings to lift it.
- **Type a barcode** when the camera can't read it.
- **Custom foods.** If a product isn't in the database, enter it from the label once and the
  app remembers it the next time you scan it.
- **Daily diary** split into breakfast, lunch, dinner and snacks: a calorie ring, protein/carb/fat
  bars, and editable entries with undo on delete.
- **Servings or grams**, with each food remembering your usual portion.
- **My foods** list for quick re-adding.
- **Goals, JSON backup/restore, and CSV export.**
- **Private and offline.** All data stays in your phone's browser storage. Foods you've already
  scanned work without a connection.

## Install on your phone

1. Host the app over HTTPS (browsers only allow the camera on HTTPS). With GitHub Pages:
   **Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**.
   Every push to `main` then redeploys automatically.
2. Open the Pages URL on your phone.
   - **iPhone (Safari):** Share → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home screen**.
3. Open MealTrack from the home screen and allow camera access when it asks.

## Run locally

No build step is needed:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Camera access works on `localhost`. To test on a phone you
need HTTPS, so use the deployed site or a tunnel.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App layout |
| `styles.css` | Styling (light & dark mode) |
| `app.js` | All app logic: scanning, lookup, diary, storage |
| `sw.js` | Service worker for offline use (bump `VERSION` when you change files) |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata |
| `vendor/html5-qrcode.min.js` | Barcode scanning library (Apache-2.0) |

Nutrition data © Open Food Facts contributors, ODbL. Values may be incomplete, so check them
against the label.
