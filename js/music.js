// Theme song for The Rock's Head: loops wrasslin.wav.
// HYPE MODE boosts the track in place (wherever it is in the loop): louder, punchier lows,
// brighter highs, parallel saturation, glass shatter and a crowd roar on top.
window.RocksMusic = (() => {
  'use strict';

  const SRC = 'wrasslin.wav';
  // Found by analysing the track: the groove repeats every ~10.36 s (8 bars at ~185 BPM).
  // The intro plays once, then 8.00 s -> 39.08 s loops (three repeats of the groove).
  const LOOP_START = 8.0;
  const LOOP_END = 39.0794;
  const SEAM_FADE = 0.04;                  // crossfade baked into the loop seam so it never clicks

  // Normal vs HYPE sound. Tweak these to change how big the boost feels.
  const MIX = {
    normal: { level: 0.55, low: 0, high: -3, cutoff: 4000, grit: 0, crowd: 0.02 },
    hype: { level: 0.9, low: 5, high: 6, cutoff: 20000, grit: 0.35, crowd: 0.15 },
  };

  let actx = null, buffer = null, loading = null;
  let input, lowShelf, highShelf, lowpass, gritGain, musicGain, crowdGain, sfxBus, noiseBuf;
  let source = null;
  let playing = false, paused = false, hype = false;
  let offset = 0, startedAt = 0;          // playhead bookkeeping for pause/resume

  const rand = (a, b) => a + Math.random() * (b - a);

  // --- Setup ----------------------------------------------------------------
  function distortionCurve(drive) {
    const n = 2048, curve = new Float32Array(n), norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  function init(audioCtx, destination) {
    if (actx) return;
    actx = audioCtx;

    // Glue compressor + limiter so the boosted track can't clip
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    const limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.1;
    comp.connect(limiter).connect(destination);

    // Track -> EQ -> lowpass -> (dry + parallel saturation) -> level
    input = actx.createGain();
    lowShelf = actx.createBiquadFilter();
    lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 120;
    highShelf = actx.createBiquadFilter();
    highShelf.type = 'highshelf'; highShelf.frequency.value = 3000;
    lowpass = actx.createBiquadFilter();
    lowpass.type = 'lowpass'; lowpass.Q.value = 0.7;
    musicGain = actx.createGain();
    musicGain.gain.value = 0;
    input.connect(lowShelf).connect(highShelf).connect(lowpass);
    lowpass.connect(musicGain);
    const shaper = actx.createWaveShaper();
    shaper.curve = distortionCurve(6);
    shaper.oversample = '4x';
    gritGain = actx.createGain();
    gritGain.gain.value = 0;
    lowpass.connect(shaper).connect(gritGain).connect(musicGain);
    musicGain.connect(comp);

    sfxBus = actx.createGain();
    sfxBus.connect(comp);

    noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Crowd roar bed
    const roar = actx.createBufferSource();
    roar.buffer = noiseBuf;
    roar.loop = true;
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    crowdGain = actx.createGain();
    crowdGain.gain.value = 0;
    roar.connect(bp).connect(crowdGain).connect(comp);
    roar.start();

    applyMix(0.01);
    load();
  }

  function load() {
    if (loading) return loading;
    loading = fetch(SRC)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((data) => actx.decodeAudioData(data))
      .then((decoded) => {
        bakeSeam(decoded);
        buffer = decoded;
        if (playing && !paused) play(offset);
      })
      .catch((e) => console.warn("Couldn't load " + SRC + ' (open the game through serve.ps1):', e));
    return loading;
  }

  // Crossfade the end of the loop into the audio just before the loop start,
  // so jumping from LOOP_END back to LOOP_START is seamless.
  function bakeSeam(buf) {
    const sr = buf.sampleRate;
    const s = Math.round(LOOP_START * sr), e = Math.round(LOOP_END * sr), n = Math.round(SEAM_FADE * sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let k = 0; k < n; k++) {
        const f = k / n;
        d[e - n + k] = d[e - n + k] * (1 - f) + d[s - n + k] * f;
      }
    }
  }

  // --- Playback -------------------------------------------------------------
  function play(from) {
    if (!buffer) return;
    stopSource();
    source = actx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = LOOP_START;
    source.loopEnd = LOOP_END;
    source.connect(input);
    source.start(actx.currentTime + 0.02, from);
    offset = from;
    startedAt = actx.currentTime + 0.02;
  }

  function stopSource(fade = 0) {
    if (!source) return;
    const s = source;
    source = null;
    try { s.stop(actx.currentTime + fade); } catch (e) { /* already stopped */ }
  }

  // Where the playhead is right now, accounting for the loop
  function position() {
    let pos = offset + Math.max(0, actx.currentTime - startedAt);
    if (pos >= LOOP_END) pos = LOOP_START + ((pos - LOOP_START) % (LOOP_END - LOOP_START));
    return pos;
  }

  function ramp(param, value, time) {
    param.cancelScheduledValues(actx.currentTime);
    param.setTargetAtTime(value, actx.currentTime, time / 3);
  }

  function applyMix(time = 0.25) {
    const on = playing && !paused;
    const mix = hype ? MIX.hype : MIX.normal;
    ramp(musicGain.gain, on ? mix.level : 0, time);
    ramp(lowShelf.gain, mix.low, time);
    ramp(highShelf.gain, mix.high, time);
    ramp(lowpass.frequency, mix.cutoff, time);
    ramp(gritGain.gain, mix.grit, time);
    ramp(crowdGain.gain, on ? mix.crowd : 0, hype ? 0.3 : 1.5);
  }

  // --- HYPE extras ----------------------------------------------------------
  function noiseHit(t, dur, vol, type, freq, q = 1) {
    const src = actx.createBufferSource();
    src.buffer = noiseBuf;
    const f = actx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = actx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(sfxBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  // Glass breaks: the HYPE entrance
  function shatter(t) {
    noiseHit(t, 1.1, 0.45, 'highpass', 3200);
    noiseHit(t, 0.25, 0.4, 'bandpass', 2200, 0.8);
    noiseHit(t, 2, 0.18, 'highpass', 4500);             // crash
    const boom = actx.createOscillator(), bg = actx.createGain();
    boom.frequency.setValueAtTime(90, t);
    boom.frequency.exponentialRampToValueAtTime(32, t + 0.8);
    bg.gain.setValueAtTime(0.7, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    boom.connect(bg).connect(sfxBus);
    boom.start(t); boom.stop(t + 1);
    for (let i = 0; i < 34; i++) {
      const at = t + Math.pow(Math.random(), 2) * 0.7;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      o.frequency.value = rand(2400, 9500);
      g.gain.setValueAtTime(rand(0.03, 0.08), at);
      g.gain.exponentialRampToValueAtTime(0.001, at + rand(0.04, 0.3));
      o.connect(g).connect(sfxBus);
      o.start(at); o.stop(at + 0.35);
    }
  }

  // --- Public API -----------------------------------------------------------
  function start() {
    if (!actx) return;
    playing = true; paused = false; hype = false;
    play(0);                                // first time through includes the intro
    if (!buffer) offset = 0;
    applyMix(0.05);
  }

  function stop() {
    if (!actx) return;
    playing = false; hype = false;
    applyMix(0.4);
    stopSource(0.6);
  }

  function setPaused(p) {
    if (!actx || paused === p || !playing) { paused = p; return; }
    paused = p;
    if (p) {
      offset = position();
      applyMix(0.05);
      stopSource(0.1);
    } else {
      play(offset);
      applyMix(0.1);
    }
  }

  // Boost (or un-boost) right where the song is — no restart
  function setHype(on) {
    if (!actx || hype === on) return;
    hype = on;
    if (on && playing) shatter(actx.currentTime);
    applyMix(on ? 0.08 : 1.2);
  }

  return { init, start, stop, setPaused, setHype };
})();
