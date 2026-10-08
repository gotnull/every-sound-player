(function () {
  const vscode = acquireVsCodeApi();
  const playerEl = document.querySelector('.player');
  const audio = document.getElementById('audio');
  const playPause = document.getElementById('playPause');
  const rewind = document.getElementById('rewind');
  const forward = document.getElementById('forward');
  const iconPlay = document.getElementById('iconPlay');
  const iconPause = document.getElementById('iconPause');
  const volume = document.getElementById('volume');
  const currentEl = document.getElementById('current');
  const durationEl = document.getElementById('duration');
  const meta = document.getElementById('meta');
  const status = document.getElementById('status');
  const canvas = document.getElementById('waveform');
  const ctx = canvas.getContext('2d');

  let peaks = null;
  let cssWidth = 0;
  let cssHeight = 0;
  let hoverX = -1;
  let rafId = 0;
  // True while playing the original file bytes; a failure then triggers one
  // transcode request rather than an error.
  let nativeSource = false;
  let transcodeRequested = false;
  let objectUrl = null;

  function requestTranscode() {
    if (transcodeRequested) return false;
    transcodeRequested = true;
    nativeSource = false;
    meta.textContent = 'transcoding…';
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

  function fmt(t) {
    if (!isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
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

  function drawWaveform() {
    if (!cssWidth || !cssHeight) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const colorBg = readVar('--vscode-editor-background', '#1e1e1e');
    const colorMuted = readVar('--vscode-descriptionForeground', '#888');
    const colorAccent = readVar('--vscode-progressBar-background', '#0e639c') ||
                        readVar('--vscode-button-background', '#0e639c');
    const colorHover = readVar('--vscode-focusBorder', '#007acc');

    if (!peaks) return;

    const barWidth = 2;
    const gap = 1;
    const stride = barWidth + gap;
    const numBars = Math.floor(cssWidth / stride);
    const mid = cssHeight / 2;
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    const playedBars = Math.floor(numBars * progress);
    const hoverBar = hoverX >= 0 ? Math.floor((hoverX / cssWidth) * numBars) : -1;

    const peaksLen = peaks.length;
    for (let i = 0; i < numBars; i++) {
      const peakIdx = Math.floor((i / numBars) * peaksLen);
      const peak = peaks[peakIdx] || 0;
      const h = Math.max(2, peak * (cssHeight - 6));
      const x = i * stride;
      const y = mid - h / 2;

      let color;
      if (i < playedBars) color = colorAccent;
      else color = colorMuted;
      if (hoverBar >= 0 && i >= Math.min(playedBars, hoverBar) && i <= Math.max(playedBars, hoverBar)) {
        color = colorHover;
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = i < playedBars ? 1 : 0.55;
      ctx.fillRect(x, y, barWidth, h);
    }
    ctx.globalAlpha = 1;
  }

  function startAnim() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      drawWaveform();
      if (!audio.paused) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function computePeaks(audioBuffer, targetCount) {
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const samplesPerPeak = Math.max(1, Math.floor(length / targetCount));
    const peaksOut = new Float32Array(targetCount);

    const data = [];
    for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

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

  function setMeta(audioBuffer, fileSize, mime) {
    if (!audioBuffer) {
      meta.textContent = `${formatBytes(fileSize)} · ${mime}`;
      return;
    }
    const sr = (audioBuffer.sampleRate / 1000).toFixed(1);
    const ch = audioBuffer.numberOfChannels === 1 ? 'mono' :
               audioBuffer.numberOfChannels === 2 ? 'stereo' :
               `${audioBuffer.numberOfChannels} ch`;
    meta.textContent = `${sr} kHz · ${ch} · ${formatBytes(fileSize)}`;
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
    return `${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function setPlaying(playing) {
    iconPlay.hidden = playing;
    iconPause.hidden = !playing;
    playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playerEl.dataset.state = playing ? 'playing' : 'paused';
  }

  function enableControls() {
    playPause.disabled = false;
    rewind.disabled = false;
    forward.disabled = false;
    playerEl.dataset.state = 'paused';
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
  });
  audio.addEventListener('loadedmetadata', () => {
    durationEl.textContent = fmt(audio.duration);
  });
  audio.addEventListener('durationchange', () => {
    durationEl.textContent = fmt(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    currentEl.textContent = fmt(audio.currentTime);
    drawWaveform();
  });
  audio.addEventListener('play', () => { setPlaying(true); startAnim(); });
  audio.addEventListener('pause', () => { setPlaying(false); drawWaveform(); });
  audio.addEventListener('ended', () => { setPlaying(false); drawWaveform(); });

  playPause.addEventListener('click', () => {
    if (audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch(err => showStatus(`play() rejected: ${err.name}: ${err.message}`, true));
    } else {
      audio.pause();
    }
  });
  rewind.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
  forward.addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); });

  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value) / 100;
  });

  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    hoverX = ev.clientX - rect.left;
    drawWaveform();
  });
  canvas.addEventListener('mouseleave', () => { hoverX = -1; drawWaveform(); });
  canvas.addEventListener('click', (ev) => {
    if (!audio.duration) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    audio.currentTime = (x / rect.width) * audio.duration;
    drawWaveform();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.code === 'Space') { ev.preventDefault(); playPause.click(); }
    else if (ev.code === 'ArrowLeft') { rewind.click(); }
    else if (ev.code === 'ArrowRight') { forward.click(); }
  });

  window.addEventListener('resize', () => { setupCanvas(); drawWaveform(); });

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'audio') {
      const bytes = base64ToBytes(msg.bytes);
      setupCanvas();
      const { buf, error } = await decodeForWaveform(bytes.buffer);
      if (!buf && !msg.decoded && requestTranscode()) return;
      if (error) showStatus(`waveform decode failed: ${error.message || error}`, true);

      nativeSource = !msg.decoded;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: msg.mime || 'audio/wav' }));
      audio.src = objectUrl;

      if (buf) {
        const targetCount = Math.max(64, Math.floor(cssWidth / 3));
        peaks = computePeaks(buf, targetCount);
        setMeta(buf, msg.fileSize, msg.mime);
      } else {
        setMeta(null, msg.fileSize, msg.mime);
      }
      drawWaveform();
    } else if (msg.type === 'error') {
      meta.textContent = 'failed to load';
      playerEl.dataset.state = 'error';
      showStatus(msg.message, true);
    }
  });

  setupCanvas();
})();
