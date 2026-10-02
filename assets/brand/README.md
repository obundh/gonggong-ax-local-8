# Recovery Chat brand mark

`recovery-mark-source.png` is the approved raster source made with Codex ImageGen.
It depicts a white document with a lifted corner and a blue return arrow on a slate-blue rounded tile.

Regenerate the app assets with `python scripts/generate-brand-assets.py`. The script removes only the near-white canvas connected to the four outside corners, then writes `recovery-mark-512.png`, `electron/icon.png`, and the multi-resolution `electron/icon.ico`.

ImageGen prompt: `original compact professional recovery mark; rounded cool blue and slate square tile; clean white document page with a subtly lifted top-right corner; single simple recovery arrow curving back toward the document; no letters, words, numerals, logos, watermark, UI chrome, or extra objects.`
