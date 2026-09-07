# Scanner imaging pipeline

How a camera frame becomes a page. Keep these invariants — each one is a bug we
already shipped once.

```
<video> frame
  └─ detector.ts / paper-detector.ts   → quad (normalized 0..1, video space)
       └─ useSmartCapture.quad         → the quad drawn on screen (smoothed / manual)
            └─ perspective.warpQuad    → rectified RGBA (true homography)
                 └─ enhance.applyEnhance → scan-looking page (de-shadow / binarize)
                      └─ image-io.encodeEnhanced → JPEG or PNG data URL
                           └─ server pdf.ts → PDF page (full-bleed, 1bpp when bilevel)
```

## Invariants

- **Capture the quad the user sees.** `useSmartCapture` displays a *smoothed*
  quad but detection returns a raw one each frame. Auto capture must warp
  `quad.value` (the displayed box), never the raw detection — otherwise the
  right-hand result silently differs from the box drawn on the left.
- **A manual edit freezes the box until reset.** Dragging a corner sets
  `manual = true`; only `rescan()` ("重置选框") resumes tracking. Auto shoot keeps
  working against the frozen quad.
- **Rectification is a homography, not an affine.** `perspective.ts` solves the
  8-parameter projective transform (`homography()`), then inverse-maps every
  output pixel. The old two-triangle affine matched the four corners but left the
  trapezoid distortion inside plus a crease on the diagonal —
  `tests/client/scanner-vision-perspective.test.ts` locks this down with a
  checkerboard whose cell width must stay uniform after warping.
- **Output aspect comes from vanishing points.** `estimateQuadAspect()` recovers
  the real width/height of a slanted rectangle (Zhang & He, whiteboard scanning);
  without it a page shot at an angle is squashed. Falls back to the longest
  opposite edges when the quad is (nearly) a parallelogram or the math is
  unstable. An explicit `aspectRatio` (A4 etc.) always wins.
- **Shadows are removed by flat-field division, not by contrast.** `enhance.ts`
  estimates the illumination background (`estimateBackground`: dilate to erase
  strokes, then blur, computed on a ~256px thumbnail for speed) and divides the
  image by it. Blurring without dilating first drags text into the background and
  greys out the strokes.
- **Binarization is local (Sauvola), never global Otsu.** Global thresholds turn
  the shadowed half of a spread solid black. `filters.sauvolaBinarize` uses
  integral images so the window size is free; Otsu stays only as a fallback when
  the adaptive result is degenerate (all white / mostly black).
- **Bilevel pages ship as PNG from the client.** JPEG ringing around black text
  is what makes an export look like a photo instead of a document, and the server
  needs a lossless source to detect bilevel and embed 1bpp. See
  `image-io.encodeEnhanced` + `enhance.isBilevelPreset`.
- **PDF pages are full-bleed and image-sized.** `services/scanner/pdf.ts` sets
  `/MediaBox` from image pixels / DPI (default 200) and draws the image over the
  whole page. Pasting a scan into the middle of an A4 with margins is what made
  exports look like screenshots. `layout: 'a4'` remains for printing.
- **Do not embed a PNG file as `/FlateDecode`.** A PNG is not a raw zlib stream;
  the old code produced corrupt PDFs for PNG input. Non-JPEG input is decoded
  with sharp, then either packed to 1bpp + deflate (bilevel) or re-encoded to
  JPEG.
- **Searchable text layers are invisible (3 Tr) + non-embedded CID font.**
  `buildInvisibleTextStream` writes per-page OCR text as UTF-16BE hex strings
  under `/STSong-Light` + `/UniGB-UCS2-H`; viewers substitute a system CJK font,
  so no font file ships with the app. Selection is per-line (evenly split page
  height), never per-glyph — don't promise exact highlight alignment.
- **Advanced enhance sliders default to the legacy pipeline.** `shadowRemove=100,
  denoise=0, binarizeSensitivity=0, whiteness=0` must produce byte-identical
  output to the old fixed pipeline (`ENHANCE_ADVANCED_DEFAULTS` +
  `tests/client/scanner-vision-enhance.test.ts` lock this). `whitenPaper` is a
  knee curve: pixels below luma 110 (strokes) are untouched, only highlights are
  stretched — a plain black-point lift darkens text and is wrong.

## Adjustable enhance parameters (UI: 高级调节)

| param | range | effect |
| --- | --- | --- |
| `shadowRemove` | 0..100 | blend between raw illumination and flat-fielded gray (scan/bw) |
| `denoise` | 0..100 | 3×3 median (RGBA presets) or binary despeckle (bw) |
| `binarizeSensitivity` | -50..50 | maps Sauvola `k = 0.2 - v*0.004`; positive → thicker/darker strokes |
| `whiteness` | 0..100 | knee white-point push (scan/bw), strokes below knee kept |

## Cost budget (2200×1600 page, main thread)

| step | ms |
| --- | --- |
| `warpQuad` | ~170 |
| `applyEnhance` gray | ~70 |
| `applyEnhance` bw (de-shadow + Sauvola) | ~330 |
| `applyEnhance` scan (de-shadow + levels + sharpen) | ~550 |

Enhancement runs debounced (220 ms) on slider changes. If a heavier algorithm is
added, move the pipeline into a worker instead of raising the debounce.

## Tests

- `tests/client/scanner-vision-perspective.test.ts` — homography exactness,
  aspect recovery, checkerboard uniformity after rectification.
- `tests/client/scanner-vision-enhance.test.ts` — shadow flattening, adaptive
  binarization on a shadowed page, strict bilevel output.
- `tests/client/scanner-smart-capture.test.ts` — manual lock stays until reset,
  auto shoot against the frozen quad.
- `tests/server/scanner-pdf.test.ts` — full-bleed page box, 1bpp packing,
  JPEG passthrough.
