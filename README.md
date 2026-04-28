# Every Sound Player

A clean, waveform-based audio player for Visual Studio Code. Open audio files directly from the editor and play them without leaving your workspace.

## Features

- **Waveform display** with hover preview and click-to-seek
- **Play / pause / skip / volume / seek** controls
- **Format badge** and live time / duration readout
- **Theme-aware** styling that follows your VS Code colors
- **Keyboard shortcuts**: `Space` toggles play, `←` / `→` skip 5 seconds

## Supported formats

**Played natively** (no decoding required):
`wav`, `mp3`, `m4a`, `aac`, `flac`, `ogg`, `oga`, `opus`, `weba`

**Decoded via Apple's `afconvert`** (macOS only):
`caf`, `aiff`, `aif`, `aifc`, `au`, `snd`, `ac3`, `amr`, `3gp`, `3g2`

> On non-macOS platforms the native formats above will play; the decoded set will surface a clear error since `afconvert` is not available.

## Usage

Just open any audio file in VS Code — the player takes over the editor tab automatically.

To force the editor on a file when other handlers are registered: right-click the file in the Explorer → **Open With…** → **Every Sound Player**.

## License

MIT — see [LICENSE](LICENSE).

## Author

Built by [gotnull](https://github.com/gotnull). Also building [Socialmesh](https://socialmesh.app).
