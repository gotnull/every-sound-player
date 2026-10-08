# Every Sound Player

An audio player for Visual Studio Code. Open an audio file and it plays in the editor tab, with a waveform you can click to seek or drag across to loop a section.

It was built for checking game sound effects and music without leaving the editor, so it shows the details that matter for that: real sample rate and bit depth, peak and RMS levels, clipped samples, and timings to the hundredth of a second on short clips.

## Features

- **Waveform** with a playhead, hover time and click-to-seek
- **Loop regions**: drag across the waveform to loop that section, press `Esc` to clear it
- **Loop, speed (0.5x to 2x) and mute** controls
- **File details** read from the file header: codec, sample rate, bit depth, channels, bitrate and size
- **Levels**: peak and RMS in dBFS, with a warning when samples clip
- **Live reload** when the file changes on disk, keeping your position, so you can re-export a sound and hear it straight away
- **One player at a time**: starting a file pauses any other open player
- **Remembers your volume** between files
- **Theme-aware** styling that follows your VS Code colours

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Left` / `Right` | Back / forward 5 seconds (`Shift` for 1 second) |
| `Up` / `Down` | Volume |
| `Home` / `End` | Jump to start / end (of the loop region, if there is one) |
| `0` to `9` | Jump to 0% to 90% |
| `L` | Toggle loop |
| `M` | Toggle mute |
| `[` / `]` | Slower / faster, `\` resets to 1x |
| `Esc` | Clear the loop region |

Click the elapsed time to switch to time remaining.

## Supported formats

**Played directly by the editor:**
`wav`, `mp3`, `m4a`, `m4b`, `m4r`, `aac`, `flac`, `ogg`, `oga`, `opus`, `weba`

**Converted to WAV first:**
`caf`, `caff`, `aiff`, `aif`, `aifc`, `au`, `snd`, `ac3`, `eac3`, `amr`, `3gp`, `3g2`, `mp2`, `wma`, `wv`, `ape`, `mka`, `dts`

Conversion uses Apple's `afconvert` on macOS and falls back to `ffmpeg` when `afconvert` can't read the file. On Linux and Windows it needs `ffmpeg` on your `PATH`, or set `everySoundPlayer.ffmpegPath`.

If the editor's own decoder rejects one of the direct formats (some builds can't play Ogg Opus), the player converts it automatically.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `everySoundPlayer.autoplay` | `false` | Start playing when a file opens |
| `everySoundPlayer.loop` | `false` | Turn looping on by default |
| `everySoundPlayer.reloadOnChange` | `true` | Reload when the file changes on disk |
| `everySoundPlayer.ffmpegPath` | `""` | Path to `ffmpeg`; `ffprobe` is looked up beside it |

## Usage

Open any supported audio file and the player takes over the tab. If another extension also handles the file type, right-click the file in the Explorer, choose **Open With...** and pick **Every Sound Player**.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Built by [gotnull](https://github.com/gotnull). Also building [SocialMesh](https://socialmesh.app).
