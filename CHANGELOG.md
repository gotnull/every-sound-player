# Changelog

## 0.2.0

- Drag across the waveform to loop a region. `Esc` clears it.
- Loop toggle, playback speed from 0.5x to 2x, and a mute button.
- The header now shows the file's real codec, sample rate, bit depth, channels and bitrate, read with `afinfo` on macOS or `ffprobe` elsewhere. It used to report the sample rate of the decoder rather than the file.
- Peak and RMS levels in dBFS, plus a count of clipped samples.
- Times under a minute show hundredths of a second, and a hover tooltip shows the time under the cursor.
- The player reloads when the file changes on disk and keeps the playback position.
- Starting one player pauses the others.
- Volume is remembered between files.
- New keyboard shortcuts: `Shift` with the arrow keys for 1 second steps, `Up` and `Down` for volume, `Home`, `End`, `0` to `9`, `L`, `M`, `[`, `]` and `\`.
- `ffmpeg` fallback for files `afconvert` can't read, and for Linux and Windows. Adds `wma`, `wv`, `ape`, `mka`, `mp2`, `dts`, `eac3`, `caff`, `m4b` and `m4r`.
- Settings for autoplay, default loop, reload on change and the ffmpeg path.
- Audio is sent to the player as binary instead of base64, which loads large files faster.
- New icon.

## 0.1.1

- Files the editor's built-in decoder rejects, such as Ogg Opus in some VS Code builds, are converted to WAV with `afconvert` and played instead of failing with `SRC_NOT_SUPPORTED`.

## 0.1.0

- First release.
