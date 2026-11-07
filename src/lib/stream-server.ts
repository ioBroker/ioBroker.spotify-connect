import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

interface StreamLog {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
}

export interface StreamOptions {
    port: number;
    format: 'mp3' | 'flac';
    source: string; // pulse source, e.g. "<sink>.monitor"
    env: NodeJS.ProcessEnv;
}

const CONTENT_TYPE = { mp3: 'audio/mpeg', flac: 'audio/flac' };

/**
 * HTTP server that delivers what Soloist plays as a live stream.
 *
 * MP3: one shared encoder, every client gets the same bytes (late joiners resync on the next frame).
 * FLAC: one encoder per client, because each client needs the stream header.
 * Short probe requests (ioBroker.assistant checks the URL before handing it to the player) are fine.
 */
export class StreamServer {
    private server?: http.Server;
    private encoder?: ChildProcess;
    private clients = new Set<http.ServerResponse>();
    private idleTimer?: NodeJS.Timeout;

    public constructor(
        private readonly opts: StreamOptions,
        private readonly log: StreamLog,
        private readonly onClients: (count: number) => void,
    ) {}

    public get path(): string {
        return `/spotify.${this.opts.format}`;
    }

    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handle(req, res));
            server.once('error', reject);
            server.listen(this.opts.port, '0.0.0.0', () => {
                server.off('error', reject);
                this.server = server;
                this.log.info(`Stream available on port ${this.opts.port}${this.path}`);
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        for (const c of this.clients) {
            c.destroy();
        }
        this.clients.clear();
        this.stopEncoder();
        await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
        this.server = undefined;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.url?.split('?')[0] !== this.path) {
            res.writeHead(404).end();
            return;
        }
        this.log.debug(`${req.method} ${req.url} from ${req.socket.remoteAddress} (${req.headers['user-agent'] || ''})`);
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPE[this.opts.format],
            'Cache-Control': 'no-cache, no-store',
            Connection: 'close',
            'icy-name': 'Spotify Connect',
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        if (this.opts.format === 'flac') {
            const ff = this.spawnEncoder();
            ff.stdout?.pipe(res);
            this.clients.add(res);
            this.onClients(this.clients.size);
            res.on('close', () => {
                ff.kill('SIGKILL');
                this.clients.delete(res);
                this.onClients(this.clients.size);
            });
            return;
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        if (!this.encoder) {
            this.encoder = this.spawnEncoder();
            this.encoder.stdout?.on('data', (chunk: Buffer) => {
                for (const c of this.clients) {
                    // drop data for clients that cannot keep up instead of buffering without limit
                    if (c.writableLength < 1024 * 1024) {
                        c.write(chunk);
                    }
                }
            });
            this.encoder.on('exit', () => {
                this.encoder = undefined;
                for (const c of this.clients) {
                    c.end();
                }
            });
        }
        this.clients.add(res);
        this.onClients(this.clients.size);
        res.on('close', () => {
            this.clients.delete(res);
            this.onClients(this.clients.size);
            if (!this.clients.size) {
                this.idleTimer = setTimeout(() => this.stopEncoder(), 10_000);
            }
        });
    }

    private spawnEncoder(): ChildProcess {
        const codec =
            this.opts.format === 'flac'
                ? ['-c:a', 'flac', '-f', 'flac']
                : ['-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3'];
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'pulse', '-fragment_size', '4096', '-i', this.opts.source,
            '-ac', '2', '-ar', '44100',
            ...codec,
            'pipe:1',
        ];
        const ff = spawn('ffmpeg', args, { env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stderr?.on('data', d => this.log.warn(`ffmpeg: ${d.toString().trim()}`));
        return ff;
    }

    private stopEncoder(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        this.encoder?.kill('SIGKILL');
        this.encoder = undefined;
    }
}
