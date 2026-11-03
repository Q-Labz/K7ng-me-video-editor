# KutLabz — AI Video Studio

A video editor that runs entirely in the browser. No build step, no server-side processing and no uploads: all decoding, analysis, grading and export happen on your machine.

## Run

Open `index.html` through any static server, for example:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Opening the file directly (`file://`) also works in most browsers. The camera needs `localhost` or HTTPS.

## Features

| Area | What it does |
| --- | --- |
| **Import** | Video and image files from the button or by dropping them anywhere. Assets are added to the timeline automatically; drag them from the asset panel to insert at a position. |
| **Camera** | Live preview with grading applied in real time; recordings become new assets. |
| **Timeline** | Video track, text lane and music lane. Drag clips to reorder, drag edges to trim, **S** splits at the playhead, **Del** removes a clip, **Ctrl+Z / Ctrl+Shift+Z** undo and redo. Filmstrip thumbnails, an audio waveform after silence analysis, zoom slider / Ctrl+wheel, **Fit**. |
| **Color** | WebGL shader pipeline: exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance, vignette, fade. Hold **Raw** (or `\`) to compare against the ungraded image. |
| **Creative LUTs** | 8 built-in 33³ looks, plus **Import .cube** (3D LUTs, any size up to 129³) with an intensity control. |
| **Aspect** | Source, 16:9, 9:16, 1:1, 4:5 output. |
| **Export** | **Frame PNG** at full output resolution. **Export WebM** renders the timeline in real time (VP9/VP8 + Opus) through `MediaRecorder`. |

### AI tools (local heuristics, no models or network)

Nothing is uploaded: every tool analyses downscaled frames or decoded PCM in the browser.

**Edit**
- **Detect Scene Cuts** – compares luma and RGB histograms between sampled frames with an adaptive (median + MAD) threshold, then refines each cut to the exact frame. Click a marker to seek; **Split at cuts** (Shift+S) cuts at all of them.
- **Highlight Reel** – scores every half second by motion (frame difference), audio energy (RMS) and visual interest (contrast + colour), then keeps the strongest moments up to 15/30/60/90 s in their original order. Undo restores the full edit.
- **Detect Dead Frames** – marks black stretches (≥ 0.3 s) and frozen stretches (≥ 1.5 s) as hatched zones.
- **Cut Marked Zones** – splits clips to remove marked silence and dead frames (undoable).

**Audio**
- **Detect Silence** – computes RMS in 20 ms windows, picks a threshold from the noise floor and peak level, and marks quiet stretches of at least 0.45 s in red.
- **Loudness Match** – gated loudness per clip (400 ms blocks, absolute and relative gates, as in EBU R128 but without K-weighting), then a per-clip gain to a common level, capped so peaks stay under 0 dBFS.
- **Voice Enhance** – per-clip chain: 90 Hz rumble cut, 300 Hz de-mud, 3.2 kHz presence lift and gentle compression.
- **Add Music Bed** – imports an audio file that plays under the edit and is mixed into the export. Beat tracking (onset envelope → autocorrelation tempo → best-phase grid) draws the beat grid. **Auto duck** dips the music while the clips' own audio is active.
- **Cut to Beat** – moves each cut back to the last beat before it, so every clip ends on the music grid.

**Color**
- **Auto Grade** – measures luminance percentiles, a grey-world white balance on mid-tones and mean chroma in the current frame, then sets exposure, white balance, contrast and saturation.
- **Match Shots** – matches exposure, white balance and saturation of every clip to the selected clip (or the one under the playhead), as per-shot offsets on top of the global grade. **Reset Color** clears them.
- **AI Color Match** – Reinhard-style transfer of Lab mean and standard deviation from a reference image, baked into a 3D LUT.

**Framing**
- **Smart Reframe** – tracks the centre of motion (frame differencing, falling back to edge saliency when nothing moves) and smooths it into a virtual camera. Gives a 1.35× punch-in at source aspect, or a tracked crop when you choose 9:16, 1:1 and so on.
- **Stabilize** – block-matching global motion estimation (coarse-to-fine, cut-aware), a smoothed camera path, and a crop that follows the jitter. The crop is only as large as the measured shake (6–20 %).

**Content**
- **Add Text** – title, lower third or caption at the playhead, drawn in the brand fonts and burned into exports. Edit or retime it by double-clicking it on the text lane; **Del** removes it.
- **Import Captions** – `.srt` or `.vtt` cues become captions on the text lane.
- **Best Thumbnail** – scores frames across the edit for sharpness (Laplacian variance), exposure, contrast and colourfulness, avoids cuts and dead frames, and saves the winner as a graded PNG.
- **Chapters** – YouTube chapter list from scene cuts, clip boundaries and titles (first at 0:00, at least 10 s apart), ready to copy into a description.

AI tools act on the selected clip, or on every clip when none is selected.

## Keyboard

`Space` play/pause · `←/→` seek 1 s (`Shift` 5 s) · `,` / `.` frame step · `Home` / `End` · `S` split · `Shift+S` split at cuts · `Del` delete · `M` mute · `\` hold raw · `+` / `-` zoom · `Esc` cancel/deselect

## Notes and limits

- Grading is project-wide; framing is per clip.
- Export runs in real time and needs the tab to stay visible. WebM files from `MediaRecorder` carry no duration metadata, which most players handle fine.
- Audio-only files are not supported as clips.

## Code layout

```
index.html        UI shell
css/style.css     styles
js/luts.js        procedural looks, .cube parser, Lab color math, color transfer
js/gl.js          WebGL renderer (framing → grade → 3D LUT → vignette)
js/analysis.js    frame sampling, scene / silence / motion analysis, auto grade
js/app.js         state, playback engine, timeline, tools, camera, export
```
