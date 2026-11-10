import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import http from 'node:http';

interface StreamLog {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
    error(msg: string): void;
}

export interface StreamOptions {
    port: number;
    format: 'mp3' | 'flac';
    /** Path of the ffmpeg binary */
    ffmpeg: string;
    /** Emits "pcm" with Buffers of s16le samples */
    source: EventEmitter;
    sampleRate: number;
    channels: number;
}

const CONTENT_TYPE = { mp3: 'audio/mpeg', flac: 'audio/flac' };
/** An encoder or client that is further behind than this loses audio instead of growing the buffer without limit. */
const MAX_BACKLOG = 1024 * 1024;

/**
 * HTTP server that delivers what Soloist plays as a live stream.
 *
 * MP3: one shared encoder, every client gets the same bytes (late joiners resync on the next frame).
 * FLAC: one encoder per client, because each client needs the stream header.
 * Short probe requests (ioBroker.assistant checks the URL before handing it to the player) are fine.
 */
export class StreamServer {
    private server?: http.Server;
    /** The shared MP3 encoder */
    private encoder?: ChildProcess;
    /** All running encoders, they all get the PCM */
    private readonly encoders = new Set<ChildProcess>();
    private clients = new Set<http.ServerResponse>();
    private idleTimer?: NodeJS.Timeout;
    private readonly onPcm = (pcm: Buffer): void => {
        for (const ff of this.encoders) {
            if (ff.stdin?.writable && ff.stdin.writableLength < MAX_BACKLOG) {
                ff.stdin.write(pcm);
            }
        }
    };

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
                this.opts.source.on('pcm', this.onPcm);
                this.log.info(`Stream available on port ${this.opts.port}${this.path}`);
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        this.opts.source.off('pcm', this.onPcm);
        for (const c of this.clients) {
            c.destroy();
        }
        this.clients.clear();
        this.stopEncoder();
        for (const ff of this.encoders) {
            ff.kill('SIGKILL');
        }
        await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
        this.server = undefined;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.url?.split('?')[0] !== this.path) {
            res.writeHead(404).end();
            return;
        }
        this.log.debug(
            `${req.method} ${req.url} from ${req.socket.remoteAddress} (${req.headers['user-agent'] || ''})`,
        );
        // Send the endless stream like an internet radio: no Content-Length and no chunked
        // encoding, the body simply ends when the connection closes. ESPHome media players
        // (ESP-IDF HTTP client) hang when they stop a chunked stream and ignore later URLs.
        res.useChunkedEncodingByDefault = false;
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
        // do not make the client wait for the first encoded audio
        res.flushHeaders();

        if (this.opts.format === 'flac') {
            const ff = this.spawnEncoder(() => res.end());
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
            const encoder = this.spawnEncoder(() => {
                if (this.encoder === encoder) {
                    this.encoder = undefined;
                }
                for (const c of this.clients) {
                    c.end();
                }
            });
            this.encoder = encoder;
            encoder.stdout?.on('data', (chunk: Buffer) => {
                for (const c of this.clients) {
                    // drop data for clients that cannot keep up instead of buffering without limit
                    if (c.writableLength < MAX_BACKLOG) {
                        c.write(chunk);
                    }
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

    /** @param onEnd called once when the encoder has exited or could not be started */
    private spawnEncoder(onEnd: () => void): ChildProcess {
        const codec =
            this.opts.format === 'flac'
                ? ['-c:a', 'flac', '-f', 'flac']
                : ['-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3'];
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            // the format is known: without this, ffmpeg analyzes about 2 seconds of input before it delivers anything
            '-probesize',
            '32',
            '-analyzeduration',
            '0',
            '-f',
            's16le',
            '-ar',
            String(this.opts.sampleRate),
            '-ac',
            String(this.opts.channels),
            '-i',
            'pipe:0',
            ...codec,
            '-flush_packets',
            '1',
            'pipe:1',
        ];
        const ff = spawn(this.opts.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.encoders.add(ff);
        ff.stdin?.on('error', err => this.log.debug(`ffmpeg input: ${err.message}`));
        ff.stderr?.on('data', d => this.log.warn(`ffmpeg: ${d.toString().trim()}`));
        const ended = (): void => {
            // a process that could not be started emits "error", but not "exit"
            if (this.encoders.delete(ff)) {
                onEnd();
            }
        };
        ff.on('error', err => {
            this.log.error(`Cannot start ffmpeg: ${err.message}`);
            ended();
        });
        ff.on('exit', ended);
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
