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
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
};

class CafEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const scriptUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.js'));
    const styleUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.css'));
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const formatLabel = ext.replace('.', '').toUpperCase();

    webviewPanel.webview.html = playerHtml(webviewPanel.webview, scriptUri, styleUri, fileName, formatLabel);

    try {
      const { bytes, mime, decoded } = await loadAudio(filePath, ext);
      webviewPanel.webview.postMessage({
        type: 'audio',
        bytes: bytes.toString('base64'),
        mime,
        decoded,
        fileSize: bytes.length,
      });
    } catch (err) {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
  const wavPath = await convertToWav(filePath);
  try {
    return { bytes: await fs.readFile(wavPath), mime: 'audio/wav', decoded: true };
  } finally {
    fs.unlink(wavPath).catch(() => {});
  }
}

async function convertToWav(srcPath: string): Promise<string> {
  const hash = crypto.randomBytes(8).toString('hex');
  const out = path.join(os.tmpdir(), `cafext-${hash}.wav`);
  await execFileAsync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', srcPath, out]);
  return out;
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
    <div class="meta" id="meta">decoding…</div>
  </header>

  <section class="visual">
    <canvas id="waveform" class="waveform"></canvas>
    <div class="loader" id="loader">
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
      <div class="loader-bar"></div>
    </div>
  </section>

  <div class="time-row">
    <span id="current">0:00</span>
    <span id="duration">0:00</span>
  </div>

  <section class="controls">
    <button id="rewind" class="ctrl-btn" type="button" aria-label="Rewind 5 seconds" disabled>
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M11 18V6l-8.5 6L11 18zm.5-6l8.5 6V6l-8.5 6z" fill="currentColor"/></svg>
    </button>
    <button id="playPause" class="play-btn" type="button" aria-label="Play" disabled>
      <svg id="iconPlay" viewBox="0 0 24 24" width="26" height="26"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      <svg id="iconPause" viewBox="0 0 24 24" width="26" height="26" hidden><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>
    </button>
    <button id="forward" class="ctrl-btn" type="button" aria-label="Forward 5 seconds" disabled>
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z" fill="currentColor"/></svg>
    </button>
    <div class="spacer"></div>
    <div class="volume">
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" fill="currentColor"/></svg>
      <input id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
    </div>
  </section>

  <div id="status" class="status" hidden></div>
</main>

<footer class="attribution">
  <a href="https://github.com/gotnull" target="_blank" rel="noopener noreferrer">gotnull</a>
  <span aria-hidden="true">·</span>
  <a href="https://socialmesh.app" target="_blank" rel="noopener noreferrer">Socialmesh</a>
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
    vscode.window.registerCustomEditorProvider('every-sound-player.player', new CafEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );
}

export function deactivate(): void {}
