# Sleep Tracker

A personal sleep tracker for iPhone, inspired by Sleep Cycle. It runs as a web app you add to your Home Screen.

- Records overnight with the microphone and flags sounds: snoring, talking, bangs, rustling and movement, with short clips you can play back.
- Uses the motion sensor when the phone is on the bed.
- Estimates time in deep, light and dream (REM) sleep, how many periods of each, and a quality score.
- Everything stays on the phone (IndexedDB). Nothing is uploaded.

Sleep stages are estimates from sound and movement, not a medical measurement.

## Use it
Open https://pastaglitch.github.io/sleep-tracker/ in Safari, tap Share, then **Add to Home Screen**. Open it from the Home Screen at bedtime, plug the phone in, and tap **Start sleep tracking**. Keep the app open; the screen stays on but dark.

## Code
No build step: plain HTML, CSS and ES modules.

| File | Job |
| --- | --- |
| `index.html` | App shell and tab bar |
| `js/app.js` | Screens: Tonight, recording, night details, history, settings |
| `js/recorder.js` | Microphone and motion capture, sound event detection, clips |
| `js/analysis.js` | Sleep stage estimation and snore detection (pure, testable) |
| `js/charts.js` | SVG charts |
| `js/storage.js` | IndexedDB storage, backup export and import |
| `sw.js` | Offline cache. Bump `CACHE` when files change |

Tests: `node test/analysis.test.mjs`
