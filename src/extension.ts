import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

const NATIVE_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.m4r': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
};

const VOLUME_KEY = 'everySoundPlayer.volume';
const RELOAD_DEBOUNCE_MS = 300;

class PlayerProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.css'));
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const formatLabel = ext.replace('.', '').toUpperCase();

    webview.html = playerHtml(webview, scriptUri, styleUri, fileName, formatLabel);

    this.panels.add(webviewPanel);
    const disposables: vscode.Disposable[] = [];

    // The webview's Chromium build may lack a demuxer or codec for a format we
    // treat as native (Ogg Opus in some VS Code builds). It asks us to transcode.
    let transcode = false;
    let ready = false;
    const load = (reload: boolean) =>
      sendAudio(webview, filePath, () => (transcode ? loadTranscoded(filePath) : loadAudio(filePath, ext)), reload);

    disposables.push(webview.onDidReceiveMessage(msg => {
      switch (msg?.type) {
        case 'ready':
          ready = true;
          webview.postMessage({ type: 'config', ...readConfig(), volume: this.context.globalState.get<number>(VOLUME_KEY, 1) });
          load(false);
          probeInfo(filePath).then(info => info && webview.postMessage({ type: 'info', info }));
          break;
        case 'transcode':
          if (!transcode) {
            transcode = true;
            load(false);
          }
          break;
        case 'volume':
          if (typeof msg.value === 'number') this.context.globalState.update(VOLUME_KEY, msg.value);
          break;
        case 'playing':
          for (const other of this.panels) {
            if (other !== webviewPanel) other.webview.postMessage({ type: 'pause' });
          }
          break;
      }
    }));

    if (readConfig().reloadOnChange) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), fileName),
      );
      let timer: NodeJS.Timeout | undefined;
      const onChange = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!ready) return;
          load(true);
          probeInfo(filePath).then(info => info && webview.postMessage({ type: 'info', info }));
        }, RELOAD_DEBOUNCE_MS);
      };
      disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), {
        dispose: () => clearTimeout(timer),
      });
    }

    webviewPanel.onDidDispose(() => {
      this.panels.delete(webviewPanel);
      disposables.forEach(d => d.dispose());
    });
  }
}

interface PlayerConfig {
  autoplay: boolean;
  loop: boolean;
  reloadOnChange: boolean;
}

function readConfig(): PlayerConfig {
  const cfg = vscode.workspace.getConfiguration('everySoundPlayer');
  return {
    autoplay: cfg.get('autoplay', false),
    loop: cfg.get('loop', false),
    reloadOnChange: cfg.get('reloadOnChange', true),
  };
}

async function sendAudio(
  webview: vscode.Webview,
  filePath: string,
  load: () => Promise<LoadedAudio>,
  reload: boolean,
): Promise<void> {
  try {
    const [{ bytes, mime, decoded }, stat] = await Promise.all([load(), fs.stat(filePath)]);
    // Webviews transfer ArrayBuffers natively, so there is no base64 round trip.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    webview.postMessage({ type: 'audio', bytes: buffer, mime, decoded, reload, fileSize: stat.size });
  } catch (err) {
    webview.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

interface LoadedAudio {
  bytes: Buffer;
  mime: string;
  decoded: boolean;
}

async function loadAudio(filePath: string, ext: string): Promise<LoadedAudio> {
  const nativeMime = NATIVE_MIME[ext];
  if (nativeMime) {
    return { bytes: await fs.readFile(filePath), mime: nativeMime, decoded: false };
  }
  return loadTranscoded(filePath);
}

async function loadTranscoded(filePath: string): Promise<LoadedAudio> {
  const wavPath = await convertToWav(filePath);
  try {
    return { bytes: await fs.readFile(wavPath), mime: 'audio/wav', decoded: true };
  } finally {
    fs.unlink(wavPath).catch(() => {});
  }
}

async function convertToWav(srcPath: string): Promise<string> {
  const hash = crypto.randomBytes(8).toString('hex');
  const out = path.join(os.tmpdir(), `every-sound-player-${hash}.wav`);
  const failures: string[] = [];

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', srcPath, out]);
      return out;
    } catch (err) {
      failures.push(`afconvert: ${stderrOf(err)}`);
    }
  }

  const ffmpeg = await findTool('ffmpeg');
  if (ffmpeg) {
    try {
      await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-i', srcPath, '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', out]);
      return out;
    } catch (err) {
      failures.push(`ffmpeg: ${stderrOf(err)}`);
    }
  } else {
    failures.push('ffmpeg not found (install it, or set everySoundPlayer.ffmpegPath)');
  }

  throw new Error(`Could not decode ${path.basename(srcPath)}.\n${failures.join('\n')}`);
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split('\n').pop() || 'failed';
}

// Editors launched from the macOS Dock do not inherit the shell PATH, so look in
// the usual package manager locations as well.
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];

async function findTool(name: 'ffmpeg' | 'ffprobe'): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('everySoundPlayer').get<string>('ffmpegPath', '').trim();
  if (configured) {
    const candidate = name === 'ffmpeg' ? configured : path.join(path.dirname(configured), path.basename(configured).replace(/ffmpeg/i, 'ffprobe'));
    if (await isExecutable(candidate)) return candidate;
  }
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AudioInfo {
  codec?: string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  bitRate?: number;
  duration?: number;
}

// The waveform comes from decodeAudioData, which resamples to the context rate,
// so the file's real format has to come from a tool that reads the header.
async function probeInfo(filePath: string): Promise<AudioInfo | undefined> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/afinfo', [filePath]);
      const info = parseAfinfo(stdout);
      if (info) return info;
    } catch {
      // fall through to ffprobe
    }
  }
  const ffprobe = await findTool('ffprobe');
  if (!ffprobe) return undefined;
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,bit_rate:format=duration,bit_rate',
      '-of', 'json', filePath,
    ]);
    return parseFfprobe(stdout);
  } catch {
    return undefined;
  }
}

const AFINFO_CODECS: Record<string, string> = {
  aac: 'AAC', 'aach': 'HE-AAC', 'aacp': 'HE-AACv2', alac: 'ALAC', '.mp3': 'MP3', opus: 'Opus',
  flac: 'FLAC', ulaw: 'mu-law', alaw: 'A-law', 'ima4': 'IMA ADPCM', 'ac-3': 'AC-3', samr: 'AMR',
};

export function parseAfinfo(out: string): AudioInfo | undefined {
  const m = /Data format:\s+(\d+) ch,\s+(\d+) Hz,\s+([^\n]+)/.exec(out);
  if (!m) return undefined;
  const info: AudioInfo = { channels: Number(m[1]), sampleRate: Number(m[2]) };
  const fmt = m[3].trim();
  const pcm = /^(Int|Float)(\d+)/.exec(fmt);
  if (pcm) {
    info.codec = pcm[1] === 'Float' ? 'PCM float' : 'PCM';
    info.bitDepth = Number(pcm[2]);
  } else {
    const code = fmt.split(/[\s(]/)[0].replace(/'/g, '');
    info.codec = AFINFO_CODECS[code] || code;
    const bits = /(\d+) bits\/channel/.exec(fmt) || /from (\d+)-bit source/.exec(fmt) || /source bit depth:\s+[IF](\d+)/.exec(out);
    if (bits && Number(bits[1]) > 0) info.bitDepth = Number(bits[1]);
  }
  const rate = /bit rate:\s+(\d+)/.exec(out);
  if (rate) info.bitRate = Number(rate[1]);
  const dur = /estimated duration:\s+([\d.]+)/.exec(out);
  if (dur) info.duration = Number(dur[1]);
  return info;
}

export function parseFfprobe(out: string): AudioInfo | undefined {
  const json = JSON.parse(out);
  const s = json.streams?.[0];
  if (!s) return undefined;
  const num = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
  const codec: string = s.codec_name || '';
  return {
    codec: codec.startsWith('pcm_') ? (codec.includes('f') ? 'PCM float' : 'PCM') : codec.toUpperCase(),
    sampleRate: num(s.sample_rate),
    channels: num(s.channels),
    bitDepth: num(s.bits_per_raw_sample) ?? num(s.bits_per_sample),
    bitRate: num(s.bit_rate) ?? num(json.format?.bit_rate),
    duration: num(json.format?.duration),
  };
}

function playerHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  fileName: string,
  formatLabel: string,
): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = [
    `default-src 'none'`,
    `media-src blob:`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>${escapeHtml(fileName)}</title>
</head>
<body>
<main class="player" data-state="loading">
  <header class="header">
    <div class="badge" id="badge">${escapeHtml(formatLabel)}</div>
    <h1 class="filename" id="filename" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</h1>
    <div class="meta" id="meta">decoding...</div>
  </header>

  <section class="visual" id="visual">
    <canvas id="waveform" class="waveform" title="Click to seek, drag to loop a region"></canvas>
    <div class="selection" id="selection" hidden></div>
    <div class="playhead" id="playhead" hidden></div>
    <div class="hover-time" id="hoverTime" hidden></div>
    <div class="loader" id="loader">
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
    </div>
  </section>

  <div class="time-row">
    <button id="current" class="time-btn" type="button" title="Show remaining time">0:00</button>
    <span id="region" class="region-label" hidden></span>
    <span id="duration">0:00</span>
  </div>

  <section class="controls">
    <button id="rewind" class="ctrl-btn" type="button" aria-label="Back 5 seconds" title="Back 5s (Left, Shift+Left for 1s)" disabled>
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M11 18V6l-8.5 6L11 18zm.5-6l8.5 6V6l-8.5 6z" fill="currentColor"/></svg>
    </button>
    <button id="playPause" class="play-btn" type="button" aria-label="Play" title="Play / pause (Space)" disabled>
      <svg id="iconPlay" viewBox="0 0 24 24" width="26" height="26"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      <svg id="iconPause" viewBox="0 0 24 24" width="26" height="26" hidden><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>
    </button>
    <button id="forward" class="ctrl-btn" type="button" aria-label="Forward 5 seconds" title="Forward 5s (Right, Shift+Right for 1s)" disabled>
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z" fill="currentColor"/></svg>
    </button>
    <button id="loop" class="ctrl-btn toggle" type="button" aria-label="Loop" aria-pressed="false" title="Loop (L)">
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" fill="currentColor"/></svg>
    </button>
    <button id="speed" class="ctrl-btn speed-btn" type="button" aria-label="Playback speed" title="Speed ([ and ] to change, \\ to reset)">1x</button>
    <div class="spacer"></div>
    <div class="volume">
      <button id="mute" class="icon-btn" type="button" aria-label="Mute" title="Mute (M)">
        <svg id="iconVolume" viewBox="0 0 24 24" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" fill="currentColor"/></svg>
        <svg id="iconMuted" viewBox="0 0 24 24" width="18" height="18" hidden><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3l2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" fill="currentColor"/></svg>
      </button>
      <input id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
    </div>
  </section>

  <dl class="stats" id="stats" hidden></dl>

  <div id="status" class="status" hidden></div>
</main>

<footer class="attribution">
  <span class="keys">Space play · L loop · M mute · [ ] speed · 0-9 jump · Esc clear region</span>
  <span class="links">
    <a href="https://github.com/gotnull" target="_blank" rel="noopener noreferrer">gotnull</a>
    <span aria-hidden="true">·</span>
    <a href="https://socialmesh.app" target="_blank" rel="noopener noreferrer">SocialMesh</a>
  </span>
</footer>

<audio id="audio" preload="auto"></audio>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('every-sound-player.player', new PlayerProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );
}

export function deactivate(): void {}
