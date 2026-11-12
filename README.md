# KutLabz — AI Video Studio

A video editor that runs entirely in the browser. No build step, no server-side processing and no uploads: all decoding, analysis, grading and export happen on your machine.

## Mobile — Reels, TikTok, Shorts

On phones and small tablets the editor switches to a mobile layout automatically:

- **Vertical first:** a full-height 9:16 preview (1080×1920 output), with the timeline and a bottom tab bar for **Edit · AI · Look · Create · Assistant**. Each tab opens a bottom sheet.
- **Make a Reel:** one tap takes raw footage to a finished vertical short. It reframes to 9:16 so the subject stays in frame, cuts silence and dead frames, trims to 15 / 30 / 60 / 90 s using the strongest moments, and levels the audio (optionally with voice enhance). Every step is undoable. Also available on desktop under **Edit → Make a Reel…**.
- **Safe-zone guides:** the **Guides** button cycles through TikTok, Reels and Shorts overlays. They show where each app's buttons and captions cover the frame, and are never exported.
- **Touch timeline:** tap a clip to select it, then drag it to move or drag its handles to trim. One finger pans, two fingers pinch to zoom, and a tap on empty track moves the playhead.
- **Export to apps:** export prefers MP4 (H.264/AAC) wherever the browser can record it, which is what Instagram, TikTok and YouTube want. On phones, **Share…** opens the system share sheet so the video goes straight to an app or to Photos.
- **Install:** "Add to Home Screen" (iOS Safari) or "Install app" (Android Chrome) runs KutLabz full-screen like a native app, and the app shell works offline. On Android, the installed app also appears in the share sheet, so you can share videos from your gallery straight into the editor.

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
| **Screen** | Record a screen, window or tab with microphone narration and system audio mixed in. Recordings land on the timeline tagged `SCREEN`; **Auto Zoom** and **Detect Dead Frames** are made for them. |
| **Image Studio** | Photoshop-style still editor with layers (blend modes, opacity, merge), brush, eraser, clone stamp, spot heal, fill, wand erase, eyedropper, text layers, crop, rotate/flip, live adjustments, filters and AI enhance. Opens the selected image or the frame under the playhead; **Add to timeline** sends the result back as a new asset. |
| **Assistant** | Edit by describing what you want (right panel → Assistant). Works offline with built-in commands; connect your own Anthropic API key to have Claude plan and run multi-step edits. |
| **Timeline** | Video track, text lane and music lane. Drag clips to reorder, drag edges to trim, **S** splits at the playhead, **Del** removes a clip, **Ctrl+Z / Ctrl+Shift+Z** undo and redo. Filmstrip thumbnails, an audio waveform after silence analysis, zoom slider / Ctrl+wheel, **Fit**. |
| **Color** | WebGL shader pipeline: exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance, vignette, fade. Hold **Raw** (or `\`) to compare against the ungraded image. |
| **Creative LUTs** | 8 built-in 33³ looks, plus **Import .cube** (3D LUTs, any size up to 129³) with an intensity control. |
| **Aspect** | Source, 16:9, 9:16, 1:1, 4:5 output. |
| **Export** | **Frame PNG** at full output resolution. **Export Video** renders the timeline in real time through `MediaRecorder`: MP4 (H.264 + AAC) where the browser supports it, otherwise WebM (VP9/VP8 + Opus). |

### AI tools (local heuristics, no models or network)

Nothing is uploaded: every tool analyses downscaled frames or decoded PCM in the browser. (The optional Claude assistant is the one exception, and it only sends text — see below.)

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

**Framing** also has **Auto Zoom**: for screen recordings, it finds where the screen is changing (typing, clicks, a panel scrolling), pushes in on that area, holds for a beat, and eases back out when activity spreads or stops.

### Image Studio

| Area | What it does |
| --- | --- |
| **Tools** | Move (V) · Brush (B) · Eraser (E) · Clone (S, Alt-click a source) · Spot heal (J, harmonic fill from the surrounding pixels) · Fill (G) · Wand erase (W) · Eyedropper (I) · Text (T) · Crop (C, Shift for square, Enter to apply). `[` / `]` brush size, Space-drag or middle-drag to pan, wheel to zoom, `0` to fit. |
| **Layers** | Pixel and text layers; 15 blend modes, opacity, visibility, duplicate, reorder, merge down. |
| **Adjust** | Exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance, clarity, sharpen, denoise, vignette, grain — previewed live, applied to the active layer. |
| **Filters** | Blur, sharpen, black & white, sepia, invert, posterize, pixelate. |
| **AI enhance** | **Auto Enhance** (levels from luminance percentiles, partial grey-world white balance, vibrance, light denoise and sharpening) · **Upscale 2×** (high-quality resample + detail sharpening) · **Remove Background** (flood from the borders through the dominant backdrop colours, feathered edge; for studio, product and flat backgrounds) · **Denoise** (edge-preserving). |
| **Output** | PNG or JPG download, or **Add to timeline**. Undo/redo covers the last 20 steps. |

### Assistant

- **Local (default, offline):** understands requests like “cut the silences and level the audio”, “make a 30 second highlight reel”, “vertical for TikTok”, “warmer and a bit brighter”, “use the teal look”, “add title "Launch Day"”, “stabilize”, “auto zoom”, “undo”. Each action is listed as it runs.
- **Claude (opt-in):** **Connect Claude** and paste an Anthropic API key. The assistant uses Claude Opus 5.5 (`claude-opus-5-5`) through the official `@anthropic-ai/sdk`, loaded from jsDelivr. Claude gets tools for reading the timeline, running every AI tool, grading, looks, aspect, text and cut-level edits, and plans multi-step edits itself. Server-side refusal fallbacks are on. **What is sent:** your messages and a text summary of the timeline (clip names, times, settings), straight from your browser to `api.anthropic.com`. Media never leaves the machine. The key is kept for the session only, or in this browser's storage if you tick *Remember*; usage is billed to your key.

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
