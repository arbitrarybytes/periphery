'use strict';

/**
 * Generates every derived image asset from two sources of truth:
 *
 *   build/logo.png      the app icon — a neon glyph on a dark plate
 *   ui/assets/icon.svg  the concept mark — an orbit ring with a signal dot
 *
 * Two marks, on purpose. The logo carries the brand wherever there is room for
 * it (installer, taskbar, website, README). It does not survive a 16px tray
 * slot: the plate fills the square and the glyph turns to mush. The ring mark
 * does survive, and shares the logo's violet-to-cyan gradient so the two read
 * as one family. `scripts/_preview-tray.js` is how that was verified — by
 * looking at both magnified, not by assuming.
 *
 * Electron is already a dependency and bundles a real browser engine, so it
 * does the rasterising and resampling rather than pulling in an image library.
 *
 * Usage: npm run assets
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'build', 'logo.png');
const MARK = path.join(ROOT, 'ui', 'assets', 'icon.svg');

/**
 * Square sizes to emit from the logo, and where each one is consumed.
 *
 * Format is chosen per usage, not globally. WebP is roughly 5x smaller than
 * PNG on this artwork — worth taking everywhere the consumer is a browser.
 * Everything else is a tool or an OS surface that wants PNG.
 */
const LOGO_TARGETS = [
  // Build input for `tauri icon` and electron-builder, which want 1024px.
  // Upscaled from a 556px source, so it adds bytes rather than detail — but it
  // is never shipped, only consumed by the icon generators.
  ['build/icon.png', 1024, 'png'],
  // Landing page: hero/open-graph, nav mark, and README.
  ['docs/assets/logo-512.webp', 512, 'webp'],
  ['docs/assets/logo-256.webp', 256, 'webp'],
  ['docs/assets/logo-128.webp', 128, 'webp'],
  // iOS home-screen readers do not all accept WebP.
  ['docs/apple-touch-icon.png', 180, 'png'],
  ['docs/favicon-32.png', 32, 'png'],
  // Shown in the Settings and onboarding window headers.
  ['ui/assets/logo.png', 256, 'png'],
];

/** Tray sizes. Windows asks for 16px and scales up on high-DPI displays. */
const TRAY_TARGETS = [
  ['ui/assets/tray.png', 16, 'png'],
  ['ui/assets/tray@2x.png', 32, 'png'],
  ['ui/assets/tray@3x.png', 48, 'png'],
];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const dataUri = (file) => {
  const ext = path.extname(file) === '.svg' ? 'svg+xml' : 'png';
  return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
};

const write = (relative, dataUrl) => {
  const out = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const body = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(out, body);
  return body.length;
};

/**
 * Draws `src` into a transparent square of `size` and returns a PNG data URL.
 * Runs inside the page so the browser's own resampler does the work.
 *
 * The source logo is 556x564 — very nearly, but not exactly, square. Every
 * consumer here wants a square, so it is letterboxed and centred rather than
 * stretched, which would visibly skew the rounded plate.
 */
const RENDER = `
  (src, targets) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('could not decode source image'));
    img.onload = () => resolve(targets.map(([size, format]) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const scale = Math.min(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      // 0.92 is visually lossless on this artwork — the neon gradients are the
      // only thing WebP could plausibly band, and they survive.
      return format === 'webp'
        ? canvas.toDataURL('image/webp', 0.92)
        : canvas.toDataURL('image/png');
    }));
    img.src = src;
  })
`;

/**
 * Renders the Open Graph card — what a shared link actually shows.
 *
 * A square logo is the wrong asset for this: the 1.91:1 slot letterboxes it
 * into a thin strip. So the card is composed at the real aspect ratio, in the
 * site's own palette, and captured as a page rather than resampled from the
 * icon.
 */
async function buildSocialCard(win) {
  const html = `<!doctype html><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&family=Instrument+Sans:wght@400..600&display=swap" rel="stylesheet">
  <style>
    html, body { margin: 0; width: 1200px; height: 630px; }
    body {
      background:
        radial-gradient(900px 500px at 78% 18%, rgba(199,125,255,.20), transparent 60%),
        radial-gradient(700px 460px at 12% 88%, rgba(56,197,255,.16), transparent 62%),
        #070912;
      display: flex; align-items: center; justify-content: center;
      gap: 62px; padding: 0 88px;
      box-sizing: border-box; color: #e9eef7;
      font-family: 'Instrument Sans', system-ui, sans-serif;
    }
    img { width: 232px; height: 232px; flex: none; }
    h1 {
      font-family: Fraunces, Georgia, serif; font-weight: 400;
      font-size: 84px; line-height: .98; margin: 0 0 22px; letter-spacing: -.02em;
    }
    h1 em { font-style: italic; color: #c7b3ff; }
    .eyebrow {
      font-size: 20px; letter-spacing: .18em; text-transform: uppercase;
      color: #7d8ba3; margin: 0 0 20px; font-weight: 500;
      max-width: none; white-space: nowrap;
    }
    .eyebrow b { color: #38c5ff; font-weight: 500; }
    p { margin: 0; font-size: 29px; line-height: 1.42; color: #a8b6cc; max-width: 15em; }
    .rule { height: 3px; width: 92px; margin: 30px 0 0;
            background: linear-gradient(90deg, #38c5ff, #c77dff); border-radius: 2px; }
  </style>
  <img src="${dataUri(LOGO)}" alt="">
  <div>
    <p class="eyebrow">Periphery &nbsp;·&nbsp; <b>v${require(path.join(ROOT, 'package.json')).version}</b></p>
    <h1>Built to be<br><em>ignored.</em></h1>
    <p>Local-first ambient notifications for deep work. No popups, no sounds, no cloud.</p>
    <div class="rule"></div>
  </div>`;

  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      document.open();
      document.write(${JSON.stringify(html)});
      document.close();
      // Web fonts are a build-time nicety, not a requirement: if the network
      // is unavailable the card still renders in the fallback stack.
      const done = () => resolve(true);
      document.fonts.ready.then(done);
      setTimeout(done, 4000);
    })
  `);

  win.setContentSize(1200, 630);
  const shot = await win.webContents.capturePage({
    x: 0, y: 0, width: 1200, height: 630,
  });
  // JPEG, not PNG: the card is a photographic gradient, and no social crawler
  // needs its alpha channel. ~20x smaller.
  const out = path.join(ROOT, 'docs', 'assets', 'og-card.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, shot.toJPEG(90));
  console.log(`  docs/assets/og-card.jpg          1200x630  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 630, show: false });
  await win.loadURL('data:text/html,<meta charset="utf-8">');

  const render = async (source, targets) => {
    const urls = await win.webContents.executeJavaScript(
      `(${RENDER})(${JSON.stringify(dataUri(source))}, ${JSON.stringify(targets.map((t) => [t[1], t[2]]))})`,
    );
    targets.forEach(([relative, size], i) => {
      const bytes = write(relative, urls[i]);
      console.log(`  ${relative.padEnd(30)} ${String(size).padStart(4)}px  ${(bytes / 1024).toFixed(1)} KB`);
    });
  };

  console.log('app icon (build/logo.png):');
  await render(LOGO, LOGO_TARGETS);
  console.log('tray mark (ui/assets/icon.svg):');
  await render(MARK, TRAY_TARGETS);

  console.log('social card:');
  await buildSocialCard(win);

  console.log('\nNext: npx tauri icon build/icon.png -o src-tauri/icons');
  win.destroy();
  app.quit();
});
