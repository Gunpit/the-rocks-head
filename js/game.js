// The Rock's Head — a wrestling boulder squash-'em-up.
// Plain canvas, no libraries. Open index.html in a browser to play.
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // World layout (logical pixels; the canvas is scaled to fit the window)
  // ---------------------------------------------------------------------------
  const W = 960, H = 540;
  const FLOOR = 430;                       // where feet and the rock's chin rest
  const MAT_BACK_Y = 300, MAT_FRONT_Y = 470;
  const BACK_POST_L = 230, BACK_POST_R = 730;
  const FRONT_POST_L = 110, FRONT_POST_R = 850;
  const ROCK_MIN_X = 190, ROCK_MAX_X = 770; // rock center limits (ropes)
  const HUM_MIN_X = 165, HUM_MAX_X = 795;   // human limits once inside the ring

  // ---------------------------------------------------------------------------
  // Tuning — tweak these to change how the game feels
  // ---------------------------------------------------------------------------
  const T = {
    gravity: 2600,
    chargeTime: 0.85,        // seconds to fill the jump meter
    jumpMin: 520,            // jump speed at zero charge
    jumpMax: 1260,           // jump speed at full charge (peaks just below the top of the screen)
    airSpeed: 330,           // sideways jump speed when the mouse is far to one side
    megaCharge: 0.95,        // charge needed for a MEGA SLAM
    slamRadiusMin: 48,
    slamRadiusMax: 125,
    matBounce: 0.32,         // how much the mat bounces the rock back up
    invuln: 1.5,
    lives: 3,
    hypePerSquash: 7,
    hypeDecay: 2.5,          // hype lost per second
    hypeDuration: 8,         // seconds of HYPE MODE
    // Score milestones make black ones faster and more common. The first comes at 2,000 points
    // and each gap is 1.5x the last: 2,000 / 5,000 / 9,500 / 16,250 / 26,375 ...
    blackFirstMilestone: 2000,
    blackMilestoneGrowth: 1.5,
    blackSpeedStep: 0.15,    // speed added per milestone
    blackWarning: 1.1,       // seconds of edge warning before a black one enters (divided by its speed-up)
    blackGapBase: 2.5,       // minimum seconds between black spawns...
    blackGapStep: 0.5,       // ...plus this much per milestone (faster but fewer)
    blackMaxLevel: 10,       // stops ramping here (2.5x speed)
    rockHeight: 110,
  };

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const FONT = "'Bangers', Impact, 'Arial Black', sans-serif";
  // index.html?debug — H: instant HYPE MODE, B: squash every yellow fan, N: send in a black one
  const DEBUG = /[?&]debug\b/.test(location.search);

  const rockImg = new Image();
  rockImg.src = 'img/rock.png';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // ---------------------------------------------------------------------------
  // Canvas scaling
  // ---------------------------------------------------------------------------
  let scale = 1;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = Math.floor(W * s) + 'px';
    canvas.style.height = Math.floor(H * s) + 'px';
    canvas.width = Math.round(W * s * dpr);
    canvas.height = Math.round(H * s * dpr);
    scale = s * dpr;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const keys = {};
  const CHARGE_KEYS = ['Space', 'ArrowUp', 'KeyW'];
  const GAME_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  let pressLatch = false;     // a charge press happened since last update
  let pointerDown = false;
  let pointerX = null;
  let usingPointer = false;

  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    if (CHARGE_KEYS.includes(e.code)) { pressLatch = true; usingPointer = false; }
    if (e.code === 'KeyM') toggleMute();
    if (DEBUG && e.code === 'KeyH' && state === 'play' && hypeMode <= 0) startHypeMode();
    if (DEBUG && e.code === 'KeyN' && state === 'play') spawnHuman(true);
    if (DEBUG && e.code === 'KeyB' && state === 'play') {
      humans.filter((h) => h.state === 'walk' && h.type === 'yellow').forEach((h, i) => squash(h, i, 1));
    }
    if ((e.code === 'KeyP' || e.code === 'Escape') && state === 'play') setPaused(!paused);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'play') setPaused(true);
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; pointerDown = false; });

  function toLogicalX(e) {
    const r = canvas.getBoundingClientRect();
    return (e.clientX - r.left) / r.width * W;
  }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerDown = true; usingPointer = true; pressLatch = true;
    pointerX = toLogicalX(e);
  });
  window.addEventListener('pointermove', (e) => { if (pointerDown) pointerX = toLogicalX(e); });
  window.addEventListener('pointerup', () => { pointerDown = false; });
  window.addEventListener('pointercancel', () => { pointerDown = false; });

  const chargeHeld = () => pointerDown || CHARGE_KEYS.some((k) => keys[k]);

  // ---------------------------------------------------------------------------
  // Sound (synthesised, no files needed)
  // ---------------------------------------------------------------------------
  let actx = null, master = null, muted = false;
  function audio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      master = actx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(actx.destination);
      RocksMusic.init(actx, master);
      Object.keys(VOICE_FILES).forEach(loadVoice);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  // "The Rock's Head!" voice clips. Downloaded right away; decoded once audio is unlocked.
  const VOICE_FILES = { start: 'rockshead1.wav', over: 'rockshead2.wav', hypeEnd: 'rockshead3.wav' };
  const voiceData = {}, voices = {};
  for (const [name, file] of Object.entries(VOICE_FILES)) {
    voiceData[name] = fetch(file).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  }
  function loadVoice(name) {
    if (!voices[name]) {
      voices[name] = voiceData[name]
        .then((data) => data && actx.decodeAudioData(data))
        .then((buffer) => {
          if (!buffer) return null;
          // Skip the leading silence and bring every clip to the same loudness
          const d = buffer.getChannelData(0);
          let peak = 0, first = 0;
          for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
          while (first < d.length && Math.abs(d[first]) < peak * 0.08) first++;
          return { buffer, offset: Math.max(0, first / buffer.sampleRate - 0.03), gain: peak ? 0.9 / peak : 1 };
        })
        .catch(() => null);
    }
    return voices[name];
  }
  // Which clips get the stadium-announcer treatment (game over stays dry)
  const VOICE_FX = { start: true, hypeEnd: true, over: false };
  const ANNOUNCER_TAIL = 1.4;            // seconds of reverb/echo after the voice ends
  // Random playback-rate range per clip, so repeats stay interesting (0.75-1.3 is about -5 to +4.5 semitones)
  const VOICE_PITCH = { hypeEnd: [0.75, 1.3] };

  // Announcer chain: PA-style EQ + compression, then dry + slapback echo + arena reverb
  let announcerIn = null;
  function announcerBus() {
    if (announcerIn) return announcerIn;
    const a = actx;
    announcerIn = a.createGain();
    const hp = a.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 160;
    const presence = a.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 2800; presence.Q.value = 0.9; presence.gain.value = 5;
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    announcerIn.connect(hp).connect(presence).connect(comp);

    const out = a.createGain();
    out.gain.value = 0.72;
    out.connect(master);
    comp.connect(out);                                   // dry

    // Slapback echo bouncing off the far side of the arena
    const delay = a.createDelay(1);
    delay.delayTime.value = 0.21;
    const fb = a.createGain();
    fb.gain.value = 0.32;
    const dlp = a.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = 2600;
    const echo = a.createGain();
    echo.gain.value = 0.38;
    comp.connect(delay).connect(dlp).connect(fb).connect(delay);
    dlp.connect(echo).connect(out);

    // Big-room reverb
    const len = Math.floor(a.sampleRate * 2.6);
    const ir = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const verb = a.createConvolver();
    verb.buffer = ir;
    const wet = a.createGain();
    wet.gain.value = 0.45;
    comp.connect(verb).connect(wet).connect(out);
    return announcerIn;
  }

  function playVoice(name) {
    const a = audio();
    if (!a) return;
    loadVoice(name).then((v) => {
      if (!v) return;
      const src = a.createBufferSource(), g = a.createGain();
      src.buffer = v.buffer;
      const range = VOICE_PITCH[name];
      const rate = range ? rand(range[0], range[1]) : 1;
      src.playbackRate.value = rate;
      g.gain.value = v.gain;
      src.connect(g).connect(VOICE_FX[name] ? announcerBus() : master);
      src.start(0, v.offset);
      RocksMusic.duck((v.buffer.duration - v.offset) / rate + (VOICE_FX[name] ? ANNOUNCER_TAIL * 0.5 : 0));
    });
  }

  function toggleMute() {
    muted = !muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 1, actx.currentTime, 0.02);
  }
  function setPaused(p) {
    paused = p;
    RocksMusic.setPaused(p);
  }
  function tone(f0, f1, dur, type = 'sine', vol = 0.3, delay = 0) {
    const a = audio(); if (!a || muted) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, vol = 0.3, cutoff = 800) {
    const a = audio(); if (!a || muted) return;
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = cutoff; g.gain.value = vol;
    src.connect(f).connect(g).connect(master);
    src.start();
  }
  const sfx = {
    jump: (c) => tone(160, 360 + 320 * c, 0.15, 'triangle', 0.15),
    slam: (p) => { tone(130, 32, 0.25 + 0.3 * p, 'sine', 0.5 + 0.35 * p); noise(0.2 + 0.25 * p, 0.25 + 0.3 * p, 450 + 900 * p); },
    squash: (i) => tone(520 + i * 90, 90, 0.13, 'square', 0.1, i * 0.05),
    hurt: () => { tone(240, 55, 0.4, 'sawtooth', 0.22); noise(0.15, 0.2, 1500); },
    ringOut: () => tone(300, 900, 0.25, 'triangle', 0.15),
    dodge: () => { tone(900, 300, 0.18, 'triangle', 0.12); noise(0.15, 0.08, 3000); },
    cheer: (v) => noise(0.6 + v * 0.6, 0.06 + 0.08 * v, 2600),
    shutter: () => { tone(2600, 1800, 0.02, 'square', 0.025); tone(1800, 1400, 0.03, 'square', 0.02, 0.05); },
  };

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  let state = 'title';        // 'title' | 'play' | 'over'
  let paused = false;
  let ignoreHold = false;     // swallow the press that started the game
  let time = 0, elapsed = 0, overTimer = 0;
  let score = 0, best = 0, lives = T.lives;
  let speedLevel = 0;         // score milestones reached
  let hype = 0, hypeMode = 0;
  let spawnTimer = 0;
  let shake = 0, hitstop = 0, cheer = 0;
  let flash = { a: 0, color: '#fff' };
  const mat = { x: W / 2, dip: 0, vel: 0 };
  let rock, humans, particles, texts;

  try { best = parseInt(localStorage.getItem('rockshead-best'), 10) || 0; } catch (e) { /* storage blocked */ }

  function newRock() {
    return {
      x: W / 2, y: FLOOR, vx: 0, vy: 0, grounded: true,
      charging: false, charge: 0, slamPending: false, slamPower: 0, mega: false,
      sq: 0, sqVel: 0, invuln: 0, bounceSafe: 0,
    };
  }
  rock = newRock(); humans = []; particles = []; texts = [];

  // Debug-only peek at live state, for automated playtests (index.html?debug)
  if (DEBUG) {
    window.__rocksDebug = {
      get state() { return state; }, get rock() { return rock; }, get humans() { return humans; },
      get score() { return score; }, get elapsed() { return elapsed; }, get lives() { return lives; },
      tick: (dt) => update(dt),            // step the simulation by hand (works even when the tab is hidden)
    };
  }

  function startGame() {
    state = 'play';
    setPaused(false);
    RocksMusic.stop();
    RocksMusic.start();
    playVoice('start');
    rock = newRock(); humans = []; particles = []; texts = []; splats = [];
    score = 0; lives = T.lives; hype = 0; hypeMode = 0; speedLevel = 0;
    elapsed = 0; spawnTimer = 0.6; shake = 0; hitstop = 0; lastBlackAt = -99;
    ignoreHold = true;
    addText(W / 2, 250, 'RING THE BELL!', '#ffd23f', 56, 1.4);
    sfx.cheer(1);
  }

  function gameOver() {
    state = 'over'; overTimer = 0;
    hypeMode = 0;
    RocksMusic.stop();
    if (score > best) {
      best = score;
      try { localStorage.setItem('rockshead-best', String(best)); } catch (e) { /* storage blocked */ }
    }
    playVoice('over');
  }

  // Difficulty ramps with time survived
  const spawnInterval = () => Math.max(0.5, 1.7 - elapsed * 0.012) * rand(0.7, 1.3);
  const blackChance = () => Math.min(0.4, 0.12 + elapsed * 0.004);
  // As they get faster they come less often: minimum seconds between black spawns
  const blackGap = () => T.blackGapBase + speedLevel * T.blackGapStep;
  let lastBlackAt = -99;
  const blackSpeed = () => 1 + speedLevel * T.blackSpeedStep;

  // How many milestones a score has passed
  function milestoneLevel(s) {
    let lvl = 0, gap = T.blackFirstMilestone, need = gap;
    while (s >= need && lvl < T.blackMaxLevel) {
      lvl++;
      gap *= T.blackMilestoneGrowth;
      need += gap;
    }
    return lvl;
  }

  // Score milestones crank up the black ones
  function checkMilestones() {
    const lvl = milestoneLevel(score);
    if (lvl <= speedLevel) return;
    const ratio = (1 + lvl * T.blackSpeedStep) / blackSpeed();
    speedLevel = lvl;
    for (const h of humans) if (h.type === 'black') h.speed *= ratio;   // the ones already in, too
    addText(W / 2, 200, lvl >= T.blackMaxLevel ? 'MAXIMUM CARNAGE!' : "THEY'RE GETTING FASTER!", '#ff3b3b', 40, 1.4);
  }
  const maxHumans = () => Math.min(16, 6 + elapsed / 10);
  const maxBlacks = () => Math.min(3, 1 + Math.floor(elapsed / 20));   // on screen at once

  // ---------------------------------------------------------------------------
  // Humans
  // ---------------------------------------------------------------------------
  function spawnHuman(forceBlack = false) {
    const fromLeft = Math.random() < 0.5;
    const blacksIn = humans.filter((h) => h.type === 'black' && !h.dead).length;
    const black = forceBlack ||
      (blacksIn < maxBlacks() && elapsed - lastBlackAt >= blackGap() && Math.random() < blackChance());
    if (black) lastBlackAt = elapsed;
    const h = {
      type: black ? 'black' : 'yellow',
      x: fromLeft ? -20 : W + 20, y: FLOOR, vx: 0, vy: 0,
      dir: fromLeft ? 1 : -1,
      // Black ones march straight across the ring and out the other side
      state: black ? 'march' : 'enter',
      speed: black ? rand(95, 130) * blackSpeed() : rand(45, 75),
      t: Math.random() * 10, think: rand(0.5, 2),
      rot: 0, rv: 0, flatT: 0, ringOutDone: false, dead: false,
      coward: !black && Math.random() < 1 / 7, scared: false,   // a few yellow fans still run
      passed: false, hitPlayer: false,
      // Black ones wait off-screen behind a warning arrow first (shorter as they get faster)
      warn: black ? Math.max(0.5, T.blackWarning / blackSpeed()) : 0,
      dropping: false,
    };
    if (!black) leapFromCrowd(h);
    humans.push(h);
  }

  // Yellow fans come out of the crowd: they stand up behind the barricade, climb onto the
  // rail, wave for a beat, then leap over the ropes and drop onto an open spot on the mat.
  const BARRICADE_Y = 230;                 // top rail of the crowd barricade
  const CLIMB_RISE = 0.35, CLIMB_TIME = 0.6;
  function leapFromCrowd(h) {
    let tx = rand(HUM_MIN_X + 30, HUM_MAX_X - 30);
    for (let k = 0; k < 8 && Math.abs(tx - rock.x) < 90; k++) tx = rand(HUM_MIN_X + 30, HUM_MAX_X - 30);
    h.state = 'climb';
    h.climbT = 0;
    h.x = clamp(tx + rand(-70, 70), 90, W - 90);
    h.y = BARRICADE_Y + 75;                // hidden behind the barricade
    h.landX = tx;
    h.dir = Math.sign(tx - h.x) || 1;
  }

  function launchFromRail(h) {
    const sy = BARRICADE_Y;
    const g = T.gravity * 0.8, vy0 = -rand(320, 420);
    const t = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * g * (FLOOR - sy))) / g;   // time to land on the mat
    h.state = 'air';
    h.y = sy;
    h.vx = (h.landX - h.x) / t; h.vy = vy0;
    h.rot = 0; h.rv = rand(-1.5, 1.5);       // a little flail, mostly upright
    h.dropping = true;
  }

  // Slam shockwave: nearby fans jump in fright and land where they were
  function hop(h, power) {
    h.state = 'air';
    h.vx = rand(-25, 25);
    h.vy = -rand(260, 380) * (0.6 + 0.6 * power);
    h.rot = 0; h.rv = 0;
    h.ringOutDone = false;
  }

  // A black one marched past the rock without touching it
  function dodged(h) {
    h.passed = true;
    const pts = 150 * (hypeMode > 0 ? 2 : 1);
    score += pts;
    if (hypeMode <= 0) {
      hype = Math.min(100, hype + 8);
      if (hype >= 100) startHypeMode();
    }
    addText(rock.x, rock.y - T.rockHeight - 40, 'DODGED! +' + pts, '#ff9f1c', 32);
    sfx.dodge();
    cheer += 0.4;
  }


  function squash(h, i, power = 0.5) {
    h.state = 'flat'; h.flatT = 0; h.rot = 0; h.pool = 0;
    const col = h.type === 'yellow' ? '#f5c518' : '#1a1a1a';
    for (let k = 0; k < 5; k++) {
      particles.push({
        kind: 'chip', x: h.x, y: FLOOR - 8, vx: rand(-260, 260), vy: rand(-420, -120),
        life: rand(0.4, 0.8), max: 0.8, size: rand(3, 6), color: col, grav: 1600,
      });
    }
    // Blood spray: droplets arc out and leave splats where they land
    const drops = 18 + Math.round(22 * power);
    for (let k = 0; k < drops; k++) {
      const big = Math.random() < 0.3;
      particles.push({
        kind: 'blood', x: h.x + rand(-8, 8), y: FLOOR - rand(4, 14),
        vx: rand(-1, 1) * (180 + 300 * power), vy: -rand(150, 420 + 300 * power),
        life: 3, max: 3, size: big ? rand(3.5, 5.5) : rand(1.5, 3.5), grav: 1500,
        land: FLOOR + rand(-6, 10), color: pick(BLOOD),
      });
    }
    addSplat(h.x, FLOOR + 3, rand(16, 22), pick(BLOOD), 6);
    sfx.squash(i);
  }

  // Blood stains on the mat
  const BLOOD = ['#b0001a', '#c4031f', '#8f0014'];
  let splats = [];
  function addSplat(x, y, r, color, life = 6) {
    splats.push({ x, y, r, color, life, max: life, seed: Math.random() * 10 });
    if (splats.length > 90) splats.shift();
  }

  function ringOut(h) {
    if (h.ringOutDone || h.type === 'black') return;
    h.ringOutDone = true;
    const pts = 50 * (hypeMode > 0 ? 2 : 1);
    score += pts;
    hype = Math.min(100, hype + 3);
    addText(clamp(h.x, 80, W - 80), FLOOR - 120, 'RING OUT! +' + pts, '#7fdbff', 30);
    sfx.ringOut();
    cheer += 0.3;
  }

  function updateHuman(h, dt) {
    h.t += dt;
    switch (h.state) {
      case 'enter': {
        h.x += h.dir * h.speed * dt;
        if (h.x > HUM_MIN_X && h.x < HUM_MAX_X) h.state = 'walk';
        break;
      }
      case 'march': {
        if (h.warn > 0) { h.warn -= dt; break; }
        // Black ones: straight line, steady pace, through the ring and out the far side
        h.x += h.dir * h.speed * dt;
        // No damage while coming down on them in HYPE MODE — the landing slam smashes them instead
        const smashing = hypeMode > 0 && !rock.grounded;
        if (!smashing && rock.invuln <= 0 && rock.bounceSafe <= 0 && Math.abs(rock.x - h.x) < 36 && rock.y > FLOOR - 45) {
          hurtPlayer(h);
          break;
        }
        if (!h.passed && !h.hitPlayer && (h.x - rock.x) * h.dir > 40) dodged(h);
        if (h.x < -40 || h.x > W + 40) h.dead = true;
        break;
      }
      case 'walk': {
        const dx = rock.x - h.x;
        // Yellow fans wander the ring. Cowards (about 1 in 7) run when the rock jumps or charges nearby.
        let speed = h.speed;
        h.think -= dt;
        h.scared = h.coward && ((!rock.grounded && Math.abs(dx) < 220) || (rock.charging && Math.abs(dx) < 150));
        if (h.scared) {
          h.dir = -(Math.sign(dx) || 1);
          speed *= 1.9;
        } else {
          if (h.think <= 0) {
            h.think = rand(0.7, 2);
            h.dir = Math.random() < 0.4 ? (Math.sign(dx) || 1) : pick([-1, 1]);
          }
          // Near the ropes: turn back toward the middle and commit to it for a bit,
          // so they don't pace back and forth at the turn-around line
          const edge = h.x < HUM_MIN_X + 80 ? 1 : h.x > HUM_MAX_X - 80 ? -1 : 0;
          if (edge && h.dir !== edge) {
            h.dir = edge;
            h.think = rand(1, 2.2);
          }
        }
        h.x += h.dir * speed * dt;
        if (h.x < HUM_MIN_X) { h.x = HUM_MIN_X; h.dir = 1; }
        if (h.x > HUM_MAX_X) { h.x = HUM_MAX_X; h.dir = -1; }
        break;
      }
      case 'climb': {
        h.climbT += dt;
        const p = Math.min(1, h.climbT / CLIMB_RISE);
        h.y = BARRICADE_Y + 75 * Math.pow(1 - p, 2);      // rise up onto the rail, easing in
        if (h.climbT >= CLIMB_TIME) launchFromRail(h);
        break;
      }
      case 'air': {
        h.vy += T.gravity * 0.8 * dt;
        h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.rv * dt;
        if (h.x < -60 || h.x > W + 60) { ringOut(h); h.dead = true; break; }
        if (h.y >= FLOOR && h.vy > 0) {
          h.y = FLOOR; h.vx = h.vy = 0; h.rot = 0;
          if (h.dropping) {
            // Thud onto the mat from the stands
            h.dropping = false;
            for (let k = 0; k < 6; k++) {
              particles.push({
                kind: 'dust', x: h.x + rand(-10, 10), y: FLOOR, vx: rand(-90, 90), vy: -rand(20, 80),
                life: rand(0.3, 0.5), max: 0.5, size: rand(3, 6), color: '200,190,170', grav: 200,
              });
            }
          }
          if (h.type === 'black') {
            h.state = 'march';                // shake it off and keep marching the same way
          } else if (h.x < HUM_MIN_X || h.x > HUM_MAX_X) {
            ringOut(h);
            h.state = 'enter'; h.dir = h.x < W / 2 ? 1 : -1;
          } else {
            h.state = 'walk';
          }
        }
        break;
      }
      case 'flat': {
        h.flatT += dt;
        h.pool = Math.min(30, h.pool + dt * 40 * Math.max(0.15, 1 - h.flatT / 1.2));   // spreads, then slows
        if (h.flatT > 2.5) {
          h.dead = true;
          addSplat(h.x + h.dir * 5, FLOOR + 3, h.pool, '#7d0012', 7);   // the pool stays as a stain
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The rock
  // ---------------------------------------------------------------------------
  // Launch toward the mouse (straight up without one). Once airborne there's no steering.
  function jump() {
    const c = rock.charge;
    rock.vy = -lerp(T.jumpMin, T.jumpMax, c);
    const aim = usingPointer && pointerX !== null ? clamp((pointerX - rock.x) / 200, -1, 1) : 0;
    rock.vx = aim * T.airSpeed * 0.8;
    rock.grounded = false;
    rock.charging = false;
    rock.slamPending = true;
    rock.slamPower = c;
    rock.mega = c >= T.megaCharge || hypeMode > 0;
    rock.charge = 0;
    rock.sqVel += 4;
    sfx.jump(c);
  }

  function land() {
    const impact = rock.vy;
    rock.y = FLOOR;
    if (rock.slamPending) {
      rock.slamPending = false;
      const power = rock.slamPower;
      const bounceDir = slam(power, rock.mega);
      if (bounceDir) {
        // Came down on a black one's head: boing off and over them, no damage either way
        rock.y = FLOOR - 1;
        rock.vy = -760;
        rock.vx = bounceDir * 300;
        rock.bounceSafe = 0.35;
        rock.sqVel -= 6;
        addText(rock.x, FLOOR - 150, 'BOING!', '#ffffff', 30, 0.7);
        sfx.jump(0.6);
        return;
      }
    }
    rock.sqVel -= Math.min(12, impact / 180);
    if (impact > 420) {
      rock.vy = -impact * T.matBounce;   // bouncy mat
    } else {
      rock.vy = 0;
      rock.grounded = true;
    }
  }

  function slam(power, mega) {
    const radius = mega ? T.slamRadiusMax * 1.25 : lerp(T.slamRadiusMin, T.slamRadiusMax, power);
    let squashed = 0, base = 0, bounceDir = 0;
    for (const h of humans) {
      if (h.state === 'flat' || h.state === 'air' || h.state === 'climb' || h.dead) continue;
      const dx = h.x - rock.x, d = Math.abs(dx);
      if (h.type === 'black') {
        // Black ones only go down to a HYPE MODE slam; otherwise they shrug it off
        if (hypeMode > 0 && d < radius) {
          squash(h, squashed, 1);
          squashed++;
          base += 300;
        } else if (d < 40) {
          bounceDir = -h.dir;               // landed on one: bounce back over it
        }
        continue;
      }
      if (d < radius) {
        squash(h, squashed, mega ? 1 : power);
        squashed++;
        base += 100;
      } else if (d < radius * 1.8 && power > 0.4) {
        hop(h, power);
      }
    }

    // Score and hype
    if (squashed > 0) {
      const mult = squashed * (hypeMode > 0 ? 2 : 1);
      const pts = base * mult;
      score += pts;
      const word = squashed === 1 ? 'SQUASH!' : squashed === 2 ? 'DOUBLE SQUASH!' :
        squashed === 3 ? 'TRIPLE SQUASH!' : squashed + 'x COMBO!!';
      addText(rock.x, FLOOR - 150, word, '#2ecc40', 34 + Math.min(squashed, 5) * 5);
      addText(rock.x, FLOOR - 112, '+' + pts + (mult > 1 ? '  (x' + mult + ')' : ''), '#ffffff', 26);
      if (hypeMode <= 0) {
        hype += squashed * T.hypePerSquash + (squashed - 1) * 5 + (mega ? 6 : 0);
        if (hype >= 100) startHypeMode();
      }
      cheer += 0.3 * squashed;
      if (squashed >= 3) sfx.cheer(1);
    }
    if (mega) addText(rock.x, FLOOR - 195, 'MEGA SLAM!', '#ff3b3b', 52);

    // Juice
    const n = 10 + 30 * power;
    for (let i = 0; i < n; i++) {
      particles.push({
        kind: 'dust', x: rock.x + rand(-30, 30), y: FLOOR, vx: rand(-1, 1) * (150 + 380 * power),
        vy: -rand(30, 220) * (0.5 + power), life: rand(0.4, 0.9), max: 0.9,
        size: rand(4, 10) * (1 + power), color: '200,190,170', grav: 250,
      });
    }
    for (let i = 0; i < 4 + 12 * power; i++) {
      particles.push({
        kind: 'chip', x: rock.x + rand(-25, 25), y: FLOOR - 10, vx: rand(-350, 350),
        vy: -rand(250, 700) * (0.4 + power), life: rand(0.5, 1), max: 1,
        size: rand(3, 7), color: pick(['#7d776a', '#5c574d', '#a39c8c']), grav: 1800,
      });
    }
    particles.push({ kind: 'ring', x: rock.x, y: FLOOR, r: 10, rmax: radius, life: 0.35, max: 0.35 });

    shake = Math.max(shake, 3 + 12 * power + (mega ? 10 : 0));
    hitstop = mega ? 0.09 : power > 0.6 ? 0.04 : 0;
    if (mega) flash = { a: 0.3, color: '#ffffff' };
    mat.x = rock.x;
    mat.vel += 250 + 650 * power;
    cheer += 0.2 + power * 0.5;
    sfx.slam(power);

    return bounceDir;
  }

  function startHypeMode() {
    hype = 100; hypeMode = T.hypeDuration;
    addText(W / 2, 200, 'HYPE MODE!', '#ffd23f', 70, 1.6);
    addText(W / 2, 245, 'EVERY SLAM IS A MEGA SLAM  •  DOUBLE POINTS', '#ffffff', 22, 1.6);
    flash = { a: 0.35, color: '#ffd23f' };
    sfx.cheer(1.5);
    RocksMusic.setHype(true);   // the theme handles the big entrance (glass shatter + full band)
    cheer += 2;
  }

  function hurtPlayer(h) {
    h.hitPlayer = true;
    lives--;
    rock.invuln = T.invuln;
    shake = Math.max(shake, 16);
    flash = { a: 0.45, color: '#ff2a2a' };
    sfx.hurt();
    // Knock the rock back over them (against their march) so they can't catch it again
    rock.vx = -h.dir * 300; rock.vy = -650; rock.grounded = false;
    rock.charging = false; rock.charge = 0; rock.slamPending = false;
    if (hypeMode <= 0) hype = Math.max(0, hype - 25);
    addText(rock.x, FLOOR - 150, lives > 0 ? 'OUCH!' : 'K.O.!', '#ff4040', 46);
    if (lives <= 0) gameOver();
  }

  function updateRock(dt) {
    // Charge and jump. No walking: the only way to move is to jump.
    const held = chargeHeld();
    if (ignoreHold) {
      pressLatch = false;
      if (!held) ignoreHold = false;
    } else {
      if ((pressLatch || held) && rock.grounded) rock.charging = true;
      pressLatch = false;
      if (rock.charging) {
        if (held) rock.charge = Math.min(1, rock.charge + dt / T.chargeTime);
        else jump();
      }
    }
    if (rock.grounded) rock.vx = 0;

    // Physics
    if (!rock.grounded) rock.vy += T.gravity * dt;
    rock.x += rock.vx * dt;
    rock.y += rock.vy * dt;
    if (rock.x < ROCK_MIN_X) { rock.x = ROCK_MIN_X; if (!rock.grounded) rock.vx = Math.abs(rock.vx) * 0.6; }
    if (rock.x > ROCK_MAX_X) { rock.x = ROCK_MAX_X; if (!rock.grounded) rock.vx = -Math.abs(rock.vx) * 0.6; }
    if (!rock.grounded && rock.y >= FLOOR && rock.vy > 0) land();

    // Squash & stretch spring
    const target = rock.charging ? -0.22 * rock.charge : 0;
    rock.sqVel += ((target - rock.sq) * 320 - rock.sqVel * 14) * dt;
    rock.sq = clamp(rock.sq + rock.sqVel * dt, -0.45, 0.4);

    if (rock.invuln > 0) rock.invuln -= dt;
    if (rock.bounceSafe > 0) rock.bounceSafe -= dt;
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  function addText(x, y, text, color, size, life = 1.1) {
    texts.push({ x, y, text, color, size, life, max: life });
  }

  function updateEffects(dt) {
    updateCrowd(dt);
    for (const p of particles) {
      p.life -= dt;
      if (p.kind === 'ring') { p.r = lerp(p.rmax, 10, p.life / p.max); continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'dust') { p.vx *= 1 - 3 * dt; p.size += 12 * dt; }
      if (p.kind === 'chip' && p.y > FLOOR + 6) { p.y = FLOOR + 6; p.vy *= -0.3; p.vx *= 0.6; }
      if (p.kind === 'blood' && p.vy > 0 && p.y >= p.land) {
        addSplat(p.x, p.land, p.size * rand(1.4, 2.4), p.color, rand(4, 6));
        p.life = 0;
      }
    }
    particles = particles.filter((p) => p.life > 0);
    for (const s of splats) s.life -= dt;
    splats = splats.filter((s) => s.life > 0);
    for (const t of texts) { t.life -= dt; t.y -= 30 * dt; }
    texts = texts.filter((t) => t.life > 0);

    shake *= Math.pow(0.002, dt);
    if (shake < 0.2) shake = 0;
    flash.a = Math.max(0, flash.a - dt * 1.8);
    cheer = Math.max(0, cheer - dt * 0.9);

    // Mat spring (positive dip = pushed down)
    mat.vel += (-180 * mat.dip - 9 * mat.vel) * dt;
    mat.dip += mat.vel * dt;
  }

  const dipAt = (x) => mat.dip * Math.max(0, 1 - Math.abs(x - mat.x) / 220);

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------
  function update(dt) {
    time += dt;

    if (state !== 'play') {
      if (state === 'over') overTimer += dt;
      if (pressLatch) {
        pressLatch = false;
        if (state === 'title' || overTimer > 0.8) { audio(); startGame(); }
      }
      for (const h of humans) if (h.state === 'air' || h.state === 'flat') updateHuman(h, dt);
      humans = humans.filter((h) => !h.dead);
      updateEffects(dt);
      return;
    }
    if (paused) { pressLatch = false; return; }

    if (hitstop > 0) { hitstop -= dt; updateEffects(dt * 0.2); return; }

    elapsed += dt;
    updateRock(dt);
    if (state !== 'play') return;   // the rock just got K.O.'d
    for (const h of humans) updateHuman(h, dt);
    humans = humans.filter((h) => !h.dead);
    if (state !== 'play') return;
    checkMilestones();

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = spawnInterval();
      const active = humans.filter((h) => h.state !== 'flat').length;
      if (active < maxHumans()) spawnHuman();
    }

    if (hypeMode > 0) {
      hypeMode -= dt;
      hype = 100 * Math.max(0, hypeMode) / T.hypeDuration;
      if (Math.random() < dt * 40) {
        particles.push({
          kind: 'chip', x: rand(0, W), y: -10, vx: rand(-40, 40), vy: rand(60, 160),
          life: 3, max: 3, size: rand(4, 7), color: pick(['#e8202a', '#ffffff', '#1aa3e8', '#ffd23f']), grav: 60,
        });
      }
      if (hypeMode <= 0) { hypeMode = 0; hype = 0; RocksMusic.setHype(false); playVoice('hypeEnd'); }
    } else {
      hype = Math.max(0, hype - T.hypeDecay * dt);
    }

    updateEffects(dt);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  const crowd = [];
  const SIGNS = ['ROCK!', '10/10', 'USA!', 'SQUASH!', 'GOAT', 'BOULDER!', 'HYPE!', 'ROCK ON'];
  (function buildCrowd() {
    const colors = ['#9a9a9a', '#bdbdbd', '#a0673a', '#8a8a8a', '#b07a4b'];
    for (let row = 0; row < 5; row++) {
      for (let x = 72 + (row % 2) * 16; x < 890; x += rand(30, 40)) {
        const r = Math.random();
        crowd.push({
          x: x + rand(-5, 5), y: 70 + row * 34, rx: rand(11, 14), ry: rand(14, 19),
          color: pick(colors), phase: rand(0, Math.PI * 2), speed: rand(5, 9), waver: Math.random() < 0.6,
          // What they whip out when HYPE MODE hits
          prop: r < 0.4 ? 'phone' : r < 0.5 ? 'sign' : null,
          sign: pick(SIGNS), side: Math.random() < 0.5 ? -1 : 1,
        });
      }
    }
  })();
  const phoneFans = crowd.filter((c) => c.prop === 'phone');
  let photoFlashes = [];

  // Camera flashes pop off in the stands — constantly in HYPE MODE, now and then after big slams
  function updateCrowd(dt) {
    const rate = hypeMode > 0 ? 16 : cheer > 1 ? 3 : 0;
    if (Math.random() < rate * dt) {
      const c = hypeMode > 0 ? pick(phoneFans) : pick(crowd);
      const x = hypeMode > 0 ? c.x + c.side * (c.rx + 9) : c.x + rand(-8, 8);
      const y = hypeMode > 0 ? c.y - c.ry - 22 : c.y - rand(0, 10);
      photoFlashes.push({ x, y, life: 0.2, max: 0.2, size: rand(0.8, 1.3) });
      if (Math.random() < 0.35) sfx.shutter();
    }
    for (const f of photoFlashes) f.life -= dt;
    photoFlashes = photoFlashes.filter((f) => f.life > 0);
  }

  function drawArena() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d1024');
    g.addColorStop(1, '#1d1230');
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, W + 80, H + 80);

    // Stands
    ctx.fillStyle = '#16131f';
    ctx.fillRect(56, 30, 848, 210);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeRect(56, 30, 848, 210);

    // Arena floor
    ctx.fillStyle = '#121019';
    ctx.fillRect(-40, MAT_BACK_Y - 20, W + 80, H);
  }

  function drawCrowd() {
    const crazy = hypeMode > 0;
    const energy = 1.5 + hype * 0.05 + cheer * 5 + (crazy ? 7 : 0);
    const armsUp = cheer > 0.4 || crazy;
    ctx.save();
    ctx.beginPath();
    ctx.rect(58, 32, 844, 206);
    ctx.clip();
    ctx.lineCap = 'round';
    for (const c of crowd) {
      const speed = c.speed * (crazy ? 1.7 : 1);
      const bob = Math.abs(Math.sin(time * speed + c.phase)) * energy;
      const sway = crazy ? Math.sin(time * speed * 0.5 + c.phase) * 4 : 0;
      const x = c.x + sway, y = c.y - bob;
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.ellipse(x, y, c.rx, c.ry, sway * 0.03, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 3;
      const wob = Math.sin(time * speed * 1.3 + c.phase) * 6;
      if (crazy && c.prop === 'sign') {
        // Both arms up holding a sign over their head
        const sy = y - c.ry - 34 + wob * 0.4;
        ctx.beginPath();
        ctx.moveTo(x - c.rx + 2, y + 4); ctx.lineTo(x - 18, sy + 18);
        ctx.moveTo(x + c.rx - 2, y + 4); ctx.lineTo(x + 18, sy + 18);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 27, sy, 54, 21);
        ctx.strokeRect(x - 27, sy, 54, 21);
        ctx.fillStyle = c.phase > 3 ? '#e8202a' : '#1a5fd0';
        ctx.font = `15px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.sign, x, sy + 11.5);
      } else if (crazy && c.prop === 'phone') {
        // One arm up filming / snapping photos, the other pumping
        const px = x + c.side * (c.rx + 9), py = y - c.ry - 22;
        ctx.beginPath();
        ctx.moveTo(x + c.side * (c.rx - 2), y + 4); ctx.lineTo(px, py + 8);
        ctx.moveTo(x - c.side * (c.rx - 2), y + 4); ctx.lineTo(x - c.side * (c.rx + 6) + wob, y - 26);
        ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.fillRect(px - 5, py - 8, 10, 16);
        ctx.fillStyle = '#9fe8ff';
        ctx.fillRect(px - 3.5, py - 6.5, 7, 12);
      } else if (c.waver || crazy) {
        const lift = armsUp ? 26 : 10;
        ctx.beginPath();
        ctx.moveTo(x - c.rx + 2, y + 4);
        ctx.lineTo(x - c.rx - 6 + wob, y - lift);
        ctx.moveTo(x + c.rx - 2, y + 4);
        ctx.lineTo(x + c.rx + 6 - wob, y - lift);
        ctx.stroke();
      }
    }

    // Camera flashes
    for (const f of photoFlashes) {
      const a = f.life / f.max, r = 30 * f.size;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.3, `rgba(255,255,240,${0.6 * a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 2;
      const l = 20 * f.size;
      ctx.beginPath();
      ctx.moveTo(f.x - l, f.y); ctx.lineTo(f.x + l, f.y);
      ctx.moveTo(f.x, f.y - l); ctx.lineTo(f.x, f.y + l);
      ctx.stroke();
    }
    ctx.restore();

    // Spotlights
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beams = hypeMode > 0 ? ['255,60,60', '60,160,255', '255,220,80'] : ['255,255,230', '255,255,230'];
    beams.forEach((col, i) => {
      const sx = (W / (beams.length + 1)) * (i + 1) + Math.sin(time * 0.7 + i * 2) * 120;
      const tx = rock.x + Math.sin(time * 1.3 + i) * 60;
      const grd = ctx.createLinearGradient(0, 0, 0, FLOOR);
      grd.addColorStop(0, `rgba(${col},0.10)`);
      grd.addColorStop(1, `rgba(${col},0.02)`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(sx - 10, -10);
      ctx.lineTo(sx + 10, -10);
      ctx.lineTo(tx + 110, FLOOR + 20);
      ctx.lineTo(tx - 110, FLOOR + 20);
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
  }

  function rope(x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1 - 1.5); ctx.lineTo(x2, y2 - 1.5); ctx.stroke();
  }

  const ROPE_COLORS = ['#e8202a', '#1aa3e8', '#e8202a'];
  const ROPE_LEVELS = [0.3, 0.6, 0.9];
  const backPostTop = MAT_BACK_Y - 130, frontPostTop = MAT_FRONT_Y - 175;

  function drawRingBack() {
    // Back ropes
    ROPE_LEVELS.forEach((f, i) => {
      const y = MAT_BACK_Y - 130 * f;
      rope(BACK_POST_L, y, BACK_POST_R, y, ROPE_COLORS[i]);
    });
    // Back posts
    ctx.fillStyle = '#c9c9c9';
    ctx.fillRect(BACK_POST_L - 4, backPostTop, 8, MAT_BACK_Y - backPostTop);
    ctx.fillRect(BACK_POST_R - 4, backPostTop, 8, MAT_BACK_Y - backPostTop);

    // Mat
    ctx.fillStyle = '#e4e7ee';
    ctx.beginPath();
    ctx.moveTo(BACK_POST_L, MAT_BACK_Y);
    ctx.lineTo(BACK_POST_R, MAT_BACK_Y);
    ctx.lineTo(FRONT_POST_R, MAT_FRONT_Y);
    ctx.lineTo(FRONT_POST_L, MAT_FRONT_Y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#11131a';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Centre logo
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#1aa3e8';
    ctx.beginPath();
    ctx.ellipse(W / 2, 385, 150, 42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#e8202a';
    ctx.font = `44px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText("THE ROCK'S HEAD", W / 2, 388);
    ctx.restore();

    // Dent where the rock last slammed
    const d = Math.max(0, mat.dip);
    if (d > 0.3) {
      ctx.fillStyle = `rgba(20,20,40,${Math.min(0.3, d * 0.02)})`;
      ctx.beginPath();
      ctx.ellipse(mat.x, FLOOR + 4, 70 + d * 4, 6 + d * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Side ropes, back post to front post
    ROPE_LEVELS.forEach((f, i) => {
      rope(BACK_POST_L, MAT_BACK_Y - 130 * f, FRONT_POST_L, MAT_FRONT_Y - 175 * f, ROPE_COLORS[i]);
      rope(BACK_POST_R, MAT_BACK_Y - 130 * f, FRONT_POST_R, MAT_FRONT_Y - 175 * f, ROPE_COLORS[i]);
    });
  }

  function drawRingFront() {
    // Apron
    ctx.fillStyle = '#0f1630';
    ctx.fillRect(FRONT_POST_L, MAT_FRONT_Y, FRONT_POST_R - FRONT_POST_L, H - MAT_FRONT_Y + 40);
    ctx.font = `76px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    [['U', '#1aa3e8', -110], ['S', '#e8202a', 0], ['A', '#bdbdbd', 110]].forEach(([ch, col, dx]) => {
      ctx.fillStyle = col;
      ctx.fillText(ch, W / 2 + dx, 540);
    });
    // Front posts
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(FRONT_POST_L - 5, frontPostTop, 10, H - frontPostTop + 40);
    ctx.fillRect(FRONT_POST_R - 5, frontPostTop, 10, H - frontPostTop + 40);
    ctx.fillStyle = '#e8202a';
    ctx.fillRect(FRONT_POST_L - 7, frontPostTop - 4, 14, 14);
    ctx.fillRect(FRONT_POST_R - 7, frontPostTop - 4, 14, 14);
  }

  function drawHuman(h) {
    const yellow = h.type === 'yellow';
    const col = yellow ? '#f5c518' : '#111';
    const y = h.state === 'air' || h.state === 'climb' ? h.y : h.y + dipAt(h.x);
    ctx.save();
    ctx.translate(h.x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (h.state === 'flat') {
      // Pool spreading out from under the body
      if (h.pool > 0) {
        ctx.fillStyle = '#7d0012';
        ctx.beginPath();
        ctx.ellipse(h.dir * 5, 3, h.pool * 1.6, h.pool * 0.32 + 1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,90,90,0.35)';
        ctx.beginPath();
        ctx.ellipse(h.dir * 5 - h.pool * 0.4, 2, h.pool * 0.5, h.pool * 0.08 + 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = Math.min(1, (2.5 - h.flatT) * 2);
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(h.dir * 22, -3, 13, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(h.dir * 10, -2); ctx.lineTo(-h.dir * 10, -2);
      ctx.moveTo(-h.dir * 10, -2); ctx.lineTo(-h.dir * 24, -6);
      ctx.moveTo(-h.dir * 10, -2); ctx.lineTo(-h.dir * 22, 2);
      ctx.moveTo(h.dir * 4, -2); ctx.lineTo(h.dir * 8, -12);
      ctx.moveTo(h.dir * 4, -2); ctx.lineTo(h.dir * 12, 6);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (h.state === 'air') {
      ctx.translate(0, -32);
      ctx.rotate(h.rot);
      ctx.translate(0, 32);
    }
    if (!yellow) {
      ctx.scale(1.08, 1.08);
      // Red glow so they read against the dark arena outside the ring; fades out as they step in
      const outside = clamp(Math.max(HUM_MIN_X - h.x, h.x - HUM_MAX_X) / 40, 0, 1);
      if (outside > 0) {
        ctx.shadowColor = `rgba(255, 40, 40, ${0.95 * outside})`;
        ctx.shadowBlur = 10;
      }
    }

    // Waving on the rail and flailing on the way down; otherwise a walk cycle
    const flail = h.state === 'climb' || (h.state === 'air' && h.dropping);
    const pace = flail ? Math.sin(time * 16 + h.t * 3)
      : h.state === 'air' ? 0 : Math.sin(h.t * 12 * (h.speed / 60) * (h.scared ? 1.8 : 1));
    ctx.strokeStyle = col;
    ctx.lineWidth = 4;
    ctx.beginPath();
    // legs
    ctx.moveTo(0, -22); ctx.lineTo(9 * pace, 0);
    ctx.moveTo(0, -22); ctx.lineTo(-9 * pace, 0);
    // body
    ctx.moveTo(0, -22); ctx.lineTo(0, -42);
    // arms
    if (h.state === 'air' || h.state === 'climb' || h.scared) {
      const wave = flail ? 7 : 3;
      ctx.moveTo(0, -38); ctx.lineTo(-11, -56 + pace * wave);
      ctx.moveTo(0, -38); ctx.lineTo(11, -56 - pace * wave);
    } else if (!yellow) {
      ctx.moveTo(0, -38); ctx.lineTo(h.dir * 18, -40 + pace * 2);
      ctx.moveTo(0, -38); ctx.lineTo(h.dir * 16, -34 - pace * 2);
    } else {
      ctx.moveTo(0, -38); ctx.lineTo(-10 * pace, -26);
      ctx.moveTo(0, -38); ctx.lineTo(10 * pace, -26);
    }
    ctx.stroke();

    // head
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(0, -53, 10, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    if (yellow) {
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // angry eyes
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(h.dir * 1, -57); ctx.lineTo(h.dir * 6, -55);
      ctx.moveTo(h.dir * 4, -58); ctx.lineTo(h.dir * 8, -57);
      ctx.stroke();
    }
    ctx.restore();

    if (h.scared && h.state === 'walk') {
      ctx.fillStyle = '#ffffff';
      ctx.font = `20px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('!', h.x, y - 72);
    }
  }

  function drawRock() {
    const height = FLOOR - rock.y;
    // Shadow
    const s = Math.max(0.3, 1 - height / 500);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * s})`;
    ctx.beginPath();
    ctx.ellipse(rock.x, FLOOR + 2 + dipAt(rock.x), 44 * s, 8 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    if (!rockImg.complete || !rockImg.naturalWidth) return;
    const h = T.rockHeight;
    const w = h * rockImg.naturalWidth / rockImg.naturalHeight;
    const sy = 1 + rock.sq, sx = 1 - rock.sq * 0.7;
    let jx = 0;
    if (rock.charging && rock.charge > 0.6) jx = (Math.random() - 0.5) * 4 * rock.charge;

    ctx.save();
    if (rock.invuln > 0 && Math.floor(time * 16) % 2 === 0) ctx.globalAlpha = 0.35;
    ctx.translate(rock.x + jx, rock.y + (rock.grounded ? dipAt(rock.x) : 0));
    if (!rock.grounded) ctx.rotate(clamp(rock.vx * 0.0006, -0.3, 0.3));
    ctx.scale(sx, sy);
    if (hypeMode > 0 || (rock.charging && rock.charge >= T.megaCharge)) {
      ctx.shadowColor = hypeMode > 0 ? '#ffd23f' : '#ff3b3b';
      ctx.shadowBlur = 25 + Math.sin(time * 20) * 8;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(rockImg, -w / 2, -h, w, h);
    ctx.restore();

    // Jump charge meter
    if (rock.charging) {
      const mx = rock.x + w / 2 + 14, my = rock.y - h + 10, mh = 80;
      const mega = rock.charge >= T.megaCharge;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx - 2, my - 2, 16, mh + 4);
      ctx.fillStyle = '#222';
      ctx.fillRect(mx, my, 12, mh);
      ctx.fillStyle = mega ? (Math.floor(time * 12) % 2 ? '#ff3b3b' : '#ffd23f')
        : rock.charge > 0.6 ? '#ffd23f' : '#2ecc40';
      ctx.fillRect(mx, my + mh * (1 - rock.charge), 12, mh * rock.charge);
      if (mega) {
        ctx.font = `20px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ff3b3b';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.strokeText('MEGA!', mx + 18, my + 14);
        ctx.fillText('MEGA!', mx + 18, my + 14);
      }
    }
  }

  // Fans climbing out of the crowd: only the part above the barricade rail shows
  function drawClimbers() {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-40, -40, W + 80, BARRICADE_Y + 41);
    ctx.clip();
    for (const h of humans) if (h.state === 'climb') drawHuman(h);
    ctx.restore();
  }

  // Padded crowd barricade along the front of the stands
  function drawBarricade() {
    const top = BARRICADE_Y, x0 = 56, x1 = 904;
    ctx.fillStyle = '#20263f';
    ctx.fillRect(x0, top, x1 - x0, 16);
    ctx.fillStyle = '#2c3456';
    for (let x = x0 + 10; x < x1 - 10; x += 44) ctx.fillRect(x, top + 3, 36, 10);   // padded panels
    ctx.strokeStyle = '#aeb6c8';                                                       // steel top rail
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, top); ctx.lineTo(x1, top);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, top, x1 - x0, 16);
  }

  // Shadow on the mat under a falling fan, growing as they get closer to landing
  function drawDropShadows() {
    for (const h of humans) {
      if (h.state !== 'air' || !h.dropping) continue;
      const p = clamp((h.y - BARRICADE_Y) / (FLOOR - BARRICADE_Y), 0, 1);
      ctx.fillStyle = `rgba(0, 0, 0, ${0.1 + 0.25 * p})`;
      ctx.beginPath();
      ctx.ellipse(h.landX, FLOOR + 2, 6 + 14 * p, 2 + 3 * p, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Flashing arrows at the screen edge while a black one waits to come in
  function drawWarnings() {
    for (const h of humans) {
      if (h.type !== 'black' || h.state !== 'march' || h.warn <= 0) continue;
      if (Math.floor(time * 10) % 2) continue;      // flash
      const x = h.dir > 0 ? 34 : W - 34, y = FLOOR - 45;
      const pulse = 1 + 0.15 * Math.sin(time * 20);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(h.dir * pulse, pulse);              // arrow points into the ring
      ctx.beginPath();
      ctx.moveTo(-14, -26); ctx.lineTo(18, 0); ctx.lineTo(-14, 26); ctx.lineTo(-6, 0);
      ctx.closePath();
      ctx.fillStyle = '#ff2a2a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      outlinedText('!', x, y - 44, 34, '#ff2a2a', 'center', 5);
    }
  }

  // Flattened for the mat's perspective, with a few satellite drips so they don't look like dots
  function drawSplats() {
    for (const s of splats) {
      ctx.globalAlpha = Math.min(1, s.life / 1.5) * 0.9;
      ctx.fillStyle = s.color;
      const y = s.y + dipAt(s.x);
      ctx.beginPath();
      ctx.ellipse(s.x, y, s.r, s.r * 0.28 + 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 4) {
        for (let k = 0; k < 3; k++) {
          const a = s.seed + k * 2.1;
          const d = s.r * (1.1 + 0.3 * Math.sin(a * 3));
          const br = s.r * 0.22 * (1 + 0.4 * Math.cos(a * 5));
          ctx.beginPath();
          ctx.ellipse(s.x + Math.cos(a) * d, y + Math.sin(a) * d * 0.28, br, br * 0.35 + 0.4, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const p of particles) {
      const a = Math.max(0, p.life / p.max);
      if (p.kind === 'dust') {
        ctx.fillStyle = `rgba(${p.color},${0.6 * a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'blood') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * 0.8, p.size * (1 + Math.min(1, Math.abs(p.vy) / 600)), Math.atan2(p.vy, p.vx) - Math.PI / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'chip') {
        ctx.globalAlpha = Math.min(1, a * 2);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      } else if (p.kind === 'ring') {
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * a})`;
        ctx.lineWidth = 4 * a + 1;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r, p.r * 0.18, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function outlinedText(text, x, y, size, color, align = 'center', stroke = 6) {
    ctx.font = `${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = stroke;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function drawTexts() {
    for (const t of texts) {
      const age = t.max - t.life;
      const pop = 1 + Math.max(0, 0.25 - age) * 2;
      ctx.globalAlpha = Math.min(1, t.life * 3);
      outlinedText(t.text, clamp(t.x, 120, W - 120), t.y, t.size * pop, t.color);
      ctx.globalAlpha = 1;
    }
  }

  function drawHUD() {
    // Score box
    ctx.fillStyle = '#1aa3e8';
    ctx.fillRect(16, 12, 200, 58);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeRect(16, 12, 200, 58);
    outlinedText('SCORE', 28, 26, 18, '#ffd23f', 'left', 4);
    outlinedText(score.toLocaleString(), 28, 52, 32, '#ffd23f', 'left', 5);
    outlinedText('BEST ' + best.toLocaleString(), 22, 86, 16, '#cfd8ff', 'left', 4);

    // Lives
    if (rockImg.complete && rockImg.naturalWidth) {
      const lh = 34, lw = lh * rockImg.naturalWidth / rockImg.naturalHeight;
      for (let i = 0; i < T.lives; i++) {
        ctx.globalAlpha = i < lives ? 1 : 0.18;
        ctx.drawImage(rockImg, W - 24 - (i + 1) * (lw + 8), 16, lw, lh);
      }
      ctx.globalAlpha = 1;
    }

    // Hype meter
    const hx = 16, hy = 492, hw = 280, hh = 36;
    const banner = () => {
      ctx.beginPath();
      ctx.moveTo(hx + 8, hy); ctx.lineTo(hx + hw, hy); ctx.lineTo(hx + hw + 10, hy + hh / 2);
      ctx.lineTo(hx + hw, hy + hh); ctx.lineTo(hx + 8, hy + hh); ctx.lineTo(hx, hy + hh / 2);
      ctx.closePath();
    };
    banner();
    ctx.fillStyle = '#4a0b0b';
    ctx.fill();
    ctx.save();
    banner();
    ctx.clip();
    const pulse = hypeMode > 0 ? `hsl(${(time * 360) % 360},90%,55%)` : '#e8202a';
    ctx.fillStyle = pulse;
    ctx.fillRect(hx, hy, (hw + 10) * (hype / 100), hh);
    ctx.restore();
    banner();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();
    outlinedText(hypeMode > 0 ? 'HYPE MODE!  x2' : 'HYPE METER', hx + hw / 2 + 4, hy + hh / 2 + 1, 24, '#ffd23f', 'center', 4);

    outlinedText('M mute  •  P pause', W - 14, H - 14, 14, 'rgba(255,255,255,0.6)', 'right', 3);
  }

  function drawOverlay() {
    if (state === 'play' && !paused) return;
    ctx.fillStyle = 'rgba(5,5,15,0.62)';
    ctx.fillRect(0, 0, W, H);

    if (state === 'title') {
      const bob = Math.sin(time * 3) * 4;
      outlinedText("THE ROCK'S HEAD", W / 2, 120 + bob, 84, '#ffd23f', 'center', 10);
      outlinedText('BOULDER WRESTLING CHAMPIONSHIP 3000', W / 2, 180, 28, '#e8202a', 'center', 6);
      const lines = [
        ['HOLD  SPACE  or  CLICK  to charge  —  RELEASE to jump', '#ffffff'],
        ['You jump toward the mouse  —  no moving on the ground, no steering in the air', '#ffffff'],
        ['SQUASH the yellow fans for points', '#f5c518'],
        ['BLACK ones march straight through — JUMP to dodge them (only HYPE slams crush them)', '#ff6b6b'],
        ['Squash to fill the HYPE METER', '#7fdbff'],
      ];
      lines.forEach(([t, c], i) => outlinedText(t, W / 2, 250 + i * 36, 24, c, 'center', 5));
      if (Math.floor(time * 2) % 2 === 0) outlinedText('PRESS SPACE OR CLICK TO ENTER THE RING', W / 2, 460, 30, '#2ecc40', 'center', 6);
    } else if (state === 'over') {
      outlinedText('DOWN FOR THE COUNT!', W / 2, 160, 72, '#e8202a', 'center', 10);
      outlinedText('SCORE  ' + score.toLocaleString(), W / 2, 250, 44, '#ffd23f', 'center', 8);
      outlinedText(score >= best && score > 0 ? 'NEW BEST!' : 'BEST  ' + best.toLocaleString(), W / 2, 305, 30, '#7fdbff', 'center', 6);
      if (overTimer > 0.8 && Math.floor(time * 2) % 2 === 0) {
        outlinedText('PRESS SPACE OR CLICK FOR A REMATCH', W / 2, 400, 30, '#2ecc40', 'center', 6);
      }
    } else if (paused) {
      outlinedText('PAUSED', W / 2, H / 2 - 20, 80, '#ffd23f', 'center', 10);
      outlinedText('press P to resume', W / 2, H / 2 + 40, 26, '#ffffff', 'center', 5);
    }
  }

  function render() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.save();
    if (shake > 0) ctx.translate(rand(-1, 1) * shake, rand(-1, 1) * shake);
    drawArena();
    drawCrowd();
    drawClimbers();
    drawBarricade();
    drawRingBack();
    drawSplats();
    drawDropShadows();
    for (const h of humans) if (h.state === 'flat') drawHuman(h);
    for (const h of humans) if (h.state !== 'flat' && h.state !== 'air' && h.state !== 'climb') drawHuman(h);
    if (state === 'play' || state === 'over') drawRock();
    for (const h of humans) if (h.state === 'air') drawHuman(h);
    drawRingFront();
    drawParticles();
    drawWarnings();
    drawTexts();
    ctx.restore();

    if (flash.a > 0) {
      ctx.globalAlpha = flash.a;
      ctx.fillStyle = flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    if (state !== 'title') drawHUD();
    drawOverlay();
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
