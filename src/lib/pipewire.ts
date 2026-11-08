import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { run, sleep } from './run';

export const SINK_NAME = 'spotify_connect_sink';

interface PwLog {
    debug(msg: string): void;
    warn(msg: string): void;
}

/**
 * Private PipeWire instance (pipewire + wireplumber + pipewire-pulse) in its own runtime
 * directory. It needs neither a login session nor D-Bus and does not touch other audio users.
 */
export class PipeWire {
    private procs: ChildProcess[] = [];
    private stopping = false;
    /** True while start() runs: a process that dies then makes start() fail instead of calling onCrash */
    private starting = false;
    /** Process that exited during start() and why */
    private died = '';
    /** Last output lines of each process, logged when it exits */
    private readonly tail = new Map<string, string[]>();
    public readonly runtimeDir: string;
    private readonly configDir: string;

    public constructor(
        baseDir: string,
        private readonly log: PwLog,
        private readonly onCrash: (name: string, reason: string) => void,
    ) {
        this.runtimeDir = join(baseDir, 'run');
        this.configDir = join(baseDir, 'config');
    }

    /** Environment that points PipeWire/Pulse clients (Soloist, pactl, ffmpeg) to this instance. */
    public get env(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            XDG_RUNTIME_DIR: this.runtimeDir,
            PIPEWIRE_RUNTIME_DIR: this.runtimeDir,
            PULSE_RUNTIME_PATH: join(this.runtimeDir, 'pulse'),
            PULSE_SERVER: `unix:${join(this.runtimeDir, 'pulse', 'native')}`,
        };
        delete env.DBUS_SESSION_BUS_ADDRESS;
        return env;
    }

    /** Starts PipeWire, WirePlumber and pipewire-pulse. On failure everything is stopped again. */
    public async start(): Promise<void> {
        this.stopping = false;
        this.starting = true;
        this.died = '';
        try {
            await this.doStart();
        } catch (e) {
            const reason = this.died || (e as Error).message;
            await this.stop();
            throw new Error(reason);
        } finally {
            this.starting = false;
        }
    }

    private async doStart(): Promise<void> {
        await fs.rm(this.runtimeDir, { recursive: true, force: true });
        await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });

        // WirePlumber must not grab sound cards, Bluetooth or cameras of the system: we only need the null sink
        const confDir = join(this.configDir, 'wireplumber', 'wireplumber.conf.d');
        await fs.mkdir(confDir, { recursive: true });
        await fs.writeFile(
            join(confDir, '50-spotify-connect.conf'),
            [
                '# written by ioBroker.spotify-connect',
                'wireplumber.profiles = {',
                '  main = {',
                '    monitor.alsa = disabled',
                '    monitor.alsa-midi = disabled',
                '    monitor.bluez = disabled',
                '    monitor.bluez-midi = disabled',
                '    monitor.v4l2 = disabled',
                '    monitor.libcamera = disabled',
                '  }',
                '}',
                '',
            ].join('\n'),
        );

        this.spawn('pipewire', []);
        await this.waitFor(join(this.runtimeDir, 'pipewire-0'), 10_000);
        this.spawn('wireplumber', [], { XDG_CONFIG_HOME: this.configDir });
        this.spawn('pipewire-pulse', []);
        await this.waitFor(join(this.runtimeDir, 'pulse', 'native'), 10_000);

        // Null sink: Soloist plays into it, ffmpeg records its monitor
        for (let i = 0; i < 10; i++) {
            const res = await run(
                'pactl',
                [
                    'load-module',
                    'module-null-sink',
                    `sink_name=${SINK_NAME}`,
                    'sink_properties=device.description=SpotifyConnect',
                ],
                { env: this.env },
            );
            if (res.code === 0) {
                return;
            }
            await sleep(500);
        }
        throw new Error('Cannot create PipeWire null sink');
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        for (const p of this.procs.reverse()) {
            p.kill('SIGTERM');
        }
        await sleep(300);
        for (const p of this.procs) {
            if (p.exitCode === null) {
                p.kill('SIGKILL');
            }
        }
        this.procs = [];
        await fs.rm(this.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    }

    private spawn(cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void {
        const p = spawn(cmd, args, { env: { ...this.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        const name = cmd;
        const tail: string[] = [];
        this.tail.set(name, tail);
        const onData = (d: Buffer): void => {
            for (const line of d.toString().split('\n')) {
                const l = line.trim();
                if (l) {
                    this.log.debug(`${name}: ${l}`);
                    tail.push(l);
                    if (tail.length > 5) {
                        tail.shift();
                    }
                }
            }
        };
        p.stdout?.on('data', onData);
        p.stderr?.on('data', onData);
        p.on('error', err => tail.push(err.message));
        p.on('exit', (code, signal) => {
            if (this.stopping) {
                return;
            }
            const reason = `${name} exited with ${signal ? `signal ${signal}` : `code ${code}`}${tail.length ? `: ${tail.join(' | ')}` : ''}`;
            if (this.starting) {
                this.died ||= reason;
            } else {
                this.onCrash(name, reason);
            }
        });
        this.procs.push(p);
    }

    private async waitFor(path: string, timeoutMs: number): Promise<void> {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            if (existsSync(path)) {
                return;
            }
            if (this.died) {
                throw new Error(this.died);
            }
            await sleep(100);
        }
        throw new Error(`Timeout waiting for ${path}`);
    }
}
