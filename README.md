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
| **Timeline** | Single track. Drag clips to reorder, drag edges to trim, **S** splits at the playhead, **Del** removes a clip, **Ctrl+Z / Ctrl+Shift+Z** undo and redo. Filmstrip thumbnails, an audio waveform after silence analysis, zoom slider / Ctrl+wheel, **Fit**. |
| **Color** | WebGL shader pipeline: exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance, vignette, fade. Hold **Raw** (or `\`) to compare against the ungraded image. |
| **Creative LUTs** | 8 built-in 33³ looks, plus **Import .cube** (3D LUTs, any size up to 129³) with an intensity control. |
| **Aspect** | Source, 16:9, 9:16, 1:1, 4:5 output. |
| **Export** | **Frame PNG** at full output resolution. **Export WebM** renders the timeline in real time (VP9/VP8 + Opus) through `MediaRecorder`. |

### AI tools (local heuristics, no models or network)

- **Auto Grade** – measures luminance percentiles, a grey-world white balance on mid-tones and mean chroma in the current frame, then sets exposure, white balance, contrast and saturation.
- **Detect Scene Cuts** – compares luma and RGB histograms between sampled frames with an adaptive (median + MAD) threshold, then refines each cut to the exact frame. Click a marker to seek; **Split at cuts** (Shift+S) cuts at all of them.
- **Detect Silence** – decodes the audio track, computes RMS in 20 ms windows, picks a threshold from the noise floor and peak level, and marks quiet stretches of at least 0.45 s in red.
- **Apply Silence Cuts** – splits clips to remove the marked silences (undoable).
- **AI Color Match** – Reinhard-style transfer of Lab mean and standard deviation from a reference image, baked into a 3D LUT.
- **Smart Reframe** – tracks the centre of motion (frame differencing, falling back to edge saliency when nothing moves) and smooths it into a virtual camera. Gives a 1.35× punch-in at source aspect, or a tracked crop when you choose 9:16, 1:1 and so on.

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
