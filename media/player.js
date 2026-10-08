(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const playerEl = document.querySelector('.player');
  const audio = $('audio');
  const playPause = $('playPause');
  const rewind = $('rewind');
  const forward = $('forward');
  const loopBtn = $('loop');
  const speedBtn = $('speed');
  const muteBtn = $('mute');
  const iconPlay = $('iconPlay');
  const iconPause = $('iconPause');
  const iconVolume = $('iconVolume');
  const iconMuted = $('iconMuted');
  const volume = $('volume');
  const currentEl = $('current');
  const durationEl = $('duration');
  const regionEl = $('region');
  const meta = $('meta');
  const stats = $('stats');
  const status = $('status');
  const visual = $('visual');
  const canvas = $('waveform');
  const selectionEl = $('selection');
  const playheadEl = $('playhead');
  const hoverTimeEl = $('hoverTime');
  const ctx = canvas.getContext('2d');

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const DRAG_THRESHOLD_PX = 4;

  let audioBuffer = null;
  let peaks = null;
  let info = null;
  let fileSize = 0;
  let cssWidth = 0;
  let cssHeight = 0;
  let hoverX = -1;
  let rafId = 0;
  let resizeTimer = 0;
  let showRemaining = false;
  let loopOn = false;
  let speedIdx = SPEEDS.indexOf(1);
  let autoplay = false;
  let firstLoad = true;
  let region = null; // { start, end } in seconds
  let drag = null;   // { x0, t0, moved }
  let pendingResume = null; // { time, playing } across a reload

  // True while playing the original file bytes; a failure then triggers one
  // transcode request rather than an error.
  let nativeSource = false;
  let transcodeRequested = false;
  let objectUrl = null;

  function requestTranscode() {
    if (transcodeRequested) return false;
    transcodeRequested = true;
    nativeSource = false;
    meta.textContent = 'transcoding...';
    vscode.postMessage({ type: 'transcode' });
    return true;
  }

  function showStatus(msg, isError) {
    status.hidden = false;
    status.classList.toggle('error', !!isError);
    const line = document.createElement('div');
    line.textContent = msg;
    status.appendChild(line);
  }

  function clearStatus() {
    status.hidden = true;
    status.textContent = '';
  }

  // Sound effects are often under a second, where whole seconds say nothing.
  function precise() {
    return isFinite(audio.duration) && audio.duration < 60;
  }

  function fmt(t, withFraction) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    if (!withFraction) return `${m}:${s}`;
    const cs = Math.floor((t % 1) * 100).toString().padStart(2, '0');
    return `${m}:${s}.${cs}`;
  }

  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    cssWidth = rect.width;
    cssHeight = rect.height;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function progress() {
    return audio.duration ? audio.currentTime / audio.duration : 0;
  }

  function drawWaveform() {
    if (!cssWidth || !cssHeight) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    updateOverlays();
    if (!peaks) return;

    const colorMuted = readVar('--vscode-descriptionForeground', '#888');
    const colorAccent = readVar('--vscode-progressBar-background', '#0e639c') ||
                        readVar('--vscode-button-background', '#0e639c');
    const colorHover = readVar('--vscode-focusBorder', '#007acc');

    const barWidth = 2;
    const gap = 1;
    const stride = barWidth + gap;
    const numBars = Math.floor(cssWidth / stride);
    const mid = cssHeight / 2;
    const playedBars = Math.floor(numBars * progress());
    const hoverBar = hoverX >= 0 && !drag ? Math.floor((hoverX / cssWidth) * numBars) : -1;

    const peaksLen = peaks.length;
    for (let i = 0; i < numBars; i++) {
      const peakIdx = Math.floor((i / numBars) * peaksLen);
      const peak = peaks[peakIdx] || 0;
      const h = Math.max(2, peak * (cssHeight - 6));
      const x = i * stride;
      const y = mid - h / 2;

      let color = i < playedBars ? colorAccent : colorMuted;
      if (hoverBar >= 0 && i >= Math.min(playedBars, hoverBar) && i <= Math.max(playedBars, hoverBar)) {
        color = colorHover;
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = i < playedBars ? 1 : 0.55;
      ctx.fillRect(x, y, barWidth, h);
    }
    ctx.globalAlpha = 1;
  }

  function updateOverlays() {
    const d = audio.duration;
    if (!d || !isFinite(d)) {
      playheadEl.hidden = true;
      selectionEl.hidden = true;
      return;
    }
    playheadEl.hidden = false;
    playheadEl.style.left = `${progress() * 100}%`;
    if (region) {
      selectionEl.hidden = false;
      selectionEl.style.left = `${(region.start / d) * 100}%`;
      selectionEl.style.width = `${((region.end - region.start) / d) * 100}%`;
    } else {
      selectionEl.hidden = true;
    }
  }

  function updateTime() {
    const p = precise();
    const t = showRemaining ? Math.max(0, (audio.duration || 0) - audio.currentTime) : audio.currentTime;
    currentEl.textContent = (showRemaining ? '-' : '') + fmt(t, p);
    durationEl.textContent = fmt(audio.duration, p);
  }

  // timeupdate fires about four times a second, too coarse for short sounds
  // and for region loop points, so drive both from animation frames instead.
  function startAnim() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      if (region && audio.currentTime >= region.end) {
        audio.currentTime = region.start;
      }
      updateTime();
      drawWaveform();
      if (!audio.paused) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function computePeaks(buf, targetCount) {
    const channels = buf.numberOfChannels;
    const length = buf.length;
    const samplesPerPeak = Math.max(1, Math.floor(length / targetCount));
    const peaksOut = new Float32Array(targetCount);

    const data = [];
    for (let c = 0; c < channels; c++) data.push(buf.getChannelData(c));

    for (let p = 0; p < targetCount; p++) {
      const start = p * samplesPerPeak;
      const end = Math.min(length, start + samplesPerPeak);
      let max = 0;
      for (let i = start; i < end; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += Math.abs(data[c][i]);
        v /= channels;
        if (v > max) max = v;
      }
      peaksOut[p] = max;
    }

    let maxOverall = 0;
    for (let i = 0; i < targetCount; i++) if (peaksOut[i] > maxOverall) maxOverall = peaksOut[i];
    if (maxOverall > 0) {
      const norm = 1 / maxOverall;
      for (let i = 0; i < targetCount; i++) peaksOut[i] *= norm;
    }

    return peaksOut;
  }

  function computeLevels(buf) {
    let peak = 0;
    let sumSq = 0;
    let clipped = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        if (a >= 1) clipped++;
        sumSq += d[i] * d[i];
      }
    }
    const n = buf.length * buf.numberOfChannels;
    return { peak, rms: n ? Math.sqrt(sumSq / n) : 0, clipped };
  }

  function dbfs(v) {
    if (v <= 0) return '-inf dBFS';
    return `${(20 * Math.log10(v)).toFixed(1)} dBFS`;
  }

  function rebuildPeaks() {
    if (!audioBuffer) return;
    peaks = computePeaks(audioBuffer, Math.max(64, Math.floor(cssWidth / 3)));
  }

  async function decodeForWaveform(arrayBuffer) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return { buf: null };
    const ac = new Ctor();
    try {
      return { buf: await ac.decodeAudioData(arrayBuffer.slice(0)) };
    } catch (e) {
      return { buf: null, error: e };
    } finally {
      ac.close && ac.close();
    }
  }

  function channelLabel(n) {
    return n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`;
  }

  function renderMeta() {
    const parts = [];
    if (info) {
      if (info.codec) parts.push(info.codec);
      if (info.sampleRate) parts.push(`${+(info.sampleRate / 1000).toFixed(3)} kHz`);
      if (info.bitDepth) parts.push(`${info.bitDepth}-bit`);
      if (info.channels) parts.push(channelLabel(info.channels));
      if (info.bitRate) parts.push(`${Math.round(info.bitRate / 1000)} kbps`);
    } else if (audioBuffer) {
      // decodeAudioData resamples, so only the channel count is trustworthy here.
      parts.push(channelLabel(audioBuffer.numberOfChannels));
    }
    if (fileSize) parts.push(formatBytes(fileSize));
    if (parts.length) meta.textContent = parts.join(' · ');
  }

  function renderStats() {
    if (!audioBuffer) {
      stats.hidden = true;
      return;
    }
    const lv = computeLevels(audioBuffer);
    const rows = [
      ['Peak', dbfs(lv.peak)],
      ['RMS', dbfs(lv.rms)],
      ['Length', `${audioBuffer.duration.toFixed(3)} s`],
    ];
    if (lv.clipped) rows.push(['Clipped', `${lv.clipped.toLocaleString()} samples`]);
    stats.textContent = '';
    for (const [k, v] of rows) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      if (k === 'Clipped') wrap.classList.add('warn');
      wrap.append(dt, dd);
      stats.appendChild(wrap);
    }
    stats.hidden = false;
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
    return `${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function setPlaying(playing) {
    // SVG elements have no hidden property, only the attribute.
    iconPlay.toggleAttribute('hidden', playing);
    iconPause.toggleAttribute('hidden', !playing);
    playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playerEl.dataset.state = playing ? 'playing' : 'paused';
  }

  function enableControls() {
    playPause.disabled = false;
    rewind.disabled = false;
    forward.disabled = false;
    playerEl.dataset.state = 'paused';
  }

  function play() {
    const p = audio.play();
    if (p && p.catch) p.catch(err => showStatus(`play() rejected: ${err.name}: ${err.message}`, true));
  }

  function togglePlay() {
    if (playPause.disabled) return;
    if (audio.paused) play();
    else audio.pause();
  }

  function seek(t) {
    if (!audio.duration) return;
    audio.currentTime = Math.min(Math.max(0, t), audio.duration);
    updateTime();
    drawWaveform();
  }

  function applyLoop() {
    // A region loops by itself, so the element must not stop at the end.
    audio.loop = loopOn || !!region;
    loopBtn.classList.toggle('active', loopOn);
    loopBtn.setAttribute('aria-pressed', String(loopOn));
  }

  function setLoop(on) {
    loopOn = on;
    applyLoop();
  }

  function setRegion(r) {
    region = r && r.end - r.start > 0.01 ? r : null;
    applyLoop();
    if (region) {
      regionEl.hidden = false;
      const p = precise() || region.end - region.start < 10;
      regionEl.textContent = `loop ${fmt(region.start, p)} - ${fmt(region.end, p)}`;
    } else {
      regionEl.hidden = true;
    }
    drawWaveform();
  }

  function setSpeed(idx) {
    speedIdx = Math.min(SPEEDS.length - 1, Math.max(0, idx));
    audio.defaultPlaybackRate = SPEEDS[speedIdx];
    audio.playbackRate = SPEEDS[speedIdx];
    speedBtn.textContent = `${SPEEDS[speedIdx]}x`;
    speedBtn.classList.toggle('active', SPEEDS[speedIdx] !== 1);
  }

  function setMuted(m) {
    audio.muted = m;
    iconVolume.toggleAttribute('hidden', m);
    iconMuted.toggleAttribute('hidden', !m);
    muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
  }

  function setVolume(v, persist) {
    audio.volume = v;
    volume.value = String(Math.round(v * 100));
    if (v > 0 && audio.muted) setMuted(false);
    if (persist) vscode.postMessage({ type: 'volume', value: v });
  }

  function timeAt(clientX) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return { x, t: (x / rect.width) * (audio.duration || 0) };
  }

  audio.addEventListener('error', () => {
    if (nativeSource && requestTranscode()) return;
    const e = audio.error;
    const codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    showStatus(`Audio error: ${e ? codes[e.code] || e.code : 'unknown'}`, true);
    playerEl.dataset.state = 'error';
  });
  audio.addEventListener('canplay', () => {
    if (playerEl.dataset.state === 'loading') enableControls();
    if (pendingResume) {
      const r = pendingResume;
      pendingResume = null;
      seek(Math.min(r.time, audio.duration || 0));
      if (r.playing) play();
    } else if (firstLoad && autoplay) {
      play();
    }
    firstLoad = false;
  });
  audio.addEventListener('loadedmetadata', updateTime);
  audio.addEventListener('durationchange', updateTime);
  audio.addEventListener('timeupdate', () => {
    if (audio.paused) { updateTime(); drawWaveform(); }
  });
  audio.addEventListener('play', () => {
    setPlaying(true);
    startAnim();
    vscode.postMessage({ type: 'playing' });
  });
  audio.addEventListener('pause', () => { setPlaying(false); updateTime(); drawWaveform(); });
  audio.addEventListener('ended', () => { setPlaying(false); updateTime(); drawWaveform(); });
  audio.addEventListener('seeked', () => { updateTime(); drawWaveform(); });

  playPause.addEventListener('click', togglePlay);
  rewind.addEventListener('click', () => seek(audio.currentTime - 5));
  forward.addEventListener('click', () => seek(audio.currentTime + 5));
  loopBtn.addEventListener('click', () => setLoop(!loopOn));
  speedBtn.addEventListener('click', () => setSpeed(speedIdx === SPEEDS.length - 1 ? 0 : speedIdx + 1));
  muteBtn.addEventListener('click', () => setMuted(!audio.muted));
  currentEl.addEventListener('click', () => {
    showRemaining = !showRemaining;
    currentEl.title = showRemaining ? 'Show elapsed time' : 'Show remaining time';
    updateTime();
  });

  volume.addEventListener('input', () => setVolume(Number(volume.value) / 100, false));
  volume.addEventListener('change', () => setVolume(Number(volume.value) / 100, true));

  canvas.addEventListener('mousemove', (ev) => {
    const { x, t } = timeAt(ev.clientX);
    hoverX = x;
    if (audio.duration) {
      hoverTimeEl.hidden = false;
      hoverTimeEl.textContent = fmt(t, precise());
      hoverTimeEl.style.left = `${x}px`;
    }
    drawWaveform();
  });
  canvas.addEventListener('mouseleave', () => {
    hoverX = -1;
    hoverTimeEl.hidden = true;
    drawWaveform();
  });
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || !audio.duration) return;
    const { x, t } = timeAt(ev.clientX);
    drag = { x0: x, t0: t, moved: false };
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const { x, t } = timeAt(ev.clientX);
    if (!drag.moved && Math.abs(x - drag.x0) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    setRegion({ start: Math.min(drag.t0, t), end: Math.max(drag.t0, t) });
  });
  window.addEventListener('mouseup', (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved && region) {
      seek(region.start);
    } else {
      const { t } = timeAt(ev.clientX);
      if (region && (t < region.start || t > region.end)) setRegion(null);
      seek(t);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const d = audio.duration || 0;
    const step = ev.shiftKey ? 1 : 5;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft': ev.preventDefault(); seek(audio.currentTime - step); break;
      case 'ArrowRight': ev.preventDefault(); seek(audio.currentTime + step); break;
      case 'ArrowUp': ev.preventDefault(); setVolume(Math.min(1, audio.volume + 0.05), true); break;
      case 'ArrowDown': ev.preventDefault(); setVolume(Math.max(0, audio.volume - 0.05), true); break;
      case 'Home': seek(region ? region.start : 0); break;
      case 'End': seek(region ? region.end : d); break;
      case 'l': case 'L': setLoop(!loopOn); break;
      case 'm': case 'M': setMuted(!audio.muted); break;
      case '[': setSpeed(speedIdx - 1); break;
      case ']': setSpeed(speedIdx + 1); break;
      case '\\': setSpeed(SPEEDS.indexOf(1)); break;
      case 'Escape': setRegion(null); break;
      default:
        if (/^[0-9]$/.test(ev.key)) seek((Number(ev.key) / 10) * d);
    }
  });

  window.addEventListener('resize', () => {
    setupCanvas();
    drawWaveform();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { rebuildPeaks(); drawWaveform(); }, 150);
  });

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'config':
        autoplay = !!msg.autoplay;
        setLoop(!!msg.loop);
        if (typeof msg.volume === 'number') setVolume(msg.volume, false);
        break;
      case 'info':
        info = msg.info;
        renderMeta();
        break;
      case 'pause':
        audio.pause();
        break;
      case 'audio':
        await loadAudio(msg);
        break;
      case 'error':
        meta.textContent = 'failed to load';
        playerEl.dataset.state = 'error';
        showStatus(msg.message, true);
        break;
    }
  });

  async function loadAudio(msg) {
    const bytes = new Uint8Array(msg.bytes);
    if (msg.reload) {
      pendingResume = { time: audio.currentTime, playing: !audio.paused };
      audio.pause();
      clearStatus();
    }
    if (typeof msg.fileSize === 'number') fileSize = msg.fileSize;

    setupCanvas();
    const { buf, error } = await decodeForWaveform(bytes.buffer);
    if (!buf && !msg.decoded && requestTranscode()) return;
    if (error) showStatus(`waveform decode failed: ${error.message || error}`, true);

    nativeSource = !msg.decoded;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: msg.mime || 'audio/wav' }));
    audio.src = objectUrl;
    audio.playbackRate = SPEEDS[speedIdx];

    audioBuffer = buf;
    if (region && buf && region.end > buf.duration) setRegion(null);
    rebuildPeaks();
    renderMeta();
    renderStats();
    drawWaveform();
  }

  setSpeed(speedIdx);
  setupCanvas();
  vscode.postMessage({ type: 'ready' });
})();
