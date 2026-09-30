(function () {
  'use strict';

  // ===================== 상수 =====================

  const LANE_COUNT = 5;
  const LANE_KEYS = ['KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ'];

  const APPROACH_SEC = 1.9;        // 화면 위에서 판정선까지 내려오는 시간
  const W_PERFECT = 0.07;          // PERFECT 판정 폭 (초)
  const W_GOOD = 0.14;             // GOOD 판정 폭 (초)
  const W_MISS = 0.16;             // 이 시간을 넘기면 놓친 것

  const BPM = 100;
  const STEP_SEC = 60 / BPM / 2;   // 8비트 한 칸
  const STEPS_PER_BAR = 8;         // 4/4 한 마디 = 8비트 8칸

  const SCHEDULE_AHEAD = 0.12;     // 오디오 미리 예약 구간 (초)
  const SCHEDULER_MS = 25;         // 스케줄러 깨어나는 주기
  const MAX_LIFE = 5;
  const JUDGE_RATIO = 0.82;        // 판정선 위치 (style.css의 --judge-pos와 동일)

  const CHORD_ROOTS = [110.0, 87.31, 130.81, 98.0]; // A2 · F2 · C3 · G2

  // ===================== DOM =====================

  const stage = document.getElementById('stage');
  const laneEls = Array.from(document.querySelectorAll('.lane'));
  const keyEls = Array.from(document.querySelectorAll('.key'));
  const frogCols = Array.from(document.querySelectorAll('.frog-col'));
  const judgeTextEl = document.getElementById('judge-text');

  const scoreEl = document.getElementById('score');
  const comboEl = document.getElementById('combo');
  const accuracyEl = document.getElementById('accuracy');
  const lifeEl = document.getElementById('life');

  const startOverlay = document.getElementById('start-overlay');
  const pauseOverlay = document.getElementById('pause-overlay');
  const overOverlay = document.getElementById('over-overlay');
  const startBtn = document.getElementById('start-btn');
  const resumeBtn = document.getElementById('resume-btn');
  const restartBtn = document.getElementById('restart-btn');
  const finalScoreEl = document.getElementById('final-score');
  const finalComboEl = document.getElementById('final-combo');
  const finalAccuracyEl = document.getElementById('final-accuracy');

  // ===================== 오디오 엔진 =====================

  let audioCtx = null;
  let masterGain = null;
  let noiseBuffer = null;

  function initAudio() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(audioCtx.destination);

    // 하이햇용 화이트노이즈 (1초짜리 한 번만 만들어 재사용)
    const len = audioCtx.sampleRate;
    noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  function now() {
    return audioCtx ? audioCtx.currentTime : 0;
  }

  function playKick(time) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(48, time + 0.13);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.8, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    osc.connect(gain).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.25);
  }

  function playHat(time, accent) {
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = accent ? 6000 : 8000;
    const gain = audioCtx.createGain();
    const peak = accent ? 0.16 : 0.07;
    const dur = accent ? 0.09 : 0.04;
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(hp).connect(gain).connect(masterGain);
    src.start(time);
    src.stop(time + dur + 0.02);
  }

  function playBass(time, freq) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.22, time + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + STEP_SEC * 3.2);
    osc.connect(gain).connect(masterGain);
    osc.start(time);
    osc.stop(time + STEP_SEC * 3.4);
  }

  // 판정 순간 바로 울리는 효과음
  function playBlip(freq, dur, type, peak) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const sfx = {
    perfect: () => playBlip(1320, 0.14, 'triangle', 0.35),
    good: () => playBlip(880, 0.12, 'triangle', 0.28),
    miss: () => playBlip(130, 0.2, 'sawtooth', 0.18)
  };

  // ===================== 게임 상태 =====================

  const state = {
    running: false,
    paused: false,
    over: false,
    score: 0,
    combo: 0,
    maxCombo: 0,
    life: MAX_LIFE,
    judged: 0,
    accSum: 0,
    notes: [],          // 아직 판정되지 않은 노트들
    nextStepTime: 0,    // 다음 8비트 칸의 시각
    step: 0,            // 곡 시작부터의 8비트 칸 번호
    startTime: 0,
    lastLane: -1,
    laneRepeat: 0,
    pausedAt: 0,
    rafId: 0,
    schedulerId: 0
  };

  let judgeY = 0;
  let frogSize = 92;
  let pxPerSec = 0;

  function measure() {
    judgeY = stage.clientHeight * JUDGE_RATIO;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--frog-size');
    const parsed = parseFloat(raw);
    frogSize = Number.isFinite(parsed) ? parsed : 92;
    pxPerSec = (judgeY + frogSize) / APPROACH_SEC;
  }

  window.addEventListener('resize', measure);

  // ===================== 개구리 =====================

  const FROG_SVG =
    '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    '<ellipse class="body-dark" cx="18" cy="86" rx="14" ry="8"/>' +
    '<ellipse class="body-dark" cx="82" cy="86" rx="14" ry="8"/>' +
    '<ellipse class="body" cx="50" cy="62" rx="38" ry="31"/>' +
    '<ellipse fill="rgba(255,255,255,0.32)" cx="50" cy="74" rx="23" ry="16"/>' +
    '<circle class="body" cx="31" cy="29" r="16"/>' +
    '<circle class="body" cx="69" cy="29" r="16"/>' +
    '<circle fill="#ffffff" cx="31" cy="28" r="9"/>' +
    '<circle fill="#ffffff" cx="69" cy="28" r="9"/>' +
    '<circle fill="#16211d" cx="32" cy="29" r="4.6"/>' +
    '<circle fill="#16211d" cx="70" cy="29" r="4.6"/>' +
    '<path d="M30 66 Q50 80 70 66" fill="none" stroke="rgba(0,0,0,0.45)" ' +
    'stroke-width="3.4" stroke-linecap="round"/>' +
    '</svg>';

  function spawnFrog(note) {
    const el = document.createElement('div');
    el.className = 'frog';
    const inner = document.createElement('div');
    inner.className = 'inner';
    inner.innerHTML = FROG_SVG;
    el.appendChild(inner);
    el.style.transform = 'translate3d(0,' + (-frogSize) + 'px,0)';
    frogCols[note.lane].appendChild(el);
    note.el = el;
  }

  // ===================== 노트 생성 =====================

  function pickLane() {
    let lane = Math.floor(Math.random() * LANE_COUNT);
    // 같은 레인이 3번 연속 나오면 한 번 다시 뽑는다
    if (lane === state.lastLane && state.laneRepeat >= 2) {
      lane = Math.floor(Math.random() * LANE_COUNT);
    }
    if (lane === state.lastLane) {
      state.laneRepeat++;
    } else {
      state.laneRepeat = 0;
      state.lastLane = lane;
    }
    return lane;
  }

  function addNote(lane, hitTime) {
    state.notes.push({ lane: lane, hitTime: hitTime, el: null, alive: true });
  }

  function generateNotes(stepTime, step) {
    const elapsed = stepTime - state.startTime;
    const chance = Math.min(0.8, 0.42 + elapsed * 0.006); // 시간이 갈수록 촘촘해진다
    const onBeat = step % 2 === 0;
    const weight = onBeat ? 1 : 0.55;                     // 정박에 더 자주 나온다

    if (Math.random() > chance * weight) return;

    const lane = pickLane();
    addNote(lane, stepTime);

    // 20초가 지나면 가끔 두 레인 동시 노트
    if (elapsed > 20 && Math.random() < 0.08) {
      let other = Math.floor(Math.random() * LANE_COUNT);
      if (other === lane) other = (other + 2) % LANE_COUNT;
      addNote(other, stepTime);
    }
  }

  // ===================== 스케줄러 =====================

  function scheduler() {
    if (!state.running || state.paused) return;

    while (state.nextStepTime < now() + SCHEDULE_AHEAD) {
      const t = state.nextStepTime;
      const step = state.step;
      const inBar = step % STEPS_PER_BAR;

      playHat(t, inBar % 2 === 0);
      if (inBar === 0 || inBar === 4) playKick(t);
      if (inBar === 0) {
        const bar = Math.floor(step / STEPS_PER_BAR);
        playBass(t, CHORD_ROOTS[bar % CHORD_ROOTS.length]);
      }

      // 노트는 APPROACH_SEC 뒤에 판정선에 닿도록 미래 시각에 만든다
      generateNotes(t + APPROACH_SEC, step);

      state.nextStepTime += STEP_SEC;
      state.step++;
    }
  }

  // ===================== 판정 =====================

  function flashJudge(text, kind) {
    judgeTextEl.textContent = text;
    judgeTextEl.className = '';
    void judgeTextEl.offsetWidth; // 애니메이션 재시작
    judgeTextEl.classList.add('show', kind);
  }

  function removeNote(note, cls, delay) {
    note.alive = false;
    const idx = state.notes.indexOf(note);
    if (idx !== -1) state.notes.splice(idx, 1);
    if (note.el) {
      note.el.classList.add(cls);
      const el = note.el;
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, delay);
    }
  }

  function updateHud() {
    scoreEl.textContent = state.score;
    comboEl.textContent = state.combo;
    accuracyEl.textContent = accuracyText();

    let hearts = '';
    for (let i = 0; i < MAX_LIFE; i++) {
      hearts += i < state.life
        ? '<span class="heart">&#9829;</span>'
        : '<span class="heart empty">&#9829;</span>';
    }
    lifeEl.innerHTML = hearts;
  }

  function accuracyText() {
    if (state.judged === 0) return '100.0%';
    return (state.accSum / state.judged * 100).toFixed(1) + '%';
  }

  function bumpCombo() {
    state.combo++;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
    comboEl.classList.remove('pulse');
    void comboEl.offsetWidth;
    comboEl.classList.add('pulse');
  }

  function judgeHit(note, diff) {
    const perfect = Math.abs(diff) <= W_PERFECT;
    const base = perfect ? 300 : 100;

    state.judged++;
    state.accSum += perfect ? 1 : 0.6;
    bumpCombo();
    state.score += Math.round(base * (1 + Math.min(state.combo, 50) * 0.02));

    removeNote(note, 'hit', 320);            // .hit → 핑크색으로 바뀌며 사라진다
    flashJudge(perfect ? 'PERFECT' : 'GOOD', perfect ? 'perfect' : 'good');
    (perfect ? sfx.perfect : sfx.good)();
    updateHud();
  }

  function judgeMiss(note) {
    state.judged++;
    state.combo = 0;
    state.life--;

    removeNote(note, 'miss', 440);
    flashJudge('MISS', 'miss');
    sfx.miss();
    updateHud();

    if (state.life <= 0) gameOver();
  }

  function pressLane(lane) {
    const t = now();
    let best = null;
    let bestDiff = Infinity;

    for (let i = 0; i < state.notes.length; i++) {
      const note = state.notes[i];
      if (note.lane !== lane || !note.alive) continue;
      const diff = note.hitTime - t;
      if (Math.abs(diff) < Math.abs(bestDiff)) {
        bestDiff = diff;
        best = note;
      }
    }

    if (best && Math.abs(bestDiff) <= W_GOOD) {
      judgeHit(best, bestDiff);
    }
  }

  // ===================== 메인 루프 =====================

  function loop() {
    if (!state.running || state.paused) return;
    const t = now();

    for (let i = state.notes.length - 1; i >= 0; i--) {
      const note = state.notes[i];
      const remaining = note.hitTime - t;

      if (remaining > APPROACH_SEC) continue;      // 아직 등장할 때가 아니다
      if (!note.el) spawnFrog(note);

      if (remaining < -W_MISS) {
        judgeMiss(note);
        if (state.over) break;
        continue;
      }

      const y = judgeY - remaining * pxPerSec - frogSize / 2;
      note.el.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
    }

    // judgeMiss가 게임오버를 부르면 루프를 다시 예약하지 않는다
    if (!state.running || state.paused) return;
    state.rafId = requestAnimationFrame(loop);
  }

  // ===================== 흐름 제어 =====================

  function clearFrogs() {
    for (let i = 0; i < frogCols.length; i++) frogCols[i].innerHTML = '';
  }

  function resetGame() {
    cancelAnimationFrame(state.rafId);
    clearInterval(state.schedulerId);
    clearFrogs();

    state.running = false;
    state.paused = false;
    state.over = false;
    state.score = 0;
    state.combo = 0;
    state.maxCombo = 0;
    state.life = MAX_LIFE;
    state.judged = 0;
    state.accSum = 0;
    state.notes = [];
    state.step = 0;
    state.lastLane = -1;
    state.laneRepeat = 0;

    judgeTextEl.className = '';
    judgeTextEl.textContent = '';
    updateHud();
  }

  function startGame() {
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    resetGame();
    measure();

    masterGain.gain.cancelScheduledValues(now());
    masterGain.gain.setValueAtTime(0.9, now());

    state.running = true;
    state.startTime = now() + 0.4;       // 시작 직후 살짝 여유
    state.nextStepTime = state.startTime;

    startOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');
    overOverlay.classList.add('hidden');

    state.schedulerId = setInterval(scheduler, SCHEDULER_MS);
    state.rafId = requestAnimationFrame(loop);
  }

  function pauseGame() {
    if (!state.running || state.paused || state.over) return;
    state.paused = true;
    state.pausedAt = now();

    cancelAnimationFrame(state.rafId);
    clearInterval(state.schedulerId);

    // 이미 예약된 비트가 새어 나오지 않도록 소리를 내린다
    masterGain.gain.cancelScheduledValues(now());
    masterGain.gain.setTargetAtTime(0.0001, now(), 0.02);

    pauseOverlay.classList.remove('hidden');
  }

  function resumeGame() {
    if (!state.running || !state.paused) return;

    // 멈춰 있던 만큼 모든 시각을 뒤로 민다
    const delta = now() - state.pausedAt;
    state.startTime += delta;
    state.nextStepTime += delta;
    for (let i = 0; i < state.notes.length; i++) state.notes[i].hitTime += delta;

    state.paused = false;
    pauseOverlay.classList.add('hidden');

    masterGain.gain.cancelScheduledValues(now());
    masterGain.gain.setTargetAtTime(0.9, now(), 0.02);

    state.schedulerId = setInterval(scheduler, SCHEDULER_MS);
    state.rafId = requestAnimationFrame(loop);
  }

  function gameOver() {
    state.running = false;
    state.over = true;
    cancelAnimationFrame(state.rafId);
    clearInterval(state.schedulerId);

    masterGain.gain.cancelScheduledValues(now());
    masterGain.gain.setTargetAtTime(0.0001, now(), 0.08);

    finalScoreEl.textContent = state.score;
    finalComboEl.textContent = state.maxCombo;
    finalAccuracyEl.textContent = accuracyText();
    overOverlay.classList.remove('hidden');
  }

  // ===================== 입력 =====================

  const heldKeys = new Set();

  window.addEventListener('keydown', function (e) {
    if (e.code === 'KeyR' && state.over) {
      startGame();
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (state.paused) resumeGame();
      else pauseGame();
      e.preventDefault();
      return;
    }

    const lane = LANE_KEYS.indexOf(e.code);
    if (lane === -1) return;
    e.preventDefault();
    if (e.repeat || heldKeys.has(e.code)) return;  // 꾹 누르고 있어도 한 번만
    heldKeys.add(e.code);

    laneEls[lane].classList.add('active');
    keyEls[lane].classList.add('active');

    if (state.running && !state.paused) pressLane(lane);
  });

  window.addEventListener('keyup', function (e) {
    const lane = LANE_KEYS.indexOf(e.code);
    if (lane === -1) return;
    heldKeys.delete(e.code);
    laneEls[lane].classList.remove('active');
    keyEls[lane].classList.remove('active');
  });

  window.addEventListener('blur', function () {
    heldKeys.clear();
    for (let i = 0; i < LANE_COUNT; i++) {
      laneEls[i].classList.remove('active');
      keyEls[i].classList.remove('active');
    }
    pauseGame();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseGame();
  });

  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);
  resumeBtn.addEventListener('click', resumeGame);

  // ===================== 시작 =====================

  measure();
  updateHud();
})();
