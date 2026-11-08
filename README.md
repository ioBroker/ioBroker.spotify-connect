![Logo](admin/spotify-connect.png)

# ioBroker.spotify-connect

[![Test](https://github.com/ioBroker/ioBroker.spotify-connect/actions/workflows/test.yml/badge.svg)](https://github.com/ioBroker/ioBroker.spotify-connect/actions/workflows/test.yml)

**Spotify Connect receiver for ioBroker.** The adapter appears as a speaker in the Spotify app on your phone or PC.
Whatever you play there is streamed over HTTP to any player in ioBroker that accepts a URL, for example
the satellites of `ioBroker.assistant` (ThirdReality Voice & Music Assistant), Dune HD players or other
devices with a `media.url` state.

It is based on [Spotify Soloist](https://developer.spotify.com/documentation/soloist), the official headless
Spotify Connect client from Spotify. It does not use reverse engineered Spotify clients.

```
Spotify app  ->  Soloist  ->  PipeWire null sink  ->  HTTP stream  ->  media.url state  ->  speaker
```

## Requirements

- Linux on arm64 (Raspberry Pi 3/4/5), armv7 or x86_64 based on Debian or Ubuntu. Alpine (musl) is not supported.
- Spotify's Soloist builds need **glibc 2.38 or newer** (Debian 13 Trixie, Raspberry Pi OS based on Trixie,
  Ubuntu 24.04 or newer). On older systems like Debian 12 / Raspberry Pi OS Bookworm (glibc 2.36) the adapter
  downloads `libc6` and `libatomic1` from Debian 13 into its own data folder (about 3 MB) and starts Soloist
  with this glibc. The system libraries are not changed. An OS upgrade is still the cleaner solution.
- Docker: the official ioBroker image v12 or newer (Debian 13 Trixie) runs Soloist directly, older images use
  the private glibc described above. Packages installed by the adapter are lost when the container is recreated,
  so add them to the container environment:
  `PACKAGES="pipewire pipewire-pulse wireplumber pulseaudio-utils ffmpeg"`.
- A Spotify **Premium** account to create the Soloist API key. Free accounts can play on the device afterwards.
- Internet access at least every few weeks (Soloist builds expire after 90 days, see below).

Everything else is set up by the adapter:

- missing system packages (`pipewire`, `pipewire-pulse`, `wireplumber`, `pulseaudio-utils`, `ffmpeg`) are
  installed with `sudo apt-get`, which standard ioBroker installations allow,
- Spotify Soloist is downloaded from Spotify's servers on first start,
- a private PipeWire instance is started for the adapter. It needs no login session and does not touch
  sound cards or Bluetooth devices of the system.

## Getting the Soloist API key

1. Log in to the [Spotify for Developers dashboard](https://developer.spotify.com/dashboard) with your Spotify account
   and accept the developer terms if asked.
2. Open the [Spotify Soloist API Key page](https://developer.spotify.com/dashboard/soloist).
3. Accept the Spotify terms if asked and generate the key.
4. Copy the key (it starts with `spak_`) into the instance settings.

Do not share the key. Every user must generate an own key.

The same instructions with direct links are shown in the instance settings.

## Configuration

| Tab      | Setting                  | Description                                                                             |
|----------|--------------------------|-----------------------------------------------------------------------------------------|
| Spotify  | Soloist API key          | Key from the Soloist API key page, stored encrypted                                     |
| Spotify  | Device name              | Name shown in the Spotify app, e.g. "Living room"                                       |
| Players  | Players                  | States with role `media.url` that receive the stream URL while you play                 |
| Players  | Stop players after pause | Seconds after a pause until the players are stopped (default 30)                        |
| Advanced | Address                  | Address the players use to reach ioBroker. Empty = detected automatically               |
| Advanced | Stream port              | HTTP port of the stream (default 8097)                                                  |
| Advanced | Stream format            | MP3 256 kbit/s or FLAC                                                                  |
| Advanced | Local Soloist API port   | Port of the Soloist WebSocket API on 127.0.0.1 (default 9090). Must differ per instance |

For a ThirdReality speaker in `ioBroker.assistant` use
`assistant.0.satellites.<Name>.controls.linux_voice_assistant_media_player.url`.

On the first use open the Spotify app, tap the device icon and select the device name. This logs Soloist into
your account. The login is stored and survives restarts.

Several rooms: create one instance per Spotify Connect device, each with its own device name, stream port and API port.

## States

| State                                                               | Description                                           |
|---------------------------------------------------------------------|-------------------------------------------------------|
| `info.connection`                                                   | Soloist runs and is logged in to Spotify              |
| `info.loggedIn`, `info.active`                                      | Logged in / this is the active Spotify Connect device |
| `info.soloistVersion`, `info.buildDate`, `info.expiresInDays`       | Installed Soloist build and remaining lifetime        |
| `info.lastUpdateCheck`, `info.updateError`                          | Result of the last update check                       |
| `player.status`                                                     | `idle`, `playing`, `paused` or `buffering`            |
| `player.title`, `player.artist`, `player.album`, `player.cover`     | Current track                                         |
| `player.duration`, `player.elapsed`                                 | Duration and position in seconds                      |
| `player.context`, `player.uri`                                      | Playlist or album, Spotify URI of the track           |
| `player.shuffle`, `player.repeat`                                   | Playback options                                      |
| `control.play`, `control.pause`, `control.next`, `control.previous` | Buttons                                               |
| `control.volume`                                                    | Volume 0 to 100                                       |
| `control.seek`                                                      | Jump to position (seconds)                            |
| `control.shuffle`, `control.repeat`                                 | Shuffle on/off, repeat `off`, `context` or `track`    |
| `control.playUri`                                                   | Play a Spotify URI (track, album, playlist, episode)  |
| `control.activate`                                                  | Make this the active device                           |
| `stream.url`, `stream.clients`                                      | Stream URL and number of connected players            |

## Soloist updates

Spotify Soloist builds stop working 90 days after their build date. The adapter takes care of it:

- it checks Spotify's download server daily, every 6 hours when less than 30 days are left,
- a new build is downloaded, tested and installed; the old binary is kept as `soloist.bak`,
- Soloist is restarted with the new build when nothing is playing, at the latest 3 days before expiry,
- if a build has expired (exit code 10), a new one is downloaded immediately,
- if updates fail, for example without internet, an ioBroker notification is shown.

Spotify does not allow redistributing Soloist, so the adapter never ships the binary. It always downloads it from
Spotify's official download server on your device.

## Notes

- Soloist accepts the API key only as a command line argument, so local users of the system can see it in the
  process list.
- The players are not synchronized with each other. For synchronized multiroom audio a different protocol is needed.
- By using Spotify Soloist you accept the [Spotify Terms and Conditions of Use](https://www.spotify.com/legal/end-user-agreement/).
- Spotify is a trademark of Spotify AB. This adapter is not affiliated with or endorsed by Spotify.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.4 (2026-11-08)
- (@GermanBluefox) No restart loop if PipeWire cannot run: the adapter restarts with a growing delay (30s up to 30 min)
- (@GermanBluefox) Log the output of PipeWire/WirePlumber when they exit, so the reason is visible without debug level

### 0.1.3 (2026-11-07)
- (@GermanBluefox) Debian 12 / Raspberry Pi OS Bookworm: Soloist is started with a private glibc from Debian 13

### 0.1.2 (2026-11-07)
- (@GermanBluefox) Check glibc version on start: Soloist needs glibc 2.38+ (Debian 13, Ubuntu 24.04), not Debian 12
- (@GermanBluefox) Log the real reason when the downloaded Soloist binary does not start

### 0.1.1 (2026-11-07)
- (@GermanBluefox) Updated packages

### 0.1.0 (2026-11-07)
- (@GermanBluefox) initial release: Spotify Connect receiver based on Spotify Soloist with automatic installation and updates

## License

MIT License

Copyright (c) 2026 Denis Haev <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
