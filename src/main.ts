import * as utils from '@iobroker/adapter-core';
import { promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
    checkSystem,
    downloadSoloist,
    ensureOsPackages,
    getRemoteInfo,
    getVersion,
    type SoloistVersion,
} from './lib/installer';
import { PipeWire, SINK_NAME } from './lib/pipewire';
import { EXIT_EXPIRED, Soloist, type SoloistEntity } from './lib/soloist';
import { CHANNELS, STATES } from './lib/states';
import { StreamServer } from './lib/stream-server';

const DAY = 24 * 3600 * 1000;
/** Start updating this many days before the build expires. */
const UPDATE_FROM_DAYS = 30;
/** Restart for an update even during playback when the build expires within this many days. */
const FORCE_RESTART_DAYS = 3;

class SpotifyConnect extends utils.Adapter {
    private pipewire?: PipeWire;
    private soloist?: Soloist;
    private stream?: StreamServer;
    private binary = '';
    private soloistDir = '';
    private soloistVer: SoloistVersion | null = null;
    private updateTimer?: NodeJS.Timeout;
    private restartTimer?: NodeJS.Timeout;
    private stopTimer?: NodeJS.Timeout;
    private restartDelay = 5000;
    private pendingRestart = false;
    private unloading = false;
    private streamUrl = '';
    private status = 'idle';
    private active = false;
    private loggedIn = false;
    private loginReported = false;
    private targetsPlaying = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'spotify-connect' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        await this.createStates();
        this.subscribeStates('control.*');

        const c = this.config;
        if (!c.apiKey || !c.apiKey.startsWith('spak_')) {
            this.log.error('No valid Soloist API key configured. See the instance settings for how to get one.');
            return;
        }

        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.soloistDir = join(dataDir, 'soloist');
        this.binary = join(this.soloistDir, 'soloist');
        await fs.mkdir(join(dataDir, 'data'), { recursive: true });
        await fs.mkdir(join(dataDir, 'cache'), { recursive: true });

        // 0. Can Soloist run here at all? An unsupported OS cannot be fixed by retrying.
        const systemError = await checkSystem();
        if (systemError) {
            this.log.error(systemError);
            await this.setState('info.updateError', systemError, true);
            return;
        }

        // 1. Debian packages
        try {
            const missing = await ensureOsPackages(this.log);
            if (missing.length) {
                this.log.error(
                    `Missing packages that could not be installed automatically: ${missing.join(', ')}. Please run: sudo apt-get install ${missing.join(' ')}`,
                );
                return;
            }
        } catch (e) {
            this.log.error((e as Error).message);
            return;
        }

        // 2. Soloist binary
        this.soloistVer = await getVersion(this.binary);
        if (!this.soloistVer || this.daysLeft() <= 0) {
            try {
                await this.install();
            } catch (e) {
                this.log.error(`Cannot install Spotify Soloist: ${(e as Error).message}. Retrying in 1 hour.`);
                await this.setState('info.updateError', (e as Error).message, true);
                this.restartTimer = this.setTimeout(() => this.restartAdapter(), 3600_000) as any;
                return;
            }
        }
        await this.updateVersionStates();

        // 3. Audio, stream, Soloist
        try {
            this.pipewire = new PipeWire(dataDir, this.log, name => this.onAudioCrash(name));
            await this.pipewire.start();

            this.stream = new StreamServer(
                {
                    port: c.streamPort || 8097,
                    format: c.format || 'mp3',
                    source: `${SINK_NAME}.monitor`,
                    env: this.pipewire.env,
                },
                this.log,
                n => void this.setState('stream.clients', n, true),
            );
            await this.stream.start();
        } catch (e) {
            this.log.error(`Cannot start audio: ${(e as Error).message}`);
            return;
        }
        this.streamUrl = `http://${c.streamHost || this.detectHost()}:${c.streamPort || 8097}${this.stream.path}`;
        await this.setState('stream.url', this.streamUrl, true);
        this.log.info(`Players will receive ${this.streamUrl}`);

        this.startSoloist();

        // 4. Daily update check, first one shortly after start
        this.scheduleUpdateCheck(60_000);
    }

    private daysLeft(): number {
        return this.soloistVer ? Math.floor((this.soloistVer.expiresAt - Date.now()) / DAY) : 0;
    }

    private async install(): Promise<void> {
        const { version, remote } = await downloadSoloist(this.soloistDir, this.log);
        this.soloistVer = version;
        await fs.writeFile(join(this.soloistDir, 'remote.json'), JSON.stringify(remote));
        await this.setState('info.updateError', '', true);
    }

    private async updateVersionStates(): Promise<void> {
        if (!this.soloistVer) {
            return;
        }
        await this.setState('info.soloistVersion', this.soloistVer.version, true);
        await this.setState(
            'info.buildDate',
            new Date(this.soloistVer.buildTimestamp * 1000).toISOString().slice(0, 10),
            true,
        );
        await this.setState('info.expiresInDays', this.daysLeft(), true);
    }

    private scheduleUpdateCheck(delay: number): void {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }
        this.updateTimer = this.setTimeout(async () => {
            await this.checkUpdate(false);
            // check more often when expiry is near, the boat may be offline for a while
            this.scheduleUpdateCheck(this.daysLeft() <= UPDATE_FROM_DAYS ? 6 * 3600_000 : DAY);
        }, delay) as any;
    }

    /** Downloads a newer Soloist build if Spotify offers one. Returns true if a new binary was installed. */
    private async checkUpdate(force: boolean): Promise<boolean> {
        await this.setState('info.lastUpdateCheck', Date.now(), true);
        await this.setState('info.expiresInDays', this.daysLeft(), true);
        try {
            const remote = await getRemoteInfo();
            let known: { lastModified?: string; etag?: string } = {};
            try {
                known = JSON.parse(await fs.readFile(join(this.soloistDir, 'remote.json'), 'utf8'));
            } catch {
                // first check after a manual installation
            }
            const changed =
                (remote.etag && remote.etag !== known.etag) ||
                (remote.lastModified && remote.lastModified !== known.lastModified);
            if (!changed && !force) {
                if (this.daysLeft() <= UPDATE_FROM_DAYS) {
                    this.log.info(`Soloist build expires in ${this.daysLeft()} days, no newer build available yet`);
                }
                return false;
            }
            const before = this.soloistVer?.buildTimestamp || 0;
            await this.install();
            await this.updateVersionStates();
            if ((this.soloistVer?.buildTimestamp || 0) <= before) {
                return false;
            }
            this.log.info('New Soloist build installed, restart scheduled');
            this.pendingRestart = true;
            this.restartSoloistIfIdle();
            return true;
        } catch (e) {
            const msg = (e as Error).message;
            await this.setState('info.updateError', msg, true);
            if (this.daysLeft() <= 14) {
                this.log.warn(`Soloist update failed (${msg}). The build expires in ${this.daysLeft()} days.`);
                await this.notify(
                    `Spotify Soloist could not be updated (${msg}). The current build expires in ${this.daysLeft()} days. Please check the internet connection.`,
                );
            } else {
                this.log.debug(`Update check failed: ${msg}`);
            }
            return false;
        }
    }

    private restartSoloistIfIdle(): void {
        if (!this.pendingRestart) {
            return;
        }
        const busy = this.active && (this.status === 'playing' || this.status === 'buffering');
        if (busy && this.daysLeft() > FORCE_RESTART_DAYS) {
            return; // retried on the next status change
        }
        this.pendingRestart = false;
        void this.soloist?.stop().then(() => this.startSoloist());
    }

    private startSoloist(): void {
        if (this.unloading || !this.pipewire) {
            return;
        }
        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        const s = new Soloist(
            {
                binary: this.binary,
                deviceName: this.config.deviceName || 'ioBroker',
                apiKey: this.config.apiKey,
                dataDir: join(dataDir, 'data'),
                cacheDir: join(dataDir, 'cache'),
                sink: SINK_NAME,
                wsPort: this.config.apiPort || 9090,
                initialVolume: 100,
                env: this.pipewire.env,
            },
            this.log,
        );
        this.soloist = s;
        s.on('message', msg => void this.onApiMessage(msg));
        s.on('expires', days => void this.setState('info.expiresInDays', days, true));
        s.on('api', connected => {
            if (!connected) {
                this.loginReported = false;
                void this.setState('info.connection', false, true);
            }
        });
        s.on('exit', async (code: number) => {
            await this.setState('info.connection', false, true);
            await this.onPlayback('idle', false);
            if (this.unloading) {
                return;
            }
            if (code === EXIT_EXPIRED) {
                this.log.warn('Soloist build expired, downloading a new one');
                await this.checkUpdate(true);
                this.restartDelay = 5000;
            } else {
                this.log.warn(`Soloist exited with code ${code}, restarting in ${this.restartDelay / 1000}s`);
            }
            this.restartTimer = this.setTimeout(() => this.startSoloist(), this.restartDelay) as any;
            this.restartDelay = Math.min(this.restartDelay * 2, 300_000);
        });
        s.start();
    }

    private onAudioCrash(name: string): void {
        if (this.unloading) {
            return;
        }
        this.log.error(`Audio service ${name} stopped, restarting adapter`);
        this.restartAdapter();
    }

    private restartAdapter(): void {
        this.unloading = true;
        void this.cleanup().then(() => this.restart());
    }

    // ---- WebSocket API events -------------------------------------------------------------

    private async onApiMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'auth_state': {
                const loggedIn = !!msg.logged_in;
                this.restartDelay = 5000;
                if (loggedIn !== this.loggedIn || !this.loginReported) {
                    this.loginReported = true;
                    if (loggedIn) {
                        this.log.info(`Spotify Connect device "${msg.device_name}" is ready`);
                    } else {
                        this.log.info(
                            `Waiting for login: open the Spotify app and select "${msg.device_name}" as device`,
                        );
                    }
                }
                this.loggedIn = loggedIn;
                await this.setState('info.loggedIn', loggedIn, true);
                await this.setState('info.connection', loggedIn, true);
                await this.onPlayback(this.status, !!msg.is_active);
                break;
            }
            case 'playback_state':
                await this.setItem(msg.item);
                await this.setContext(msg.context);
                await this.setPosition(msg.position);
                await this.setOptions(msg.options);
                if (typeof msg.volume === 'number') {
                    await this.setState('control.volume', msg.volume, true);
                }
                await this.onPlayback(msg.status, !!msg.is_active);
                break;
            case 'track_changed':
                await this.setItem(msg.item);
                break;
            case 'context_changed':
                await this.setContext(msg.context);
                break;
            case 'playback_changed':
                await this.onPlayback(msg.status, this.active);
                break;
            case 'device_changed':
                await this.onPlayback(this.status, !!msg.is_active);
                break;
            case 'volume_changed':
                await this.setState('control.volume', msg.volume, true);
                break;
            case 'options_changed':
                await this.setOptions(msg.options);
                break;
            case 'position_sync':
                await this.setPosition(msg.position);
                break;
            case 'error':
                this.log.warn(`Soloist: ${msg.message}`);
                break;
            default:
                break;
        }
    }

    private async setItem(item?: SoloistEntity): Promise<void> {
        const d = item?.decorations;
        const covers = d?.visual_identity?.cover || [];
        const cover =
            (covers.find(c => c.size === 'large') || covers.find(c => c.size === 'xlarge') || covers[0])?.url || '';
        await this.setState('player.title', d?.identity?.name || '', true);
        await this.setState(
            'player.artist',
            (d?.creators || [])
                .map(c => c.entity?.decorations?.identity?.name)
                .filter(Boolean)
                .join(', '),
            true,
        );
        await this.setState('player.album', d?.parent?.entity?.decorations?.identity?.name || '', true);
        await this.setState('player.cover', cover, true);
        await this.setState('player.uri', item?.uri || '', true);
        await this.setState('player.duration', Math.round((d?.playback?.duration_ms || 0) / 1000), true);
    }

    private async setContext(ctx?: SoloistEntity): Promise<void> {
        await this.setState('player.context', ctx?.decorations?.identity?.name || ctx?.uri || '', true);
    }

    private async setPosition(pos?: { position_ms: number }): Promise<void> {
        if (pos) {
            await this.setState('player.elapsed', Math.round(pos.position_ms / 1000), true);
        }
    }

    private async setOptions(opt?: { shuffle?: boolean; repeat?: string }): Promise<void> {
        if (!opt) {
            return;
        }
        if (typeof opt.shuffle === 'boolean') {
            await this.setState('player.shuffle', opt.shuffle, true);
            await this.setState('control.shuffle', opt.shuffle, true);
        }
        if (opt.repeat) {
            await this.setState('player.repeat', opt.repeat, true);
            await this.setState('control.repeat', opt.repeat, true);
        }
    }

    /** Central place that decides whether the target players should play our stream. */
    private async onPlayback(status: string, active: boolean): Promise<void> {
        this.status = status || 'idle';
        this.active = active;
        await this.setState('player.status', this.status, true);
        await this.setState('info.active', active, true);

        const shouldPlay = active && (this.status === 'playing' || this.status === 'buffering');
        if (shouldPlay) {
            if (this.stopTimer) {
                clearTimeout(this.stopTimer);
                this.stopTimer = undefined;
            }
            if (!this.targetsPlaying) {
                this.targetsPlaying = true;
                await this.sendToTargets(this.streamUrl);
            }
        } else if (this.targetsPlaying && !this.stopTimer) {
            const sec = Math.max(0, Number(this.config.stopAfterSec) || 0);
            this.stopTimer = this.setTimeout(async () => {
                this.stopTimer = undefined;
                this.targetsPlaying = false;
                await this.sendToTargets('stop');
            }, sec * 1000) as any;
        }
        this.restartSoloistIfIdle();
    }

    private async sendToTargets(value: string): Promise<void> {
        for (const t of this.config.targets || []) {
            if (!t?.id || t.enabled === false) {
                continue;
            }
            try {
                if (value === 'stop') {
                    // only stop players that still play our stream
                    const cur = await this.getForeignStateAsync(t.id);
                    if (cur && cur.val && cur.val !== this.streamUrl) {
                        continue;
                    }
                }
                this.log.debug(`${value === 'stop' ? 'Stopping' : 'Starting'} ${t.id}`);
                await this.setForeignStateAsync(t.id, value, false);
            } catch (e) {
                this.log.warn(`Cannot control ${t.id}: ${(e as Error).message}`);
            }
        }
    }

    // ---- Commands ----------------------------------------------------------------------------

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack || !this.soloist) {
            return;
        }
        const key = id.substring(this.namespace.length + 1);
        const s = this.soloist;
        let ok = true;
        switch (key) {
            case 'control.play':
                ok = s.command('play');
                break;
            case 'control.pause':
                ok = s.command('pause');
                break;
            case 'control.next':
                ok = s.command('skip_next');
                break;
            case 'control.previous':
                ok = s.command('skip_prev');
                break;
            case 'control.activate':
                ok = s.command('activate');
                break;
            case 'control.volume':
                ok = s.command('set_volume', { volume: Math.max(0, Math.min(100, Math.round(Number(state.val)))) });
                break;
            case 'control.seek':
                ok = s.command('seek', { position_ms: Math.round(Number(state.val) * 1000) });
                break;
            case 'control.shuffle':
                ok = s.command('set_shuffle', { enabled: !!state.val });
                break;
            case 'control.repeat': {
                const mode = String(state.val);
                if (mode === 'track') {
                    s.command('set_repeat_context', { enabled: false });
                    ok = s.command('set_repeat_track', { enabled: true });
                } else {
                    s.command('set_repeat_track', { enabled: false });
                    ok = s.command('set_repeat_context', { enabled: mode === 'context' });
                }
                break;
            }
            case 'control.playUri':
                if (state.val) {
                    ok = s.command('play', { uri: String(state.val) });
                }
                break;
            default:
                return;
        }
        if (!ok) {
            this.log.warn(`Command ${key} not sent: Soloist is not ready`);
        } else if (key.startsWith('control.') && STATES[key]?.role.startsWith('button')) {
            void this.setState(key, false, true);
        }
    }

    // ---- Helpers -----------------------------------------------------------------------------

    private async createStates(): Promise<void> {
        for (const [ch, name] of Object.entries(CHANNELS)) {
            await this.extendObjectAsync(ch, { type: 'channel', common: { name }, native: {} });
        }
        for (const [id, d] of Object.entries(STATES)) {
            const common: ioBroker.StateCommon = {
                name: d.name,
                type: d.type,
                role: d.role,
                read: d.read !== false,
                write: !!d.write,
            };
            if (d.unit) {
                common.unit = d.unit;
            }
            if (d.states) {
                common.states = d.states;
            }
            if (d.min !== undefined) {
                common.min = d.min;
            }
            if (d.max !== undefined) {
                common.max = d.max;
            }
            if (d.def !== undefined) {
                common.def = d.def;
            }
            await this.extendObjectAsync(id, { type: 'state', common, native: {} });
        }
    }

    /** First IPv4 address of a real network interface (skips docker, bridges, VPN). */
    private detectHost(): string {
        const skip = /^(lo|docker|br-|veth|virbr|tailscale|zt|wg|tun|tap)/;
        const ifs = networkInterfaces();
        for (const [name, addrs] of Object.entries(ifs)) {
            if (skip.test(name)) {
                continue;
            }
            const a = addrs?.find(x => x.family === 'IPv4' && !x.internal);
            if (a) {
                return a.address;
            }
        }
        return '127.0.0.1';
    }

    private async notify(message: string): Promise<void> {
        try {
            await (this as any).registerNotification('spotify-connect', 'soloistUpdate', message);
        } catch {
            this.log.warn(message);
        }
    }

    private async cleanup(): Promise<void> {
        for (const t of [this.updateTimer, this.restartTimer, this.stopTimer]) {
            if (t) {
                clearTimeout(t);
            }
        }
        if (this.targetsPlaying) {
            this.targetsPlaying = false;
            await this.sendToTargets('stop');
        }
        await this.soloist?.stop();
        await this.stream?.stop();
        await this.pipewire?.stop();
    }

    private onUnload(callback: () => void): void {
        this.unloading = true;
        const done = setTimeout(callback, 4000);
        void this.cleanup()
            .catch(() => undefined)
            .finally(() => {
                clearTimeout(done);
                callback();
            });
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SpotifyConnect(options);
} else {
    (() => new SpotifyConnect())();
}
