import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { soloistCommand } from './installer';
import { sleep } from './run';

/** Spotify Soloist exits with this code when its build has expired. */
export const EXIT_EXPIRED = 10;

export interface SoloistOptions {
    binary: string;
    /** Folder of the private glibc, null to start the binary directly */
    runtime: string | null;
    deviceName: string;
    apiKey: string;
    dataDir: string;
    cacheDir: string;
    wsPort: number;
    initialVolume: number;
    /** Soloist logs everything, for debug log level */
    verbose: boolean;
    env: NodeJS.ProcessEnv;
}

interface SoloistLog {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
    error(msg: string): void;
}

export interface SoloistEntity {
    uri?: string;
    entity_type?: string;
    decorations?: {
        identity?: { name?: string };
        visual_identity?: { cover?: { url: string; size: string }[] };
        parent?: { entity?: SoloistEntity };
        creators?: { entity?: SoloistEntity }[];
        playback?: { duration_ms?: number };
    };
}

/**
 * Runs the Soloist daemon and talks to its local WebSocket API.
 *
 * Events: "message" (API event object), "exit" (code), "expires" (days), "api" (connected: boolean)
 */
export class Soloist extends EventEmitter {
    private proc?: ChildProcess;
    private ws?: WebSocket;
    private stopping = false;
    private wsTimer?: NodeJS.Timeout;

    public constructor(
        private readonly opts: SoloistOptions,
        private readonly log: SoloistLog,
    ) {
        super();
    }

    public get running(): boolean {
        return !!this.proc && this.proc.exitCode === null;
    }

    public start(): void {
        this.stopping = false;
        const o = this.opts;
        const args = [
            '-n',
            o.deviceName,
            '-k',
            o.apiKey,
            '-D',
            o.dataDir,
            '-C',
            o.cacheDir,
            '-z',
            '200',
            '-i',
            String(o.initialVolume),
            '-w',
            `127.0.0.1:${o.wsPort}`,
        ];
        if (o.verbose) {
            args.push('--verbose');
        }
        this.log.info(`Starting Spotify Soloist as "${o.deviceName}"`);
        const c = soloistCommand(o.binary, o.runtime);
        const p = spawn(c.cmd, [...c.args, ...args], { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = p;

        const onLine = (data: Buffer): void => {
            for (const line of data.toString().split('\n')) {
                const l = line.trim();
                if (!l) {
                    continue;
                }
                this.log.debug(`soloist: ${l}`);
                const exp = l.match(/expires in (\d+) days?/i);
                if (exp) {
                    this.emit('expires', parseInt(exp[1], 10));
                }
                if (/\b(error|failed)\b/i.test(l) && !/websocket/i.test(l)) {
                    this.log.warn(`soloist: ${l.replace(/^[\d-]+ [\d:.]+:\s*/, '')}`);
                }
                // libpulse could not be loaded or connected: everything seems to work, but there is no sound
                if (/using dummy/i.test(l)) {
                    this.log.error(
                        `Soloist has no audio output (${l.replace(/^[\d-]+ [\d:.]+:\s*/, '')}). Is libpulse0 installed?`,
                    );
                }
                if (/websocket server listening/i.test(l)) {
                    this.connectApi();
                }
            }
        };
        p.stdout?.on('data', onLine);
        p.stderr?.on('data', onLine);
        p.on('exit', code => {
            this.proc = undefined;
            this.closeApi();
            if (!this.stopping) {
                this.emit('exit', code ?? -1);
            }
        });
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        this.closeApi();
        const p = this.proc;
        if (!p) {
            return;
        }
        p.kill('SIGTERM');
        for (let i = 0; i < 30 && p.exitCode === null; i++) {
            await sleep(100);
        }
        if (p.exitCode === null) {
            p.kill('SIGKILL');
        }
        this.proc = undefined;
    }

    /** Sends a command to the WebSocket API, e.g. ("set_volume", { volume: 50 }). */
    public command(command: string, fields: Record<string, unknown> = {}): boolean {
        if (this.ws?.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.ws.send(JSON.stringify({ type: 'command', command, ...fields }));
        return true;
    }

    private connectApi(): void {
        this.closeApi();
        if (this.stopping) {
            return;
        }
        const ws = new WebSocket(`ws://127.0.0.1:${this.opts.wsPort}`);
        this.ws = ws;
        ws.on('open', () => {
            this.emit('api', true);
            this.command('get_auth_state');
        });
        ws.on('message', (data: WebSocket.RawData) => {
            const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            const text = buf.toString('utf8');
            try {
                this.emit('message', JSON.parse(text));
            } catch {
                this.log.debug(`Invalid API message: ${text}`);
            }
        });
        ws.on('error', err => this.log.debug(`API error: ${err.message}`));
        ws.on('close', () => {
            this.emit('api', false);
            if (this.ws === ws && !this.stopping && this.running) {
                this.wsTimer = setTimeout(() => this.connectApi(), 2000);
            }
        });
    }

    private closeApi(): void {
        if (this.wsTimer) {
            clearTimeout(this.wsTimer);
            this.wsTimer = undefined;
        }
        const ws = this.ws;
        this.ws = undefined;
        if (ws) {
            ws.removeAllListeners('close');
            ws.on('error', () => undefined);
            ws.close();
            this.emit('api', false);
        }
    }
}
