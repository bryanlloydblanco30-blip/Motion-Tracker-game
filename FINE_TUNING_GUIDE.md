# 📜 Astral Cartographer — Fine-Tuning & Customization Guide

This document provides exact variable names, file locations, code snippets, and instructions for manually calibrating tracking sensitivity, gesture pinch thresholds, accuracy scoring metrics, and level progression coordinates.

---

## 🎯 1. Tracking & Pointer Fine-Tuning

All cursor movement, lerp smoothing, and deadzone variables live in `static/js/app.js`.

### Exact Variable Names & Code Block (lines ~88–95):
```javascript
const ALPHA_MIN  = 0.030;   // Minimum lerp factor (used when finger is still)
const ALPHA_MAX  = 0.55;    // Maximum lerp factor (used during fast finger movement)
const ALPHA_DIST = 130;     // Screen distance (px) to scale from ALPHA_MIN to ALPHA_MAX
const DEADZONE   = 1.2;     // Minimum movement threshold (px) to update reticle cursor
```

### How to Adjust:
* **Cursor Jitters While Pointing Still?**
  * Decrease `ALPHA_MIN` (e.g., `0.015` or `0.020`).
  * Increase `DEADZONE` (e.g., `2.0` or `2.5`).
* **Cursor Feels Heavy / Lags Behind Finger Movement?**
  * Increase `ALPHA_MAX` (e.g., `0.70` or `0.85`).
  * Decrease `ALPHA_DIST` (e.g., `90` or `100`).

---

## 🤌 2. Pinch Gesture & Sensitivity Calibration

Pinch detection calculates the 2D screen distance (`tipDx`, `tipDy`) between **Thumb Tip (`lm[4]`)** and **Index Tip (`lm[8]`)** normalized against `scale` (hand size: Wrist `lm[0]` to Index MCP `lm[5]`).

### Exact Variable Names & Code Block (in `onHandResults()`, `app.js`):
```javascript
const scale = getHandScale(lm);
const tipDx = (lm[4].x - lm[8].x) * W;
const tipDy = (lm[4].y - lm[8].y) * H;
const normPinchDist = Math.hypot(tipDx, tipDy) / scale;

// PINCH DISTANCE RATIO THRESHOLD (default: 0.28 = 28% of hand size)
const rawPinch = normPinchDist < 0.28 && isPointing && trackingOn;

// CONSECUTIVE FRAME BUFFER
const isPinching = pinchFrameCount >= 2;

// DEBOUNCE TIMER (in milliseconds)
if (now - pinchPlacedAt > 650) { ... }
```

### MediaPipe Confidence Variables (in `initMediaPipe()`, `app.js`):
```javascript
minDetectionConfidence: 0.60, // Sensitivity for discovering a hand (0.0 to 1.0)
minTrackingConfidence:  0.55, // Sensitivity for maintaining landmark tracking (0.0 to 1.0)
```

### How to Adjust:
* **Still Triggering Pinches Accidentally?**
  * Decrease `normPinchDist < 0.28` to `0.20` or `0.22` (requires thumb & index to touch closer).
  * Increase `pinchFrameCount >= 2` to `3` or `4` (requires holding pinch longer).
* **Pinch Hard to Trigger / Not Placing Stars Easily?**
  * Increase `normPinchDist < 0.28` to `0.32` or `0.35`.
  * Decrease `pinchFrameCount >= 2` to `1`.

---

## 📊 3. Accuracy Scoring & Match Radius Tuning

Accuracy scores placed stars against guide target coordinates.

### Exact Variable Names & Code Block (in `calcAccuracy()`, `app.js`):
```javascript
const MATCH_RADIUS = 75;    // Target hitbox radius (in pixels) around guide stars
```

### Proximity Scoring Exponent Formula:
$$\text{Proximity Score} = \left(1 - \frac{\text{Distance}}{\text{MATCH\_RADIUS}}\right)^{0.65}$$

```javascript
// Grade Breakdown Boundaries (calcAccuracy(), app.js)
const pct = Math.round((totalScore / guidePts.length) * 100);
const grade =
  pct >= 88 ? 'S' :
  pct >= 72 ? 'A' :
  pct >= 52 ? 'B' :
  pct >= 32 ? 'C' : 'D';

// Minimum passing percentage to unlock next level (updateAccuracyPanel(), app.js)
if (result.matched >= result.total && result.pct >= 50) {
  // Unlocks next level
}
```

### How to Adjust:
* **Make Scoring Stricter:**
  * Lower `MATCH_RADIUS` to `45` or `50` pixels.
  * Increase minimum pass threshold from `pct >= 50` to `pct >= 70`.
* **Make Scoring More Forgiving:**
  * Increase `MATCH_RADIUS` to `90` or `100` pixels.

---

## 🌌 4. Campaign Levels & Constellation Coordinates

Level definitions, order, names, and guide target points live in `app.py`.

### Exact Variable Name & Data Structure (`app.py`):
```python
LEVELS = [
    {"level": 1,  "name": "Aries",       "symbol": "♈", "pts": [[0.30, 0.55], [0.38, 0.42], [0.47, 0.38], [0.58, 0.44], [0.66, 0.40]]},
    {"level": 2,  "name": "Taurus",      "symbol": "♉", "pts": [[0.28, 0.30], [0.35, 0.42], [0.44, 0.50], [0.40, 0.60], [0.50, 0.62], [0.58, 0.55], [0.62, 0.42]]},
    {"level": 3,  "name": "Gemini",      "symbol": "♊", "pts": [[0.30, 0.30], [0.32, 0.55], [0.34, 0.72], [0.66, 0.28], [0.64, 0.53], [0.62, 0.70]]},
    # ... Levels 4 to 12
]
```

### How to Move Points or Shift Constellations:
1. Open `app.py`.
2. Locate the level entry in `LEVELS`.
3. Coordinates `[X, Y]` are normalized $0.0 \dots 1.0$:
   - Modify first coordinate ($X$) to shift **left/right**.
   - Modify second coordinate ($Y$) to shift **up/down**.

---

## 🛠️ Complete Variable Cheat Sheet

| Feature / Setting | Variable Name | File Path | Default | Recommended Range |
|---|---|---|---|---|
| Min Lerp Smooth | `ALPHA_MIN` | `static/js/app.js` | `0.030` | `0.015` – `0.050` |
| Max Lerp Speed | `ALPHA_MAX` | `static/js/app.js` | `0.55` | `0.40` – `0.85` |
| Micro-jitter Deadzone | `DEADZONE` | `static/js/app.js` | `1.2` (px) | `0.8` – `3.0` |
| Pinch Sensitivity Ratio | `normPinchDist` | `static/js/app.js` | `0.28` | `0.20` – `0.35` |
| Pinch Frame Buffer | `pinchFrameCount` | `static/js/app.js` | `2` (frames) | `1` – `4` |
| Pinch Debounce Time | `pinchPlacedAt` check | `static/js/app.js` | `650` (ms) | `400` – `1000` |
| Detection Confidence | `minDetectionConfidence` | `static/js/app.js` | `0.60` | `0.50` – `0.80` |
| Tracking Confidence | `minTrackingConfidence` | `static/js/app.js` | `0.55` | `0.50` – `0.75` |
| Hitbox Match Radius | `MATCH_RADIUS` | `static/js/app.js` | `75` (px) | `40` – `110` |
| Pass Level Threshold | `result.pct >= 50` | `static/js/app.js` | `50%` | `40%` – `75%` |
| Campaign Levels | `LEVELS` | `app.py` | Array of 12 | Add/modify entries |
