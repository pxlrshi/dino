// each animation set is a single combined sprite sheet (frames laid out left
// to right, see Sprites/Sheets/) rather than separate per-frame files —
// advancing a frame just shifts `background-position-x` within the one
// already-loaded image, so there's exactly one network request per set, ever,
// and no per-frame DOM elements to keep in sync (both of which were sources
// of real bugs: repeated background-image swapping re-requests the file from
// the server on every change when it isn't sent cache headers, and the
// stacked-layer approach that replaced it had its own occasional rendering
// glitches where the sprite would drop out for a frame). Frame selection
// uses percentage-based background-size/position rather than pixel values,
// so it's driven entirely by the element's own CSS size — the same sheet
// renders correctly whether the container is the desktop or mobile display
// size, with no JS awareness of which layout is active needed here.
function dinoSheet(src, frameCount) {
  return { src, frameCount };
}

const IDLE_SHEET = dinoSheet("Sprites/Sheets/dino-idle.png", 4);
const IDLE_FRAME_DURATION_MS = 200;

const RUN_SHEET = dinoSheet("Sprites/Sheets/dino-run.png", 6);
const RUN_FRAME_DURATION_MS = 80; // starting ms per run frame
const RUN_FRAME_DURATION_FLOOR_MS = 40; // fastest the run cycle gets
const RUN_FRAME_DURATION_RAMP_MS_PER_SEC = 0.7; // how much faster (ms less) per second survived

function currentRunFrameDurationMs(survivedSeconds) {
  return Math.max(
    RUN_FRAME_DURATION_MS - survivedSeconds * RUN_FRAME_DURATION_RAMP_MS_PER_SEC,
    RUN_FRAME_DURATION_FLOOR_MS
  );
}

const JUMP_SHEET = dinoSheet("Sprites/Sheets/dino-jump.png", 10);
// variable-height jump: releasing space early cuts the rise short (a lower
// jump), holding it through the rise extends the hang at the peak before
// falling (a higher, longer jump) — height and duration both scale with how
// long space is held
const JUMP_RISE_DURATION_MS = 180; // time to climb to full peak height if held the whole way
const JUMP_PEAK_HEIGHT_PX = 170; // full peak height for a max-length hold
const JUMP_MIN_RISE_MS = 60; // even the quickest tap rises for at least this long
const JUMP_MAX_HANG_MS = 220; // longest a hold can extend the hang at the peak
const JUMP_FALL_DURATION_MS = 180; // time to fall from full peak height (scales down for shorter hops)

function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

function easeInQuint(t) {
  return Math.pow(t, 5);
}

const HURT_SHEET = dinoSheet("Sprites/Sheets/dino-hurt.png", 3);
const HURT_FRAME_DURATION_MS = 90;

const MIN_SCORE_DIGITS = 3;
const SCORE_TICK_MS = 100;
const HI_SCORE_STORAGE_KEY = "dino-hi-score";

const GLYPH_SRCS = [];
for (let d = 0; d <= 9; d += 1) {
  GLYPH_SRCS.push(`Sprites/Glyphs/Score/${d}.png`, `Sprites/Glyphs/Hiscore/${d}.png`);
}
GLYPH_SRCS.push("Sprites/Glyphs/Hiscore/hi.png");

// display width/height for each variant AT DESKTOP SCALE, scaled 0.5x from
// their native art (120px-wide canvases) to match the dino sprite's own
// 170->85 native scale; actual on-screen size is this times the active
// layout's cactusScale (mobile shows everything at half this again — see
// LAYOUT below). slug matches the combined sheet file
// (Sprites/Sheets/cactus-<slug>.png)
const CACTUS_VARIANTS = [
  { folder: "Cactus A", slug: "a", width: 60, height: 75 },
  { folder: "Cactus B", slug: "b", width: 60, height: 65 },
  { folder: "Cactus C", slug: "c", width: 60, height: 80 },
  { folder: "Cactus D", slug: "d", width: 60, height: 70 },
  { folder: "Cactus E", slug: "e", width: 60, height: 65 },
  { folder: "Cactus F", slug: "f", width: 60, height: 75 },
  { folder: "Cactus G", slug: "g", width: 60, height: 120 },
  { folder: "Cactus H", slug: "h", width: 60, height: 110 },
  { folder: "Cactus I", slug: "i", width: 60, height: 115 },
];
// widest cactus at desktop scale — actual per-layout max is this times
// layout.cactusScale, computed in cactusDespawnX() below
const CACTUS_MAX_WIDTH_PX = Math.max(...CACTUS_VARIANTS.map((variant) => variant.width));

// two bespoke compositions (see style.css's `body.mobile` rules for the
// matching static element positions) rather than one design scaled down —
// every sprite is shown at exactly half its desktop size on mobile, but
// gameplay-relevant positions (ground level, dino's own x) are their own
// measured values, not simply halved
const DESKTOP_LAYOUT = {
  stageWidth: 1440,
  stageHeight: 1024,
  // matches .dino-sprite's own `left` in style.css — once a cactus's
  // trailing edge clears this, it can no longer collide and counts as dodged
  dinoLeft: 253,
  // matches .cactus's `bottom: 481.24px` on the 1024px stage (1024 - 481.24)
  cactusBottomY: 542.76,
  cactusReflectionGap: 10,
  cactusScale: 1,
  cactusEdgeFadePx: 120, // off-screen spawn/despawn/fade buffer
  cactusGroupGapPx: 65, // cactus width (60) + a 1-artwork-pixel gap (5)
  cactusMinGapPx: 255, // dino width (85) * 3
};

const MOBILE_LAYOUT = {
  stageWidth: 390,
  stageHeight: 844,
  dinoLeft: 32,
  cactusBottomY: 403.5,
  cactusReflectionGap: 8,
  cactusScale: 0.5,
  cactusEdgeFadePx: 60,
  cactusGroupGapPx: 32.5, // half of the desktop value, matching cactusScale
  cactusMinGapPx: 127.5, // dino width (42.5) * 3
};

let layout = DESKTOP_LAYOUT;

function isMobileViewport() {
  return window.innerWidth < window.innerHeight;
}

function updateLayout() {
  const mobile = isMobileViewport();
  layout = mobile ? MOBILE_LAYOUT : DESKTOP_LAYOUT;
  document.body.classList.toggle("mobile", mobile);
}

const CACTUS_FRAME_COUNT = 4;
const CACTUS_FRAME_DURATION_MS = 150;
const CACTUS_BASE_SPEED_PX_PER_SEC = 420;
const CACTUS_MAX_SPEED_PX_PER_SEC = 1000;
const CACTUS_SPEED_RAMP_PX_PER_SEC_PER_SEC = 9; // how much faster obstacles get per second survived

// spawn gaps tighten from the starting window down toward the floor window
// as the run goes on, so obstacles come more often the longer you survive
const CACTUS_SPAWN_MIN_MS_START = 650;
const CACTUS_SPAWN_MAX_MS_START = 1600;
const CACTUS_SPAWN_MIN_MS_FLOOR = 300;
const CACTUS_SPAWN_MAX_MS_FLOOR = 650;
const CACTUS_SPAWN_RAMP_MS_PER_SEC = 22; // how much (in ms) the spawn window tightens per second survived

function currentSpawnBounds(survivedSeconds) {
  const reduction = survivedSeconds * CACTUS_SPAWN_RAMP_MS_PER_SEC;
  return {
    min: Math.max(CACTUS_SPAWN_MIN_MS_START - reduction, CACTUS_SPAWN_MIN_MS_FLOOR),
    max: Math.max(CACTUS_SPAWN_MAX_MS_START - reduction, CACTUS_SPAWN_MAX_MS_FLOOR),
  };
}

function nextSpawnDelayMs(survivedSeconds) {
  const { min, max } = currentSpawnBounds(survivedSeconds);
  // however tight the spawn timing window gets, never let two consecutive
  // spawns land closer together than this — computed as a time delay from
  // the current scroll speed, so it holds regardless of how fast obstacles move
  const minGapDelayMs = (layout.cactusMinGapPx / cactusSpeed) * 1000;
  return Math.max(randomBetween(min, max), minGapDelayMs);
}

function cactusSheet(variant) {
  return { src: `Sprites/Sheets/cactus-${variant.slug}.png`, frameCount: CACTUS_FRAME_COUNT };
}

const CACTUS_SHEET_SRCS = CACTUS_VARIANTS.map((variant) => cactusSheet(variant).src);
const DINO_SHEET_SRCS = [IDLE_SHEET, RUN_SHEET, JUMP_SHEET, HURT_SHEET].map((sheet) => sheet.src);

[...DINO_SHEET_SRCS, ...GLYPH_SRCS, ...CACTUS_SHEET_SRCS].forEach((src) => {
  new Image().src = src;
});

// elements: a single element, or an array of elements that should all show
// the same frame in lockstep (e.g. a sprite and its reflection)
//
// sheet: { src, frameCount } — a single combined image; showing a frame only
// ever changes `background-position-x` once the sheet itself is already the
// element's background-image, so switching frames never triggers network
// activity
function createSpriteAnimator(elements) {
  const els = Array.isArray(elements) ? elements : [elements];
  let currentSheetSrc = null;
  let loopingSheet = null; // the sheet a `play()` loop is currently cycling, if any
  let loopFrameIndex = 0;
  let intervalId = null;
  let timeoutId = null;

  function stop() {
    clearInterval(intervalId);
    clearTimeout(timeoutId);
    loopingSheet = null;
  }

  function showFrame(sheet, index) {
    if (currentSheetSrc !== sheet.src) {
      const backgroundImage = `url("${sheet.src}")`;
      // stretches the sheet to frameCount x the element's own width, so
      // each frame occupies exactly one element-width regardless of what
      // that width actually is (desktop or mobile CSS size)
      const backgroundSize = `${sheet.frameCount * 100}% 100%`;
      els.forEach((el) => {
        el.style.backgroundImage = backgroundImage;
        el.style.backgroundSize = backgroundSize;
      });
      currentSheetSrc = sheet.src;
    }
    const backgroundPositionX =
      sheet.frameCount > 1 ? `${(index / (sheet.frameCount - 1)) * 100}%` : "0%";
    els.forEach((el) => {
      el.style.backgroundPositionX = backgroundPositionX;
    });
  }

  function startLoop(sheet, durationMs) {
    intervalId = setInterval(() => {
      loopFrameIndex = (loopFrameIndex + 1) % sheet.frameCount;
      showFrame(sheet, loopFrameIndex);
    }, durationMs);
  }

  function play(sheet, durationMs) {
    stop();
    loopingSheet = sheet;
    loopFrameIndex = 0;
    showFrame(sheet, loopFrameIndex);
    startLoop(sheet, durationMs);
  }

  // durationsMs: either a fixed ms-per-frame, or an array with one entry per frame
  function playOnce(sheet, durationsMs, onComplete) {
    stop();
    const holdFor = (i) =>
      Array.isArray(durationsMs) ? durationsMs[i] : durationsMs;

    let frameIndex = 0;
    const step = () => {
      showFrame(sheet, frameIndex);
      timeoutId = setTimeout(() => {
        if (frameIndex >= sheet.frameCount - 1) {
          if (onComplete) onComplete();
          return;
        }
        frameIndex += 1;
        step();
      }, holdFor(frameIndex));
    };
    step();
  }

  // changes the tick speed of a currently-looping `play()` without resetting
  // back to frame 0 — a no-op if this sheet isn't the one actively looping
  // (e.g. mid-jump, or already stopped), so callers can call this freely
  function retune(sheet, durationMs) {
    if (loopingSheet !== sheet) return;
    clearInterval(intervalId);
    startLoop(sheet, durationMs);
  }

  return { play, playOnce, stop, showFrame, retune };
}

const dinoSprite = document.getElementById("dino-sprite");
const dinoReflection = document.getElementById("dino-reflection");
const groundLine = document.getElementById("ground-line");
const dinoAnimator = createSpriteAnimator([dinoSprite, dinoReflection]);

const scoreDisplay = document.getElementById("score-display");
const scoreDigitsEl = document.getElementById("score-digits");
const hiscoreDigitsEl = document.getElementById("hiscore-digits");

let score = 0;
let hiScore = parseInt(localStorage.getItem(HI_SCORE_STORAGE_KEY), 10) || 0;
let scoreIntervalId = null;

function renderDigits(container, folder, number) {
  const digitCount = Math.max(MIN_SCORE_DIGITS, String(number).length);
  const digits = String(number).padStart(digitCount, "0");
  container.innerHTML = "";
  for (const digit of digits) {
    const glyph = document.createElement("div");
    glyph.className = "glyph";
    glyph.style.backgroundImage = `url("Sprites/Glyphs/${folder}/${digit}.png")`;
    container.appendChild(glyph);
  }
}

function updateScoreDisplay() {
  renderDigits(scoreDigitsEl, "Score", score);
  renderDigits(hiscoreDigitsEl, "Hiscore", Math.max(score, hiScore));
}

function addScore(amount) {
  score = Math.min(score + amount, 99999);
  if (score > hiScore) {
    hiScore = score;
    localStorage.setItem(HI_SCORE_STORAGE_KEY, String(hiScore));
  }
  updateScoreDisplay();
}

function startScoring() {
  scoreDisplay.classList.add("visible");
  if (scoreIntervalId) return;
  scoreIntervalId = setInterval(() => {
    addScore(100);
  }, SCORE_TICK_MS);
}

updateScoreDisplay();

let dinoState = "intro";
let runStartTime = null;
let spacePressCount = 0;
let lastAppliedRunDurationMs = null;

// blocks the retry press for a moment after death so mashing space in
// frustration doesn't instantly restart the run — the player never sees a
// countdown, the first press just quietly does nothing until this passes
const RESTART_COOLDOWN_MS = 800;
let restartAllowedAt = 0;

// must match the opacity transition duration on .alive-only/.dead-only in style.css
const COPY_FADE_MS = 250;

let jumpHeld = false;
let jumpPhase = null; // "rising" | "hanging" | "falling"
let jumpPhaseStartTime = 0;
let jumpHeightAtFallStart = 0;
let jumpFallDurationMs = JUMP_FALL_DURATION_MS;
let jumpAnimId = null;

const letterboxTop = document.getElementById("letterbox-top");
const letterboxBottom = document.getElementById("letterbox-bottom");
// classes, not ids — there's a desktop and a mobile copy of each stat, and
// both need updating regardless of which one is currently visible
const jumpCountValueEls = document.querySelectorAll(".jump-count-value");
const survivalTimeValueEls = document.querySelectorAll(".survival-time-value");

function formatSurvivalTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}M ${seconds}S.`;
}

function playIntro() {
  dinoAnimator.play(RUN_SHEET, RUN_FRAME_DURATION_MS);

  requestAnimationFrame(() => {
    dinoSprite.classList.add("intro-run");
    dinoSprite.classList.remove("intro-start");
    dinoReflection.classList.add("intro-run");
    dinoReflection.classList.remove("intro-start");
    document.querySelectorAll(".animate-in").forEach((el) => {
      el.classList.add("visible");
    });
  });
}

dinoSprite.addEventListener("transitionend", (e) => {
  // "left" also transitions during the post-death knockback (.knocked-back),
  // so this must only react to the page-load intro's own transition
  if (e.propertyName !== "left" || !dinoSprite.classList.contains("intro-run")) return;
  dinoSprite.classList.remove("intro-run");
  dinoReflection.classList.remove("intro-run");
  dinoAnimator.play(IDLE_SHEET, IDLE_FRAME_DURATION_MS);
  dinoState = "idle";
});

playIntro();

function startRunning() {
  dinoState = "running";
  if (runStartTime === null) runStartTime = Date.now();
  const survivedSeconds = (Date.now() - runStartTime) / 1000;
  const runDurationMs = Math.round(currentRunFrameDurationMs(survivedSeconds));
  dinoAnimator.play(RUN_SHEET, runDurationMs);
  lastAppliedRunDurationMs = runDurationMs;
  groundLine.classList.add("running");
  letterboxTop.classList.add("visible");
  letterboxBottom.classList.add("visible");
  startScoring();
  startObstacles();
}

function setJumpFrame(index) {
  dinoAnimator.showFrame(JUMP_SHEET, index);
}

function beginFalling(heightAtRelease) {
  jumpPhase = "falling";
  jumpPhaseStartTime = performance.now();
  jumpHeightAtFallStart = heightAtRelease;
  // a shorter hop falls back down faster than a full-height jump
  jumpFallDurationMs = Math.max(
    JUMP_FALL_DURATION_MS * (heightAtRelease / JUMP_PEAK_HEIGHT_PX),
    JUMP_FALL_DURATION_MS * 0.35
  );
}

function jumpTick(timestamp) {
  if (dinoState !== "jumping") return;

  const elapsed = timestamp - jumpPhaseStartTime;
  let height = 0;

  if (jumpPhase === "rising") {
    const t = Math.min(elapsed / JUMP_RISE_DURATION_MS, 1);
    height = JUMP_PEAK_HEIGHT_PX * easeOutQuint(t);
    setJumpFrame(Math.min(Math.floor(t * 4), 3));

    if (!jumpHeld && elapsed >= JUMP_MIN_RISE_MS) {
      beginFalling(height);
    } else if (t >= 1) {
      jumpPhase = "hanging";
      jumpPhaseStartTime = timestamp;
      height = JUMP_PEAK_HEIGHT_PX;
    }
  } else if (jumpPhase === "hanging") {
    height = JUMP_PEAK_HEIGHT_PX;
    setJumpFrame(4 + (Math.floor(elapsed / 90) % 2));

    if (!jumpHeld || elapsed >= JUMP_MAX_HANG_MS) {
      beginFalling(height);
    }
  } else if (jumpPhase === "falling") {
    const t = Math.min(elapsed / jumpFallDurationMs, 1);
    height = jumpHeightAtFallStart * (1 - easeInQuint(t));
    setJumpFrame(6 + Math.min(Math.floor(t * 4), 3));

    if (t >= 1) {
      dinoSprite.style.transform = "";
      dinoReflection.style.transform = "";
      land();
      return;
    }
  }

  dinoSprite.style.transform = `translateY(${-height}px)`;
  // moves the opposite direction instead of following the dino up, so the
  // reflection appears to recede as the dino rises away from the surface —
  // translateY happens before the scaleY(-1) flip, so a positive value here
  // ends up moving the flipped result downward by the same amount
  dinoReflection.style.transform = `scaleY(-1) translateY(${-height}px)`;
  jumpAnimId = requestAnimationFrame(jumpTick);
}

function jump() {
  dinoState = "jumping";
  dinoSprite.classList.add("jumping");
  dinoAnimator.stop();

  jumpHeld = true;
  jumpPhase = "rising";
  jumpPhaseStartTime = performance.now();

  if (jumpAnimId) cancelAnimationFrame(jumpAnimId);
  jumpAnimId = requestAnimationFrame(jumpTick);
}

const stageWrapper = document.querySelector(".stage-wrapper");

function triggerScreenShake() {
  stageWrapper.classList.remove("shake");
  void stageWrapper.offsetWidth; // force reflow so re-adding the class restarts the animation
  stageWrapper.classList.add("shake");
}

stageWrapper.addEventListener("animationend", (e) => {
  if (e.animationName === "screen-shake") stageWrapper.classList.remove("shake");
});

function land() {
  dinoSprite.classList.remove("jumping");
  startRunning();
  triggerScreenShake();
}

// shared by both the spacebar (desktop) and tap/click (mobile, or a mouse
// click anywhere on desktop) — press starts/jumps/retries, release ends the
// hold that controls jump height
function handleActivatePress() {
  if (dinoState === "dead") {
    if (Date.now() < restartAllowedAt) return;
    resetGame();
    return;
  }

  spacePressCount += 1;

  if (dinoState === "idle") {
    startRunning();
  } else if (dinoState === "running") {
    jump();
  }
}

function handleActivateRelease() {
  jumpHeld = false;
}

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  e.preventDefault();
  handleActivatePress();
});

window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  handleActivateRelease();
});

window.addEventListener("pointerdown", (e) => {
  // skip real links (e.g. "hiring me") so they still navigate normally, and
  // skip anything but the primary button/touch (no reacting to right-clicks)
  if (e.button > 0 || e.target.closest("a")) return;
  e.preventDefault();
  handleActivatePress();
});

window.addEventListener("pointerup", handleActivateRelease);

const keyBadge = document.querySelector(".key-badge");

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  keyBadge.classList.add("pressed");
});

window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  keyBadge.classList.remove("pressed");
});

const stage = document.querySelector(".stage");

const obstacles = [];
let obstaclesActive = false;
let obstacleLoopId = null;
let obstacleLastFrameTime = null;
let obstacleSpawnInMs = 0;
let cactusSpeed = CACTUS_BASE_SPEED_PX_PER_SEC;

// obstacles spawn/fade in and despawn/fade out entirely in an off-screen
// buffer so they're already fully opaque by the time they cross onto the
// visible stage, and don't fade out until they've fully left it — the
// visible edge-to-edge stretch is always at full opacity
function cactusSpawnX() {
  return layout.stageWidth + layout.cactusEdgeFadePx;
}

function cactusDespawnX() {
  return -(layout.cactusEdgeFadePx + CACTUS_MAX_WIDTH_PX * layout.cactusScale);
}

// hitboxes are inset from each sprite's full canvas since the art itself
// (with transparent padding) doesn't fill its bounding box, so a raw
// edge-to-edge check would feel unfair
const DINO_HITBOX_INSET_RATIO = 0.22;
const CACTUS_HITBOX_INSET_RATIO = 0.12;

function insetRect(rect, ratio) {
  const dx = rect.width * ratio;
  const dy = rect.height * ratio;
  return {
    left: rect.left + dx,
    right: rect.right - dx,
    top: rect.top + dy,
    bottom: rect.bottom - dy,
  };
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function checkCollisions() {
  const dinoHitbox = insetRect(dinoSprite.getBoundingClientRect(), DINO_HITBOX_INSET_RATIO);
  for (const obstacle of obstacles) {
    const cactusHitbox = insetRect(obstacle.el.getBoundingClientRect(), CACTUS_HITBOX_INSET_RATIO);
    if (rectsOverlap(dinoHitbox, cactusHitbox)) {
      die();
      return;
    }
  }
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function cactusOpacity(x, width) {
  // off-screen past the right edge: fade in over the buffer so it's already
  // fully opaque by the moment its leading edge reaches the visible stage
  if (x > layout.stageWidth) {
    return Math.max(0, Math.min(1, (cactusSpawnX() - x) / layout.cactusEdgeFadePx));
  }
  const trailingEdge = x + width;
  // off-screen past the left edge: fade out over the buffer, only once its
  // trailing edge has fully left the visible stage
  if (trailingEdge < 0) {
    return Math.max(0, Math.min(1, (trailingEdge + layout.cactusEdgeFadePx) / layout.cactusEdgeFadePx));
  }
  return 1;
}

// most spawns are a single cactus, but sometimes a pair spawns close
// together so the player has to clear a wider hurdle
const CACTUS_GROUP_SIZE_WEIGHTS = [
  { size: 1, weight: 55 },
  { size: 2, weight: 30 },
];

const CACTUS_REFLECTION_OPACITY = 0.25;

function pickCactusGroupSize() {
  const totalWeight = CACTUS_GROUP_SIZE_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const { size, weight } of CACTUS_GROUP_SIZE_WEIGHTS) {
    if (roll < weight) return size;
    roll -= weight;
  }
  return 1;
}

function spawnCactus(offsetX = 0) {
  const variant = CACTUS_VARIANTS[Math.floor(Math.random() * CACTUS_VARIANTS.length)];
  const width = variant.width * layout.cactusScale;
  const height = variant.height * layout.cactusScale;
  const x = cactusSpawnX() + offsetX;

  const el = document.createElement("div");
  el.className = "cactus";
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  // `left` is set once here as the resting spawn position; movement is then
  // driven by `transform: translateX()` off this base (see updateObstacles),
  // since changing `left` every frame forces a full layout+paint each time
  el.style.left = `${x}px`;
  // `bottom` is CSS's distance from .stage's own bottom edge, so this needs
  // converting from the layout's cactusBottomY (measured from the top)
  el.style.bottom = `${layout.stageHeight - layout.cactusBottomY}px`;
  el.style.opacity = "0";
  stage.appendChild(el);

  const reflectionEl = document.createElement("div");
  reflectionEl.className = "cactus-reflection";
  reflectionEl.style.width = `${width}px`;
  reflectionEl.style.height = `${height}px`;
  reflectionEl.style.left = `${x}px`;
  reflectionEl.style.top = `${layout.cactusBottomY + layout.cactusReflectionGap}px`;
  reflectionEl.style.opacity = "0";
  stage.appendChild(reflectionEl);

  const animator = createSpriteAnimator([el, reflectionEl]);
  animator.play(cactusSheet(variant), CACTUS_FRAME_DURATION_MS);

  obstacles.push({ el, reflectionEl, animator, x, baseX: x, width, dodged: false });
}

function spawnCactusGroup() {
  const groupSize = pickCactusGroupSize();
  for (let i = 0; i < groupSize; i += 1) {
    spawnCactus(i * layout.cactusGroupGapPx);
  }
}

const DODGE_SCORE_BONUS = 50;

function updateObstacles(dtSeconds) {
  for (let i = obstacles.length - 1; i >= 0; i -= 1) {
    const obstacle = obstacles[i];
    obstacle.x -= cactusSpeed * dtSeconds;
    const dx = obstacle.x - obstacle.baseX;
    const opacity = cactusOpacity(obstacle.x, obstacle.width);

    obstacle.el.style.transform = `translateX(${dx}px)`;
    obstacle.el.style.opacity = String(opacity);

    // translateX doesn't interact with the reflection's static scaleY(-1)
    // flip (different axes), so this always lands at the same x as the
    // cactus itself regardless of composition order
    obstacle.reflectionEl.style.transform = `scaleY(-1) translateX(${dx}px)`;
    obstacle.reflectionEl.style.opacity = String(opacity * CACTUS_REFLECTION_OPACITY);

    // once a cactus's trailing edge clears the dino's own left edge, it can
    // no longer collide and counts as successfully dodged
    if (!obstacle.dodged && obstacle.x + obstacle.width < layout.dinoLeft) {
      obstacle.dodged = true;
      addScore(DODGE_SCORE_BONUS);
    }

    if (obstacle.x + obstacle.width < -layout.cactusEdgeFadePx) {
      obstacle.animator.stop();
      obstacle.el.remove();
      obstacle.reflectionEl.remove();
      obstacles.splice(i, 1);
    }
  }
}

function obstacleLoop(timestamp) {
  if (!obstaclesActive) return;

  // clamp so resuming a backgrounded/throttled tab doesn't move obstacles
  // in one huge jump
  const dtSeconds = Math.min((timestamp - obstacleLastFrameTime) / 1000, 0.1);
  obstacleLastFrameTime = timestamp;

  const survivedSeconds = (Date.now() - runStartTime) / 1000;
  cactusSpeed = Math.min(
    CACTUS_BASE_SPEED_PX_PER_SEC + survivedSeconds * CACTUS_SPEED_RAMP_PX_PER_SEC_PER_SEC,
    CACTUS_MAX_SPEED_PX_PER_SEC
  );

  // speeds up the run cycle gradually while actually running (a no-op via
  // retune() while jumping, since RUN_SHEET isn't the looping sheet then —
  // the next landing's startRunning() picks up the current speed instead);
  // rounded so this only restarts the interval on a real, whole-ms change
  const targetRunDurationMs = Math.round(currentRunFrameDurationMs(survivedSeconds));
  if (targetRunDurationMs !== lastAppliedRunDurationMs) {
    dinoAnimator.retune(RUN_SHEET, targetRunDurationMs);
    lastAppliedRunDurationMs = targetRunDurationMs;
  }

  // read geometry (checkCollisions) before writing any new DOM this tick —
  // spawning inserts new elements, which invalidates layout, so doing that
  // first was forcing a synchronous reflow right before the getBoundingClientRect()
  // reads, causing a dropped/flickered frame right at every spawn
  updateObstacles(dtSeconds);
  checkCollisions();

  // checkCollisions() may have just called die(), which stops future ticks
  // but doesn't interrupt this one — bail out before spawning a group into
  // a run that's already over
  if (!obstaclesActive) return;

  obstacleSpawnInMs -= dtSeconds * 1000;
  if (obstacleSpawnInMs <= 0) {
    spawnCactusGroup();
    obstacleSpawnInMs = nextSpawnDelayMs(survivedSeconds);
  }

  obstacleLoopId = requestAnimationFrame(obstacleLoop);
}

function startObstacles() {
  if (obstaclesActive) return;
  obstaclesActive = true;
  obstacleLastFrameTime = performance.now();
  obstacleSpawnInMs = nextSpawnDelayMs(0);
  obstacleLoopId = requestAnimationFrame(obstacleLoop);
}

function die() {
  if (dinoState === "dead") return;
  dinoState = "dead";

  obstaclesActive = false;
  if (obstacleLoopId) cancelAnimationFrame(obstacleLoopId);
  obstacles.forEach((obstacle) => obstacle.animator.stop());

  clearInterval(scoreIntervalId);
  scoreIntervalId = null;

  if (jumpAnimId) cancelAnimationFrame(jumpAnimId);
  dinoSprite.classList.remove("jumping");
  dinoSprite.style.transform = "";
  dinoReflection.style.transform = "";
  dinoSprite.classList.add("knocked-back");
  dinoReflection.classList.add("knocked-back");
  const despawnX = cactusDespawnX();
  dinoSprite.style.left = `${despawnX}px`;
  dinoReflection.style.left = `${despawnX}px`;
  dinoAnimator.playOnce(HURT_SHEET, HURT_FRAME_DURATION_MS);
  triggerScreenShake();

  letterboxTop.classList.remove("visible");
  letterboxBottom.classList.remove("visible");

  const survivalTime = formatSurvivalTime(Date.now() - runStartTime);
  jumpCountValueEls.forEach((el) => { el.textContent = String(spacePressCount); });
  survivalTimeValueEls.forEach((el) => { el.textContent = survivalTime; });

  // crossfades the copy instead of swapping it instantly: fade the alive
  // copy out in place, then (once display can safely swap without a visible
  // jump) swap to the dead copy and fade that in — see the .copy-fading /
  // .is-dead / .copy-visible rules in style.css
  stage.classList.add("copy-fading");
  setTimeout(() => {
    stage.classList.remove("copy-fading");
    stage.classList.add("is-dead");
    requestAnimationFrame(() => {
      stage.classList.add("copy-visible");
    });
  }, COPY_FADE_MS);

  restartAllowedAt = Date.now() + RESTART_COOLDOWN_MS;
}

function resetGame() {
  obstacles.forEach((obstacle) => {
    obstacle.animator.stop();
    obstacle.el.remove();
    obstacle.reflectionEl.remove();
  });
  obstacles.length = 0;
  cactusSpeed = CACTUS_BASE_SPEED_PX_PER_SEC;

  dinoSprite.classList.remove("knocked-back");
  dinoReflection.classList.remove("knocked-back");
  dinoSprite.style.left = "";
  dinoReflection.style.left = "";

  stage.classList.remove("is-dead", "copy-fading", "copy-visible");

  score = 0;
  updateScoreDisplay();

  spacePressCount = 0;
  runStartTime = null;

  startRunning();
}

function scaleStageToFit() {
  updateLayout();
  const scale = Math.min(
    window.innerWidth / layout.stageWidth,
    window.innerHeight / layout.stageHeight,
    1
  );
  stage.style.transform = `scale(${scale})`;
}

window.addEventListener("resize", scaleStageToFit);
scaleStageToFit();

