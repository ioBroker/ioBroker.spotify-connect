# ioBroker.spotify-connect

Spotify Connect receiver for ioBroker, based on the official [Spotify Soloist](https://developer.spotify.com/documentation/soloist) client.
The adapter appears as a Spotify Connect device in the Spotify app and streams the audio over HTTP to any player
that accepts a URL in a `media.url` state, for example the satellites of ioBroker.assistant
(ThirdReality Voice & Music Assistant).

```
Spotify app -> Soloist -> PipeWire null sink -> HTTP stream -> media.url state -> speaker
```

## Status

Early scaffold. The chain was verified manually on a Raspberry Pi (aarch64, Debian 13) with a ThirdReality speaker.

## Requirements

- Spotify Premium and a Soloist API key from https://developer.spotify.com/dashboard/soloist
- Soloist binary for your architecture
- PipeWire: `sudo apt install --no-install-recommends pipewire pipewire-pulse wireplumber pulseaudio-utils`
- ffmpeg

## Notes

- Soloist only accepts the API key on the command line, so it is visible in the process list to local users.
- Soloist builds expire after about 90 days and must be updated.

## Changelog

### 0.0.1
- initial scaffold

## License

MIT, Copyright (c) 2026 ioBroker GmbH
