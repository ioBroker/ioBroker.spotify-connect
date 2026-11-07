import * as utils from '@iobroker/adapter-core';

class SpotifyConnect extends utils.Adapter {
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'spotify-connect' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        if (!this.config.apiKey) {
            this.log.error('No Soloist API key configured');
            return;
        }
        // TODO: PipeWire + null sink, Soloist process, WebSocket API -> states, HTTP stream, target players
        this.log.info(`Spotify Connect device "${this.config.deviceName}" not implemented yet`);
    }

    private onUnload(callback: () => void): void {
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SpotifyConnect(options);
} else {
    (() => new SpotifyConnect())();
}
