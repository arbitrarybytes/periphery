# Periphery — Landing Page

A static, build-step-free landing page for Periphery. Open `index.html` in any browser, or serve the folder from any static host.

```
index.html   Structure and copy — one page, section per core tenet
styles.css   Design system (Fraunces / Instrument Sans / Spline Sans Mono, night palette)
script.js    Cue engine (comet, edge glow, bottom glow), starfield, live demos
```

Design notes:

*   **The page is the demo.** The tier trigger buttons, the hero CTA, and the "run it" button in the connectors section fire real cues on the viewport via the same visual grammar as the app (comet = Tier 1, edge glow = Tier 2, bottom glow = Tier 3). An ambient loop fires a soft cue roughly every 21 seconds — infrequent on purpose.
*   **Live demos.** The Slack Tide and Constellation panels run looping, IntersectionObserver-gated timelines; they pause when scrolled out of view.
*   **Reduced motion.** With `prefers-reduced-motion` set, travelling cues degrade to stationary fades and decorative animation stops — mirroring the app's own contract.
*   **External assets.** Webfonts come from Google Fonts and icons from the icons8 CDN (licensed). Everything else is inline; there are no frameworks and no build tooling.
