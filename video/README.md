# Reframe launch video

A self-contained [Hyperframes](https://github.com/heygen-com/hyperframes) composition —
"write HTML, render video" — that tells the Reframe story in ~14.5s:
**boot → map → 6-agent fan-out → green PR.**

No external media assets. Animation is GSAP (loaded from CDN at render time).

## Requirements

- Node.js **22+**
- **FFmpeg** on your PATH

## Preview (live, in the browser)

```bash
cd video
npx hyperframes preview
```

## Render to MP4

```bash
cd video
npx hyperframes render --output reframe.mp4
# → reframe.mp4  (1920x1080, ~14.5s, 30fps)
```

## Make the README GIF / WebP

```bash
# loopable GIF for embedding (smaller, ~12fps):
ffmpeg -i reframe.mp4 -vf "fps=12,scale=1280:-1:flags=lanczos" reframe.gif

# or a crisp animated WebP (better quality/size):
ffmpeg -i reframe.mp4 -vf "fps=15,scale=1280:-1" -loop 0 reframe.webp
```

Then point the demo image in the root `README.md` at the generated file.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The composition (root `data-composition-id="reframe-launch"`, GSAP timeline) |
| `meta.json`  | Project metadata (name, id, dimensions, fps) |
| `render.sh`  | One-shot: render MP4 **and** produce `reframe.gif` |

> Tip: edit it conversationally with an AI agent — `npx skills add heygen-com/hyperframes`,
> then "make the title 2× bigger" / "add a fade-out at the end."
