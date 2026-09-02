# Mascot moods

Six moods, one morphing SVG. A studio preview of the uncoverLAB cat mascot: the illustration was drawn in six states, and this prototype morphs between them and keeps the character alive in each one.

**Live preview:** https://alexszczurek.github.io/mascot-moods/

## Moods

1. **Neutral** — breathes, glances around, flicks an ear now and then
2. **Angry** — stomps in a loop (crouch, launch, slam, shudder), ears pinned back
3. **Mad** — side-eye with the occasional full eye-roll, ears flat
4. **Sad** — ears droop and sway, eyes cast down, sniffles
5. **Sleepy** — closed lids and the mouth ride the breath, a lid twitches, zzz drift up
6. **Worried** — trembles, pupils dart, sparkles in the eyes

Switch with the chips, click the character, use ← → or 1–6, and space for autoplay. `prefers-reduced-motion` keeps the morph and drops the shaking.

## How the morph works

The six SVGs have different node counts, so paths cannot be interpolated as-is. Every layer (head, eyes, pupils, mouth, jaw line, brow, sparkles) is sampled into a fixed number of points along its outline. Layers that share fixed features across states are sampled between anchors, so the body of the head and the nose inside the mouth get identical points in every state and stay perfectly still while ears and mouth line morph. Points are interpolated with a spring and drawn as a closed centripetal Catmull-Rom spline, so the outline stays smooth at any zoom.

On top of the morph, small rigs run every frame: ears (a height-weighted deformation of the top segment), pupils (a smoothed offset the moods move around), and lids and mouth in the sleep state. Everything writes `d` straight to the DOM; React never re-renders during motion.

## Run locally

```bash
npm install
npm run dev
```

## Files

- `components/prototypes/MascotMoods.tsx` — engine, rigs, component and scoped styles
- `components/prototypes/mascotMoodsData.ts` — the six states' path data, generated from the source SVGs
- `docs/index.html` — the same prototype compiled to a single self-contained page (React from CDN), served by GitHub Pages

## Deploy

Static Next app, ready for Vercel. Or just serve `docs/index.html`.
