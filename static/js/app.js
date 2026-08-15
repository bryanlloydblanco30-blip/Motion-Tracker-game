/* ============================================================
   app.js  -  Astral Cartographer  |  Hand-tracking frontend
   ============================================================

   GESTURES (Track must be ON):
     Pointing  - index finger up, others curled -> moves cursor
     Pinch     - thumb tip meets index tip       -> places star
     Tap       - click/touch canvas              -> always works

   FUNCTIONS
   ---------
   resize()              fit canvas to viewport (DPR-aware)
   loadGuides()          fetch zodiac data from /api/guides
   buildZodiacBar()      populate 12-sign picker buttons
   startCamera()         getUserMedia -> play -> MediaPipe -> loop
   initMediaPipe()       load Hands model + start 20 fps send loop
   lmDist(a,b)           3D Euclidean distance between landmarks
   isExtended(lm,t,p)    tip(t) further from wrist than pip(p)?
   onHandResults(r)      MediaPipe callback: pointing + pinch logic
   calcAccuracy()        score placed stars against active guide
   updateAccuracyPanel() push accuracy data into DOM
   twinkle(t,ph)         sinusoidal alpha pulse
   drawStar(x,y,r,a,c)   radial glow + solid core
   drawGuide(t)          zodiac guide overlay with pulsing targets
   drawConstellation(t)  user stars + thick glowing lines
   drawReticle(t)        3-state cursor + pinch burst
   placePoint(x,y)       add star + refresh accuracy
   toast(msg)            transient notification banner
   loop(t)               requestAnimationFrame render loop
   ============================================================ */

(function () {

  /* ── DOM ────────────────────────────────────────────────── */
  const video = document.getElementById('cam');
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');
  const intro = document.getElementById('intro');
  const startBtn = document.getElementById('startBtn');
  const camError = document.getElementById('camError');
  const toastEl = document.getElementById('toast');
  const rdAlt = document.getElementById('rdAlt');
  const rdAz = document.getElementById('rdAz');
  const rdCount = document.getElementById('rdCount');
  const rdTimerEl = document.getElementById('rdTimer');
  const zLabel = document.getElementById('zLabel');
  const zbar = document.getElementById('zodiacBar');
  const accPanel = document.getElementById('accuracyPanel');
  const accPctEl = document.getElementById('accPct');
  const accGradeEl = document.getElementById('accGrade');
  const accBarEl = document.getElementById('accBar');
  const accMatchEl = document.getElementById('accMatched');
  const accTotEl = document.getElementById('accTotal');
  const accPosScoreEl = document.getElementById('accPosScore');
  const accShapeScoreEl = document.getElementById('accShapeScore');

  const playerNameInput = document.getElementById('playerNameInput');
  const leaderboardModal = document.getElementById('leaderboardModal');
  const leaderboardBody = document.getElementById('leaderboardBody');
  const btnLeaderboard = document.getElementById('btnLeaderboard');
  const closeLeaderboardBtn = document.getElementById('closeLeaderboardBtn');

  /* Level Completion Modal elements */
  const levelCompleteModal = document.getElementById('levelCompleteModal');
  const modalLevelTitle = document.getElementById('modalLevelTitle');
  const modalLevelSub = document.getElementById('modalLevelSub');
  const modalGrade = document.getElementById('modalGrade');
  const modalPct = document.getElementById('modalPct');
  const modalPosScore = document.getElementById('modalPosScore');
  const modalShapeScore = document.getElementById('modalShapeScore');
  const modalMatchedStars = document.getElementById('modalMatchedStars');
  const btnNextLevel = document.getElementById('btnNextLevel');
  const btnRetryLevel = document.getElementById('btnRetryLevel');

  let W = 0, H = 0;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  /* ── resize ─────────────────────────────────────────────── */
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ── App state ──────────────────────────────────────────── */
  let points = [];
  let trackingOn = false;
  let guideKey = null;
  let GUIDES = {};
  let playerName = 'Stargazer';

  /* ── Hand-tracking state ────────────────────────────────── */
  let handVisible = false;
  let isPointing = false;
  let wasPinching = false;
  let pinchPlacedAt = 0;
  let pinchAnim = 0;      // burst animation 0..1

  /* Smoothed finger-tip position */
  let reticleX = 0, reticleY = 0;
  let smoothX = 0, smoothY = 0;

  /* Adaptive smoothing constants (fine-tuned) */
  const ALPHA_MIN = 0.030;   // resting jitter suppression
  const ALPHA_MAX = 0.55;    // fast-movement responsiveness
  const ALPHA_DIST = 130;     // px where alpha reaches max
  const DEADZONE = 1.2;     // px - ignore micro-jitter below this
  const PINCH_THR = 0.055;   // normalised distance for pinch detection
  const MATCH_RADIUS = 75;    // px - guide star "hit" zone for scoring

  /* ── toast ──────────────────────────────────────────────── */
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
  }

  /* ── Player Unlocked Levels & Reset Logic ──────────────── */
  function getPlayerStorageKey(name) {
    return 'astral_unlocked_level_' + (name || 'Stargazer').trim().toLowerCase();
  }

  function getUnlockedLevelForPlayer(name) {
    const val = localStorage.getItem(getPlayerStorageKey(name));
    return val ? Math.max(1, parseInt(val, 10) || 1) : 1;
  }

  function saveUnlockedLevelForPlayer(name, lvl) {
    localStorage.setItem(getPlayerStorageKey(name), lvl);
  }

  let maxUnlockedLevel = 1;
  let LEVELS = [];
  let currentLevelObj = null;

  /* ── loadGuides ─────────────────────────────────────────── */
  async function loadGuides() {
    try {
      const res = await fetch('/api/guides');
      LEVELS = await res.json();
    } catch (e) {
      console.warn('Guide load failed:', e);
    }
    maxUnlockedLevel = getUnlockedLevelForPlayer(playerName);
    buildZodiacBar();
  }

  /* ── buildZodiacBar ─────────────────────────────────────── */
  function buildZodiacBar() {
    zbar.innerHTML = '';
    LEVELS.forEach(lvl => {
      const isLocked = lvl.level > maxUnlockedLevel;
      const b = document.createElement('button');
      b.className = 'zbtn' + (isLocked ? ' locked' : '');
      b.textContent = lvl.symbol;
      b.dataset.level = lvl.level;
      b.title = isLocked ? `Level ${lvl.level}: Locked (Clear Level ${lvl.level - 1} first)` : `Level ${lvl.level}: ${lvl.name}`;

      b.addEventListener('click', () => {
        if (lvl.level > maxUnlockedLevel) {
          toast(`🔒 Clear Level ${lvl.level - 1} to unlock ${lvl.name}`);
          return;
        }

        if (currentLevelObj && currentLevelObj.level === lvl.level) {
          currentLevelObj = null;
          guideKey = null;
          zLabel.textContent = '\u00a0';
          b.classList.remove('active');
          points = []; // Auto-clear canvas points when toggled off
          rdCount.textContent = 0;
          updateAccuracyPanel();
          return;
        }

        selectLevel(lvl);
      });

      zbar.appendChild(b);
    });

    // Auto-select Level 1 if none active
    if (!currentLevelObj && LEVELS.length > 0) {
      selectLevel(LEVELS[0]);
    }
  }

  const timerBadgeEl = document.getElementById('timerBadge');
  const countdownOverlay = document.getElementById('countdownOverlay');
  const countdownNumEl = document.getElementById('countdownNum');
  const countdownTextEl = document.getElementById('countdownText');

  /* ── 3-2-1-GO Countdown ──────────────────────────────────── */
  let countdownTimeoutIds = [];

  function clearCountdown() {
    countdownTimeoutIds.forEach(id => clearTimeout(id));
    countdownTimeoutIds = [];
    if (countdownOverlay) countdownOverlay.classList.remove('show', 'go-flash');
  }

  function runCountdown(onDone) {
    clearCountdown();
    if (!countdownOverlay || !countdownNumEl || !countdownTextEl) {
      onDone && onDone();
      return;
    }

    const steps = [
      { num: '3', text: 'GET READY',  delay: 0 },
      { num: '2', text: 'GET READY',  delay: 1000 },
      { num: '1', text: 'GET READY',  delay: 2000 },
      { num: 'GO!', text: 'BEGIN CHARTING', delay: 3000, go: true },
    ];

    countdownOverlay.classList.add('show');
    countdownOverlay.classList.remove('go-flash');
    countdownOverlay.style.pointerEvents = 'all'; // block clicks during countdown

    steps.forEach(({ num, text, delay, go }) => {
      const tid = setTimeout(() => {
        // Re-trigger CSS animation by cloning the element trick
        countdownNumEl.textContent = num;
        countdownTextEl.textContent = text;

        // Force re-animation
        countdownNumEl.style.animation = 'none';
        void countdownNumEl.offsetHeight; // reflow
        countdownNumEl.style.animation = '';

        if (go) {
          countdownOverlay.classList.add('go-flash');
        } else {
          countdownOverlay.classList.remove('go-flash');
        }
      }, delay);
      countdownTimeoutIds.push(tid);
    });

    // Dismiss after GO and start the level
    const doneId = setTimeout(() => {
      countdownOverlay.classList.remove('show', 'go-flash');
      countdownOverlay.style.pointerEvents = 'none';
      onDone && onDone();
    }, 3900);
    countdownTimeoutIds.push(doneId);
  }

  /* ── 1-Minute Level Countdown Timer ───────────────────────── */
  let timerInterval = null;
  let levelTimeLeft = 60;

  function stopLevelTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerBadgeEl) timerBadgeEl.classList.remove('timer-warning');
  }

  function startLevelTimer() {
    stopLevelTimer();
    levelTimeLeft = 60;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
      levelTimeLeft--;
      updateTimerDisplay();

      if (levelTimeLeft <= 0) {
        stopLevelTimer();
        onTimerExpired();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    if (!rdTimerEl) return;
    const mins = Math.floor(Math.max(0, levelTimeLeft) / 60);
    const secs = Math.max(0, levelTimeLeft) % 60;
    rdTimerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (timerBadgeEl) {
      if (levelTimeLeft <= 10 && levelTimeLeft > 0) {
        timerBadgeEl.classList.add('timer-warning');
      } else {
        timerBadgeEl.classList.remove('timer-warning');
      }
    }
  }

  function onTimerExpired() {
    const result = calcAccuracy();
    const isPassed = result && result.matched >= result.total && result.pct >= 50;

    toast(isPassed ? "🎉 Stage Concluded — Level Passed!" : "⏰ Time Expired — Stage Concluded");

    if (levelCompleteModal) {
      modalLevelTitle.textContent = isPassed 
        ? `STAGE CONCLUDED — LEVEL CLEARED!` 
        : `TIME EXPIRED — STAGE CONCLUDED`;
      modalLevelSub.textContent = `User constellation shape input evaluated against target guide`;
      
      const resPct = result ? result.pct : 0;
      const resGrade = result ? result.grade : 'D';
      
      modalGrade.textContent = resGrade;
      modalGrade.className = 'modal-grade grade-' + resGrade;
      modalPct.textContent = resPct;
      modalPosScore.textContent = (result ? result.positionScore : 0) + '%';
      modalShapeScore.textContent = (result ? result.shapeScore : 0) + '%';
      modalMatchedStars.textContent = `${result ? result.matched : 0} / ${result ? result.total : (currentLevelObj ? currentLevelObj.pts.length : 0)}`;
      
      if (isPassed) {
        btnNextLevel.style.display = 'inline-block';
        if (currentLevelObj && currentLevelObj.level < LEVELS.length) {
          btnNextLevel.textContent = `Next Level (Lvl ${currentLevelObj.level + 1}) →`;
        } else {
          btnNextLevel.textContent = `Campaign Completed! 🏆`;
        }
      } else {
        btnNextLevel.style.display = 'none';
        if (btnRetryLevel) {
          btnRetryLevel.textContent = `Run Out of Time — Retry Stage`;
        }
      }
      
      levelCompleteModal.classList.add('show');
    }
  }

  /* ── selectLevel (auto-clears canvas points on transition & restarts 1-min timer after countdown) ─ */
  function selectLevel(lvl) {
    points = []; // Auto-clear canvas points for new level
    rdCount.textContent = 0;
    completedModalTriggeredForLevel = null;

    [...zbar.children].forEach(c => c.classList.remove('active'));
    currentLevelObj = lvl;
    guideKey = lvl.name;

    const activeBtn = [...zbar.children].find(c => parseInt(c.dataset.level, 10) === lvl.level);
    if (activeBtn) activeBtn.classList.add('active');

    zLabel.textContent = `LEVEL ${lvl.level}: ${lvl.name.toUpperCase()}`;
    updateAccuracyPanel();
    stopLevelTimer();
    toast(`✨ Level ${lvl.level}: ${lvl.name} active`);

    // Run 3-2-1-GO countdown, then start timer
    runCountdown(() => {
      startLevelTimer();
    });
  }

  /* ================================================================
   * ACCURACY ENGINE & LEVEL PROGRESSION
   * ================================================================ */

  function calcAccuracy() {
    if (!currentLevelObj || points.length === 0) return null;

    const guidePts = currentLevelObj.pts;
    let guideScoresSum = 0;
    let matched = 0;

    guidePts.forEach(([nx, ny], idx) => {
      const gx = nx * W, gy = ny * H;
      
      if (idx < points.length) {
        const p = points[idx];
        const dist = Math.hypot(p.x - gx, p.y - gy);

        if (dist <= MATCH_RADIUS) {
          matched++;
          const effectiveDist = Math.max(0, dist - 10);
          const proximity = Math.max(0, 1 - (effectiveDist / (MATCH_RADIUS - 10)));
          guideScoresSum += proximity;
        } else {
          let minDist = Infinity;
          points.forEach(tp => {
            const d = Math.hypot(tp.x - gx, tp.y - gy);
            if (d < minDist) minDist = d;
          });
          if (minDist <= MATCH_RADIUS) {
            matched++;
            guideScoresSum += Math.max(0, 1 - (minDist / MATCH_RADIUS)) * 0.7;
          }
        }
      }
    });

    const positionScore = (guideScoresSum / guidePts.length) * 100;

    let shapeScoreSum = 0;
    const numSegments = Math.max(1, guidePts.length - 1);

    if (guidePts.length > 1 && points.length > 1) {
      for (let i = 0; i < Math.min(guidePts.length - 1, points.length - 1); i++) {
        const g1 = guidePts[i], g2 = guidePts[i + 1];
        const p1 = points[i], p2 = points[i + 1];

        const gdx = (g2[0] - g1[0]) * W, gdy = (g2[1] - g1[1]) * H;
        const pdx = p2.x - p1.x, pdy = p2.y - p1.y;

        const glen = Math.hypot(gdx, gdy);
        const plen = Math.hypot(pdx, pdy);

        if (glen > 0.001 && plen > 0.001) {
          const dot = gdx * pdx + gdy * pdy;
          const cosSim = Math.max(0, dot / (glen * plen));
          const lenRatio = Math.min(glen, plen) / Math.max(glen, plen);

          const sim = (cosSim * 0.7) + (lenRatio * 0.3);
          shapeScoreSum += sim * 100;
        } else {
          shapeScoreSum += 100;
        }
      }
      var shapeScore = shapeScoreSum / numSegments;
    } else {
      var shapeScore = positionScore;
    }

    const rawCombined = (positionScore * 0.55) + (shapeScore * 0.45);
    const allMatched = matched >= guidePts.length;
    // Only penalise extra stars when NOT all nodes are hit yet; penalty is soft (7.5 pts each)
    const extraPointsCount = allMatched ? 0 : Math.max(0, points.length - guidePts.length);
    const penalty = extraPointsCount * 7.5;

    const pct = Math.max(0, Math.min(100, Math.round(rawCombined - penalty)));
    const grade =
      pct >= 88 ? 'S' :
        pct >= 72 ? 'A' :
          pct >= 52 ? 'B' :
            pct >= 32 ? 'C' : 'D';

    return {
      pct,
      grade,
      matched,
      allMatched,
      total: guidePts.length,
      positionScore: Math.round(positionScore),
      shapeScore: Math.round(shapeScore)
    };
  }

  let completedModalTriggeredForLevel = null;

  function showCompletionModal(result) {
    if (!currentLevelObj || !levelCompleteModal) return;

    modalLevelTitle.textContent = `LEVEL ${currentLevelObj.level}: ${currentLevelObj.name.toUpperCase()} CLEARED!`;
    modalLevelSub.textContent = `Traced constellation shape compared against target guide`;
    modalGrade.textContent = result.grade;
    modalGrade.className = 'modal-grade grade-' + result.grade;
    modalPct.textContent = result.pct;
    modalPosScore.textContent = result.positionScore + '%';
    modalShapeScore.textContent = result.shapeScore + '%';
    modalMatchedStars.textContent = `${result.matched} / ${result.total}`;

    if (currentLevelObj.level < LEVELS.length) {
      btnNextLevel.style.display = 'inline-block';
      btnNextLevel.textContent = `Next Level (Lvl ${currentLevelObj.level + 1}) →`;
    } else {
      btnNextLevel.style.display = 'inline-block';
      btnNextLevel.textContent = `Campaign Completed! 🏆`;
    }

    stopLevelTimer();
    levelCompleteModal.classList.add('show');
  }

  function updateAccuracyPanel() {
    const result = calcAccuracy();

    if (!result || !currentLevelObj) {
      accPanel.classList.remove('visible');
      return;
    }

    accPanel.classList.add('visible');
    accPctEl.textContent = result.pct;
    accMatchEl.textContent = result.matched;
    accTotEl.textContent = result.total;
    if (accPosScoreEl) accPosScoreEl.textContent = result.positionScore + '%';
    if (accShapeScoreEl) accShapeScoreEl.textContent = result.shapeScore + '%';
    accBarEl.style.width = result.pct + '%';

    /* Grade badge */
    accGradeEl.textContent = result.grade;
    accGradeEl.className = 'acc-grade grade-' + result.grade;

    /* Level progression: Clear level if ALL guide nodes are hit (extra stars are OK) */
    if (result.allMatched) {
      if (currentLevelObj.level === maxUnlockedLevel && maxUnlockedLevel < LEVELS.length) {
        maxUnlockedLevel++;
        saveUnlockedLevelForPlayer(playerName, maxUnlockedLevel);
        buildZodiacBar();
      }

      submitLeaderboardScore(currentLevelObj.level, currentLevelObj.name, result.pct, result.grade);

      // Trigger Completion Pop-Up Modal once per level completion
      if (completedModalTriggeredForLevel !== currentLevelObj.level) {
        completedModalTriggeredForLevel = currentLevelObj.level;
        showCompletionModal(result);
      }
    }
  }

  /* Next Level and Retry Level Modal Buttons */
  if (btnNextLevel) {
    btnNextLevel.addEventListener('click', () => {
      if (levelCompleteModal) levelCompleteModal.classList.remove('show');

      if (currentLevelObj && currentLevelObj.level < LEVELS.length) {
        const nextLvlNum = currentLevelObj.level + 1;
        const nextLvlObj = LEVELS.find(l => l.level === nextLvlNum);
        if (nextLvlObj) {
          selectLevel(nextLvlObj);
        }
      } else {
        points = [];
        rdCount.textContent = 0;
        toast("🏆 You cleared all 12 Zodiac constellations!");
      }
    });
  }

  if (btnRetryLevel) {
    btnRetryLevel.addEventListener('click', () => {
      if (levelCompleteModal) levelCompleteModal.classList.remove('show');
      points = [];
      rdCount.textContent = 0;
      completedModalTriggeredForLevel = null;
      updateAccuracyPanel();
      stopLevelTimer();
      toast("Canvas cleared — try again!");
      // Run countdown then restart timer
      runCountdown(() => {
        startLevelTimer();
      });
    });
  }

  /* ── Leaderboard API ─────────────────────────────────────── */
  const submittedLevels = {};
  async function submitLeaderboardScore(level, guideName, pct, grade) {
    if (submittedLevels[level] && submittedLevels[level] >= pct) return;
    submittedLevels[level] = pct;

    try {
      await fetch('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: playerName,
          level: level,
          guide_name: guideName,
          pct: pct,
          grade: grade
        })
      });
      toast(`★ Score saved for Level ${level}!`);
    } catch (e) {
      console.warn('Leaderboard post failed:', e);
    }
  }

  async function openLeaderboard() {
    leaderboardBody.innerHTML = '<tr><td colspan="4" style="text-align:center">Loading ranks...</td></tr>';
    leaderboardModal.classList.add('show');
    try {
      const res = await fetch('/api/leaderboard');
      const rows = await res.json();
      if (!rows.length) {
        leaderboardBody.innerHTML = '<tr><td colspan="4" style="text-align:center">No records yet! Be the first.</td></tr>';
        return;
      }
      leaderboardBody.innerHTML = rows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><b>${r.player}</b></td>
          <td>Lvl 1–${r.max_level} (${r.levels_cleared} cleared)</td>
          <td><b style="color:var(--gold-bright);font-size:13px">${r.total_score} pts</b></td>
        </tr>
      `).join('');
    } catch (e) {
      leaderboardBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#e7a5a5">Failed to load ranks</td></tr>';
    }
  }

  btnLeaderboard.addEventListener('click', openLeaderboard);
  closeLeaderboardBtn.addEventListener('click', () => leaderboardModal.classList.remove('show'));

  /* ================================================================
   * MEDIAPIPE HANDS
   * ================================================================ */

  /* lmDist - 3D Euclidean distance between two landmarks */
  function lmDist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* isExtended - relaxed finger extension check */
  function isExtended(lm, tipIdx, mcpIdx) {
    // Tip distance from wrist vs MCP distance from wrist (1.02x threshold for easy detection)
    return lmDist(lm[tipIdx], lm[0]) > lmDist(lm[mcpIdx], lm[0]) * 1.02;
  }

  /* Hand scale reference: 2D distance between Wrist (0) and Index MCP (5) */
  function getHandScale(lm) {
    const dx = (lm[5].x - lm[0].x) * W;
    const dy = (lm[5].y - lm[0].y) * H;
    return Math.hypot(dx, dy) || 100;
  }

  let pinchFrameCount = 0; // Number of consecutive frames detecting pinch

  /* onHandResults - MediaPipe Hands callback */
  function onHandResults(results) {
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
      handVisible = false;
      isPointing = false;
      pinchFrameCount = 0;
      return;
    }

    handVisible = true;
    const lm = results.multiHandLandmarks[0];

    /* ---- Pointing gesture: index extended (much more forgiving) ---- */
    const indexExt = isExtended(lm, 8, 5);  // Index tip (8) extended beyond Index MCP (5)
    const middleExt = isExtended(lm, 12, 9); // Middle tip (12) extended beyond Middle MCP (9)

    // Simply require Index to be extended further than Middle finger
    isPointing = indexExt && (lmDist(lm[8], lm[0]) > lmDist(lm[12], lm[0]));

    if (isPointing && trackingOn) {
      /* Index tip pos - flip X for mirrored video */
      const rawX = (1.0 - lm[8].x) * W;
      const rawY = lm[8].y * H;

      /* Adaptive smoothing: slow at rest, quick during movement */
      const dist = Math.hypot(rawX - smoothX, rawY - smoothY);
      const alpha = Math.min(ALPHA_MAX, ALPHA_MIN + dist / ALPHA_DIST);
      smoothX += (rawX - smoothX) * alpha;
      smoothY += (rawY - smoothY) * alpha;

      /* Dead-zone: suppress micro-jitter below threshold */
      if (Math.hypot(smoothX - reticleX, smoothY - reticleY) > DEADZONE) {
        reticleX = smoothX;
        reticleY = smoothY;
      }

      /* Coordinate readout */
      rdAz.textContent = ((reticleX / W) * 360).toFixed(1) + '\u00b0';
      rdAlt.textContent = (90 - (reticleY / H) * 90).toFixed(1) + '\u00b0';
    }

    /* ---- Fine-tuned Pinch Detection ---- */
    const scale = getHandScale(lm);
    const tipDx = (lm[4].x - lm[8].x) * W;
    const tipDy = (lm[4].y - lm[8].y) * H;
    const normPinchDist = Math.hypot(tipDx, tipDy) / scale;

    /* Pinch threshold set to 0.28 (~28% of hand size) for easy triggers when fingers meet */
    const rawPinch = normPinchDist < 0.20 && isPointing && trackingOn;

    if (rawPinch) {
      pinchFrameCount++;
    } else {
      pinchFrameCount = 0;
    }

    // Require 2 frames of pinch confirmation
    const isPinching = pinchFrameCount >= 2;

    if (isPinching && !wasPinching) {
      const now = performance.now();
      if (now - pinchPlacedAt > 650) {   // 650 ms debounce
        placePoint(reticleX, reticleY);
        pinchPlacedAt = now;
        pinchAnim = 1.0;
        toast('\u2605 Star placed');
      }
    }
    wasPinching = isPinching;
  }

  /* initMediaPipe - load model + start frame processing loop */
  function initMediaPipe() {
    const hands = new Hands({
      locateFile: f =>
        'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/' + f,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.60, // Lower confidence threshold so hands are detected instantly
      minTrackingConfidence: 0.55,
    });
    hands.onResults(onHandResults);

    let busy = false;
    setInterval(async () => {
      if (video.readyState < 2 || busy || !trackingOn) return;
      busy = true;
      try { await hands.send({ image: video }); }
      finally { busy = false; }
    }, 50);   // ~20 fps
  }

  /* ── startCamera ────────────────────────────────────────── */
  async function startCamera() {
    const val = (playerNameInput.value || '').trim();
    if (val) playerName = val;
    maxUnlockedLevel = getUnlockedLevelForPlayer(playerName);
    buildZodiacBar();
    points = [];
    if (rdCount) rdCount.textContent = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();

      reticleX = smoothX = W / 2;
      reticleY = smoothY = H / 2;

      initMediaPipe();

      intro.classList.add('hide');
      setTimeout(() => (intro.style.display = 'none'), 550);
      requestAnimationFrame(loop);
    } catch (e) {
      camError.style.display = 'block';
    }
  }
  startBtn.addEventListener('click', startCamera);

  /* ================================================================
   * DRAWING
   * ================================================================ */

  /* twinkle */
  function twinkle(t, phase) {
    return 0.55 + 0.45 * Math.sin(t * 0.003 + phase);
  }

  /* drawStar - multi-layered radial glow */
  function drawStar(x, y, r, alpha, color) {
    ctx.save();
    ctx.globalAlpha = alpha;

    /* Outer soft halo */
    const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
    halo.addColorStop(0, color);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(x, y, r * 6, 0, Math.PI * 2); ctx.fill();

    /* Inner bright core */
    const core = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.5, '#fffdf5');
    core.addColorStop(1, 'rgba(255,253,245,0)');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  /* drawGuide - vivid zodiac constellation overlay */
  function drawGuide(t) {
    if (!currentLevelObj) return;
    const g = currentLevelObj;

    ctx.save();

    /* Wide ambient glow path */
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = 'rgba(240,207,138,1)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(240,207,138,0.5)';
    ctx.shadowBlur = 18;
    ctx.setLineDash([4, 12]);
    ctx.beginPath();
    g.pts.forEach(([nx, ny], i) => {
      if (i === 0) ctx.moveTo(nx * W, ny * H); else ctx.lineTo(nx * W, ny * H);
    });
    ctx.stroke();

    /* Crisp dashed connecting path */
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(240,207,138,0.85)';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    g.pts.forEach(([nx, ny], i) => {
      if (i === 0) ctx.moveTo(nx * W, ny * H); else ctx.lineTo(nx * W, ny * H);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    /* Target circles - pulse to guide the player */
    g.pts.forEach(([nx, ny], i) => {
      const gx = nx * W, gy = ny * H;

      /* Check if a placed star is near this guide point */
      let nearest = Infinity;
      points.forEach(p => {
        const d = Math.hypot(p.x - gx, p.y - gy);
        if (d < nearest) nearest = d;
      });
      const hit = nearest < MATCH_RADIUS;

      const pulse = 0.5 + 0.5 * Math.sin(t * 0.004 + i * 0.9);

      if (hit) {
        /* Already hit: bright solid gold disc */
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = 'rgba(240,207,138,0.55)';
        ctx.strokeStyle = '#f0cf8a';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = 'rgba(240,207,138,0.9)';
        ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.arc(gx, gy, 13, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        /* Inner bright core */
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff8e7';
        ctx.beginPath(); ctx.arc(gx, gy, 5, 0, Math.PI * 2); ctx.fill();
      } else {
        /* Not yet hit: vivid pulsing ring */
        ctx.globalAlpha = 0.55 + 0.35 * pulse;
        ctx.strokeStyle = '#f0cf8a';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(240,207,138,0.7)';
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(gx, gy, 10 + pulse * 3, 0, Math.PI * 2); ctx.stroke();

        /* Inner pulsing ring */
        ctx.globalAlpha = 0.4 + 0.3 * pulse;
        ctx.lineWidth = 1;
        ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(gx, gy, 5, 0, Math.PI * 2); ctx.stroke();

        /* Bright dot centre */
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#f5efe0';
        ctx.beginPath(); ctx.arc(gx, gy, 3.5, 0, Math.PI * 2); ctx.fill();
      }

      /* Node number label */
      ctx.globalAlpha = hit ? 0.9 : 0.6 + 0.3 * pulse;
      ctx.fillStyle = hit ? '#f0cf8a' : 'rgba(245,239,224,0.85)';
      ctx.font = `bold 9px "Space Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.shadowBlur = 0;
      ctx.fillText(i + 1, gx, gy - 20);

      ctx.shadowBlur = 0;
    });

    ctx.restore();
  }

  /* drawConstellation - thick glowing lines + bright star dots */
  function drawConstellation(t) {
    if (points.length === 0) return;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    /* --- Outermost soft ambient halo --- */
    ctx.lineWidth = 22;
    ctx.strokeStyle = 'rgba(240,207,138,0.06)';
    ctx.shadowColor = 'rgba(240,207,138,0)';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();

    /* --- Mid glow pass --- */
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(240,207,138,0.18)';
    ctx.shadowColor = 'rgba(240,207,138,0.4)';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();

    /* --- Main bright line --- */
    ctx.lineWidth = 5.5;
    ctx.strokeStyle = 'rgba(240,207,138,0.95)';
    ctx.shadowColor = 'rgba(240,207,138,0.9)';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();

    /* --- Bright white core hairline --- */
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = 'rgba(255,255,245,0.80)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();

    ctx.restore();

    /* --- Stars at each point --- */
    points.forEach((p, i) => {
      const a = twinkle(t, p.tw);
      const last = i === points.length - 1;
      const r = last ? 7.5 : 5.5;
      drawStar(p.x, p.y, r, 0.88 + 0.12 * a, 'rgba(245,239,224,0.98)');

      /* Index label */
      ctx.save();
      ctx.font = 'bold 9px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(240,207,138,0.90)';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(i + 1, p.x, p.y - r * 5 - 4);
      ctx.restore();
    });
  }

  /* drawReticle - 3-state cursor: pointing | hand | none
   *
   *  State 1 (pointing + hand) : crosshair + outer pulsing ring + pinch burst
   *  State 2 (hand, not pointing) : dashed ring + 'POINT TO AIM' hint
   *  State 3 (no hand)             : faint ghost ring
   */
  function drawReticle(t) {
    if (!trackingOn) return;

    const pulse = 0.6 + 0.4 * Math.sin(t * 0.006);
    const rx = reticleX, ry = reticleY;

    /* Check if reticle is near a guide star (proximity highlight) */
    let nearGuide = false;
    if (currentLevelObj) {
      currentLevelObj.pts.forEach(([nx, ny]) => {
        if (Math.hypot(nx * W - rx, ny * H - ry) < MATCH_RADIUS) nearGuide = true;
      });
    }

    ctx.save();

    if (isPointing && handVisible) {
      /* ---- ACTIVE ---- */
      const ringColor = nearGuide
        ? `rgba(138,239,184,${0.7 + 0.3 * pulse})`   // green: near a target
        : `rgba(168,71,143,${0.65 + 0.30 * pulse})`;  // magenta: normal

      /* Outer ring */
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2.0;
      ctx.shadowColor = nearGuide ? 'rgba(138,239,184,0.6)' : 'rgba(168,71,143,0.6)';
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(rx, ry, 22 + pulse * 5, 0, Math.PI * 2); ctx.stroke();

      /* Inner ring */
      ctx.strokeStyle = 'rgba(240,207,138,0.55)';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(rx, ry, 9, 0, Math.PI * 2); ctx.stroke();

      /* Center dot */
      ctx.fillStyle = 'rgba(240,207,138,0.95)';
      ctx.shadowColor = 'rgba(240,207,138,0.8)';
      ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fill();

      /* Crosshair arms */
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(240,207,138,0.38)';
      ctx.lineWidth = 1;
      const arm = 34, gap = 12;
      ctx.beginPath();
      ctx.moveTo(rx - arm, ry); ctx.lineTo(rx - gap, ry);
      ctx.moveTo(rx + gap, ry); ctx.lineTo(rx + arm, ry);
      ctx.moveTo(rx, ry - arm); ctx.lineTo(rx, ry - gap);
      ctx.moveTo(rx, ry + gap); ctx.lineTo(rx, ry + arm);
      ctx.stroke();

      /* ON-TARGET indicator */
      if (nearGuide) {
        ctx.globalAlpha = 0.6 + 0.4 * pulse;
        ctx.fillStyle = 'rgba(138,239,184,0.85)';
        ctx.font = '8px "Space Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('ON TARGET', rx, ry - 36);
        ctx.globalAlpha = 1;
      }

      /* Pinch burst animation */
      if (pinchAnim > 0) {
        const burstR = (1 - pinchAnim) * 65;
        ctx.globalAlpha = pinchAnim * 0.88;
        ctx.strokeStyle = 'rgba(240,207,138,1)';
        ctx.lineWidth = 2.5 * pinchAnim;
        ctx.shadowColor = 'rgba(240,207,138,0.9)';
        ctx.shadowBlur = 22;
        ctx.beginPath(); ctx.arc(rx, ry, burstR, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = pinchAnim * 0.35;
        ctx.beginPath(); ctx.arc(rx, ry, burstR * 0.55, 0, Math.PI * 2); ctx.stroke();
        pinchAnim = Math.max(0, pinchAnim - 0.052);
      }

    } else if (handVisible) {
      /* ---- HAND DETECTED, NOT POINTING ---- */
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = 'rgba(207,160,83,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 7]);
      ctx.beginPath(); ctx.arc(rx, ry, 24, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(207,160,83,0.8)';
      ctx.font = '8px "Space Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('POINT TO AIM', rx, ry + 40);

    } else {
      /* ---- NO HAND ---- */
      ctx.globalAlpha = 0.10;
      ctx.strokeStyle = 'rgba(245,239,224,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(rx, ry, 22, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.restore();
  }

  /* ── placePoint ─────────────────────────────────────────── */
  function placePoint(x, y) {
    points.push({ x, y, tw: Math.random() * 10 });
    rdCount.textContent = points.length;
    updateAccuracyPanel();
  }

  /* Canvas tap / click -> always available */
  canvas.addEventListener('pointerdown', e => {
    const rect = canvas.getBoundingClientRect();
    placePoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  /* ── Dock buttons ───────────────────────────────────────── */
  document.getElementById('btnTrack').addEventListener('click', function () {
    trackingOn = !trackingOn;
    this.classList.toggle('toggle-on', trackingOn);
    if (!trackingOn) { handVisible = false; isPointing = false; }
    toast(trackingOn ? 'Hand tracking engaged' : 'Hand tracking off');
  });

  document.getElementById('btnUndo').addEventListener('click', () => {
    if (!points.length) return;
    points.pop();
    rdCount.textContent = points.length;
    updateAccuracyPanel();
    toast('Last star removed');
  });

  document.getElementById('btnClear').addEventListener('click', () => {
    points = [];
    rdCount.textContent = 0;
    updateAccuracyPanel();
    toast('Chart cleared');
  });

  document.getElementById('btnGuide').addEventListener('click', function () {
    if (!guideKey) { toast('Pick a zodiac glyph above'); return; }
    this.classList.toggle('toggle-on');
  });

  document.getElementById('btnSave').addEventListener('click', async () => {
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d');
    octx.save();
    octx.translate(W, 0); octx.scale(-1, 1);
    octx.filter = 'saturate(0.55) brightness(0.62) contrast(1.08)';
    octx.drawImage(video, 0, 0, W, H);
    octx.restore();
    octx.fillStyle = 'rgba(7,6,26,0.25)'; octx.fillRect(0, 0, W, H);
    octx.drawImage(canvas, 0, 0, W, H);
    const a = document.createElement('a');
    a.download = 'astral-chart.png';
    a.href = out.toDataURL('image/png');
    a.click();
    try {
      const result = await (await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points, guide: guideKey }),
      })).json();
      toast(result.success ? 'Chart saved \u2014 ' + result.star_count + ' stars' : 'Save failed');
    } catch (_) { toast('Star chart downloaded'); }
  });

  /* ── Background starfield ───────────────────────────────── */
  const bg = Array.from({ length: 70 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 1.3 + 0.3, tw: Math.random() * 10,
  }));

  /* ── Main render loop ───────────────────────────────────── */
  function loop(t) {
    ctx.clearRect(0, 0, W, H);

    bg.forEach(s => {
      const a = twinkle(t, s.tw) * 0.5;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#f5efe0';
      ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });

    drawGuide(t);
    drawReticle(t);
    drawConstellation(t);
    requestAnimationFrame(loop);
  }

  /* ── Boot ───────────────────────────────────────────────── */
  loadGuides();

})();
