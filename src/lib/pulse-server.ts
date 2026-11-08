import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import {
    buildFrame,
    Command,
    COMMAND_CHANNEL,
    ENCODING_PCM,
    FrameParser,
    INVALID_INDEX,
    NO_TAG,
    PaError,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION_MASK,
    type SampleSpec,
    Subscription,
    TagReader,
    TagWriter,
    VOLUME_NORM,
} from './pulse-protocol';

/** Format of the PCM the server emits: s16le stereo. */
export const SINK_RATE = 44100;
export const SINK_CHANNELS = 2;
export const SINK_NAME = 'spotify_connect_sink';

/** PulseAudio 6.0 (2015). Older clients would need other message layouts. */
const MIN_CLIENT_VERSION = 30;
const TICK_MS = 20;
/** After the process stalled, do not produce more than this at once. */
const MAX_TICK_FRAMES = SINK_RATE / 2;
/** Limits and defaults of fix_playback_buffer_attr() in protocol-native.c */
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TLENGTH_MS = 2000;
const DEFAULT_MINREQ_MS = 20;

type SampleReader = (buf: Buffer, offset: number) => number;

/** The formats of pa_sample_format_t the server converts. Samples are normalized to -1..1. */
const SAMPLE_FORMATS: Record<number, { name: string; size: number; read: SampleReader }> = {
    3: { name: 's16le', size: 2, read: (b, o) => b.readInt16LE(o) / 0x8000 },
    4: { name: 's16be', size: 2, read: (b, o) => b.readInt16BE(o) / 0x8000 },
    5: { name: 'float32le', size: 4, read: (b, o) => b.readFloatLE(o) },
    6: { name: 'float32be', size: 4, read: (b, o) => b.readFloatBE(o) },
    7: { name: 's32le', size: 4, read: (b, o) => b.readInt32LE(o) / 0x80000000 },
    8: { name: 's32be', size: 4, read: (b, o) => b.readInt32BE(o) / 0x80000000 },
};

export interface PulseLog {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
}

interface BufferAttr {
    maxlength: number;
    tlength: number;
    prebuf: number;
    minreq: number;
}

/** Same rules as fix_playback_buffer_attr(), with a sink that has no latency of its own. */
export function fixBufferAttr(req: BufferAttr, spec: SampleSpec, frameSize: number): BufferAttr {
    const bytesPerMs = (spec.rate * frameSize) / 1000;
    const align = (bytes: number): number => Math.max(frameSize, bytes - (bytes % frameSize));

    let maxlength = req.maxlength;
    if (maxlength === INVALID_INDEX || maxlength > MAX_QUEUE_BYTES) {
        maxlength = MAX_QUEUE_BYTES;
    }
    maxlength = align(maxlength);

    let tlength = req.tlength === INVALID_INDEX ? Math.ceil(DEFAULT_TLENGTH_MS * bytesPerMs) : req.tlength;
    tlength = Math.min(align(tlength), maxlength);

    let minreq = req.minreq;
    if (minreq === INVALID_INDEX) {
        minreq = Math.min(Math.ceil(DEFAULT_MINREQ_MS * bytesPerMs), Math.floor(tlength / 4));
    }
    minreq = align(minreq);

    if (tlength < minreq + frameSize) {
        tlength = Math.min(minreq + frameSize, maxlength);
    }
    const maxPrebuf = tlength + frameSize - minreq;
    const prebuf = req.prebuf === INVALID_INDEX || req.prebuf > maxPrebuf ? maxPrebuf : req.prebuf;
    return { maxlength, tlength, prebuf, minreq };
}

/** One playback stream of a client: a queue that the sink empties in real time. */
class PlaybackStream {
    public corked: boolean;
    public volumes: number[] = [];
    public readonly frameSize: number;
    private readonly format: { name: string; size: number; read: SampleReader };
    private readonly step: number;
    private buf: Buffer;
    private rd = 0;
    private wr = 0;
    /** Position between two source frames, only used when the stream has to be resampled */
    private phase = 0;
    private gains: [number, number] = [1, 1];
    /** Bytes the client was told to send and that did not arrive yet */
    private requested: number;
    private prebufActive: boolean;
    /** Nothing is playing. A new stream starts in this state, like is_underrun in protocol-native.c */
    private underrun = true;
    private writeIndex = 0;
    private readIndex = 0;
    private playingFor = 0;
    private underrunFor = 0;
    private readonly drainTags: number[] = [];

    public constructor(
        public readonly channel: number,
        public readonly sinkInputIndex: number,
        public readonly name: string,
        public readonly spec: SampleSpec,
        public readonly channelMap: number[],
        public readonly attr: BufferAttr,
        volumes: number[],
        corked: boolean,
        private readonly conn: Connection,
    ) {
        this.format = SAMPLE_FORMATS[spec.format];
        this.frameSize = this.format.size * spec.channels;
        this.step = spec.rate / SINK_RATE;
        this.corked = corked;
        this.setVolume(volumes);
        this.buf = Buffer.allocUnsafe(Math.max(attr.tlength * 2, 64 * 1024));
        this.requested = attr.tlength;
        this.prebufActive = attr.prebuf > 0;
    }

    private get queued(): number {
        return this.wr - this.rd;
    }

    public setVolume(volumes: number[]): void {
        this.volumes = volumes;
        // PulseAudio volumes are cubic: pa_sw_volume_to_linear()
        const gain = (v: number): number => (v / VOLUME_NORM) ** 3;
        this.gains = [gain(volumes[0] ?? VOLUME_NORM), gain(volumes[1] ?? volumes[0] ?? VOLUME_NORM)];
    }

    /** Audio from the client. */
    public write(data: Buffer): void {
        this.requested = Math.max(0, this.requested - data.length);
        let chunk = data;
        const free = this.attr.maxlength - this.queued;
        if (chunk.length > free) {
            chunk = chunk.subarray(0, Math.max(0, free));
            this.conn.notify(new TagWriter().u32(this.channel), Command.OVERFLOW);
        }
        if (this.wr + chunk.length > this.buf.length) {
            const live = this.queued;
            const target =
                live + chunk.length > this.buf.length
                    ? Buffer.allocUnsafe(Math.max(this.buf.length * 2, live + chunk.length))
                    : this.buf;
            this.buf.copy(target, 0, this.rd, this.wr);
            this.buf = target;
            this.rd = 0;
            this.wr = live;
        }
        chunk.copy(this.buf, this.wr);
        this.wr += chunk.length;
        this.writeIndex += chunk.length;
    }

    public cork(corked: boolean): void {
        this.corked = corked;
        if (corked) {
            this.underrun = true;
        }
    }

    public flush(): void {
        this.rd = 0;
        this.wr = 0;
        this.phase = 0;
        this.readIndex = this.writeIndex;
        this.prebufActive = this.attr.prebuf > 0;
    }

    public trigger(): void {
        this.prebufActive = false;
    }

    public prebuffer(): void {
        this.prebufActive = this.attr.prebuf > 0;
    }

    public drain(tag: number): void {
        this.drainTags.push(tag);
    }

    /** Pending drain requests get an answer when the stream goes away. */
    public close(): void {
        for (const tag of this.drainTags.splice(0)) {
            this.conn.sendError(tag, PaError.NOENTITY);
        }
    }

    /** Tells the client how much it may send, see pa_memblockq_pop_missing(). */
    public requestData(): void {
        const missing = this.attr.tlength - this.queued - this.requested;
        if (missing <= 0 || (missing < this.attr.minreq && !this.prebufActive)) {
            return;
        }
        this.requested += missing;
        this.conn.notify(new TagWriter().u32(this.channel).u32(missing), Command.REQUEST);
    }

    public timing(): { write: number; read: number; playing: boolean; playingFor: number; underrunFor: number } {
        return {
            write: this.writeIndex,
            read: this.readIndex,
            playing: this.playingFor > 0 && !this.corked,
            playingFor: this.playingFor,
            underrunFor: this.underrunFor,
        };
    }

    /** Takes the next frames out of the queue and adds them to the interleaved stereo mix. */
    public pull(frames: number, mix: Float64Array): void {
        if (this.corked) {
            return;
        }
        if (this.prebufActive) {
            if (this.queued < this.attr.prebuf && !this.drainTags.length) {
                return;
            }
            this.prebufActive = false;
        }
        const produced = this.render(frames, mix);
        if (produced > 0) {
            if (this.underrun) {
                this.underrun = false;
                this.underrunFor = 0;
                this.conn.notify(new TagWriter().u32(this.channel), Command.STARTED);
            }
            this.playingFor += produced * this.frameSize;
        }
        if (produced < frames) {
            this.onEmpty(frames - produced);
        }
    }

    private onEmpty(missingFrames: number): void {
        if (!this.underrun) {
            this.underrun = true;
            this.playingFor = 0;
            this.conn.notify(new TagWriter().u32(this.channel).s64(this.readIndex), Command.UNDERFLOW);
        }
        this.underrunFor += missingFrames * this.frameSize;
        this.prebufActive = this.attr.prebuf > 0;
        if (this.drainTags.length) {
            // a resampled stream may hold back its last frame: it cannot be played anymore
            this.flush();
            for (const tag of this.drainTags.splice(0)) {
                this.conn.sendAck(tag);
            }
        }
    }

    /** Returns the number of frames added to the mix. Resampling is linear and only used if the rate differs. */
    private render(frames: number, mix: Float64Array): number {
        const { read, size } = this.format;
        const { frameSize, buf, rd, step, phase, gains } = this;
        const available = Math.floor(this.queued / frameSize);
        const second = this.spec.channels > 1 ? size : 0;
        let produced = 0;
        for (; produced < frames; produced++) {
            const position = phase + produced * step;
            const index = Math.floor(position);
            const fraction = position - index;
            if (index >= available || (fraction > 0 && index + 1 >= available)) {
                break;
            }
            const offset = rd + index * frameSize;
            let left = read(buf, offset);
            let right = read(buf, offset + second);
            if (fraction > 0) {
                left += (read(buf, offset + frameSize) - left) * fraction;
                right += (read(buf, offset + frameSize + second) - right) * fraction;
            }
            mix[produced * 2] += left * gains[0];
            mix[produced * 2 + 1] += right * gains[1];
        }
        const end = phase + produced * step;
        const consumed = Math.floor(end) * frameSize;
        this.phase = end - Math.floor(end);
        this.rd += consumed;
        this.readIndex += consumed;
        if (this.rd === this.wr) {
            this.rd = 0;
            this.wr = 0;
        }
        return produced;
    }
}

/** One client. Only the commands Soloist uses (plus the ones of pacat for tests) are implemented. */
class Connection {
    private authorized = false;
    private subscriptionMask = 0;
    private readonly parser: FrameParser;
    /** By channel */
    public readonly streams = new Map<number, PlaybackStream>();

    public constructor(
        private readonly socket: net.Socket,
        private readonly server: PulseServer,
        private readonly log: PulseLog,
    ) {
        this.parser = new FrameParser((channel, payload) => this.onFrame(channel, payload));
        socket.on('data', chunk => {
            try {
                this.parser.push(chunk);
            } catch (e) {
                this.log.warn(`PulseAudio client closed: ${(e as Error).message}`);
                socket.destroy();
            }
        });
        socket.on('error', err => this.log.debug(`PulseAudio client: ${err.message}`));
        socket.on('close', () => this.server.removeConnection(this));
    }

    public destroy(): void {
        this.socket.destroy();
    }

    public closeStreams(): void {
        for (const s of this.streams.values()) {
            s.close();
            this.server.emitSinkInputEvent(Subscription.TYPE_REMOVE, s.sinkInputIndex);
        }
        this.streams.clear();
    }

    private send(payload: TagWriter): void {
        if (!this.socket.destroyed) {
            this.socket.write(buildFrame(COMMAND_CHANNEL, payload.toBuffer()));
        }
    }

    private reply(tag: number): TagWriter {
        return new TagWriter().u32(Command.REPLY).u32(tag);
    }

    public sendAck(tag: number): void {
        this.send(this.reply(tag));
    }

    public sendError(tag: number, error: number): void {
        this.send(new TagWriter().u32(Command.ERROR).u32(tag).u32(error));
    }

    /** Sends a message the client did not ask for. Fields are appended to the header. */
    public notify(fields: TagWriter, command: number): void {
        const head = new TagWriter().u32(command).u32(NO_TAG).toBuffer();
        if (!this.socket.destroyed) {
            this.socket.write(buildFrame(COMMAND_CHANNEL, Buffer.concat([head, fields.toBuffer()])));
        }
    }

    public sendSubscriptionEvent(facility: number, type: number, index: number): void {
        if (this.subscriptionMask & (1 << facility)) {
            this.notify(new TagWriter().u32(facility | type).u32(index), Command.SUBSCRIBE_EVENT);
        }
    }

    private onFrame(channel: number, payload: Buffer): void {
        if (channel !== COMMAND_CHANNEL) {
            const stream = this.streams.get(channel);
            if (stream) {
                this.server.bytesReceived += payload.length;
                stream.write(payload);
            }
            return;
        }
        const t = new TagReader(payload);
        const command = t.u32();
        const tag = t.u32();
        if (command !== Command.AUTH && !this.authorized) {
            this.sendError(tag, PaError.ACCESS);
            return;
        }
        this.handle(command, tag, t);
    }

    private handle(command: number, tag: number, t: TagReader): void {
        switch (command) {
            case Command.AUTH:
                return this.onAuth(tag, t);
            case Command.SET_CLIENT_NAME:
                return this.onSetClientName(tag, t);
            case Command.CREATE_PLAYBACK_STREAM:
                return this.onCreateStream(tag, t);
            case Command.DELETE_PLAYBACK_STREAM:
                return this.onDeleteStream(tag, t);
            case Command.CORK_PLAYBACK_STREAM:
                return this.withStream(tag, t, s => {
                    s.cork(t.bool());
                    this.server.emitSinkInputEvent(Subscription.TYPE_CHANGE, s.sinkInputIndex);
                    this.sendAck(tag);
                });
            case Command.FLUSH_PLAYBACK_STREAM:
                return this.withStream(tag, t, s => {
                    s.flush();
                    this.sendAck(tag);
                });
            case Command.TRIGGER_PLAYBACK_STREAM:
                return this.withStream(tag, t, s => {
                    s.trigger();
                    this.sendAck(tag);
                });
            case Command.PREBUF_PLAYBACK_STREAM:
                return this.withStream(tag, t, s => {
                    s.prebuffer();
                    this.sendAck(tag);
                });
            case Command.DRAIN_PLAYBACK_STREAM:
                return this.withStream(tag, t, s => s.drain(tag));
            case Command.GET_PLAYBACK_LATENCY:
                return this.onGetLatency(tag, t);
            case Command.GET_SINK_INPUT_INFO:
                return this.onGetSinkInputInfo(tag, t);
            case Command.SET_SINK_INPUT_VOLUME:
                return this.onSetVolume(tag, t);
            case Command.SUBSCRIBE:
                this.subscriptionMask = t.u32();
                return this.sendAck(tag);
            case Command.GET_SERVER_INFO:
                return this.onGetServerInfo(tag);
            case Command.UPDATE_PLAYBACK_STREAM_PROPLIST:
            case Command.UPDATE_CLIENT_PROPLIST:
            case Command.REMOVE_PLAYBACK_STREAM_PROPLIST:
            case Command.REMOVE_CLIENT_PROPLIST:
                // the properties are not used for anything
                return this.sendAck(tag);
            default:
                this.log.debug(`PulseAudio client sent unsupported command ${command}`);
                return this.sendError(tag, PaError.NOTSUPPORTED);
        }
    }

    private withStream(tag: number, t: TagReader, action: (stream: PlaybackStream) => void): void {
        const stream = this.streams.get(t.u32());
        if (stream) {
            action(stream);
        } else {
            this.sendError(tag, PaError.NOENTITY);
        }
    }

    private onAuth(tag: number, t: TagReader): void {
        // The upper bits offer shared memory. Not setting them in the reply makes the client send audio inline.
        const clientVersion = t.u32() & PROTOCOL_VERSION_MASK;
        // The socket is protected by the permissions of its folder, the cookie adds nothing.
        t.arbitrary(256);
        if (clientVersion < MIN_CLIENT_VERSION) {
            this.sendError(tag, PaError.VERSION);
            return;
        }
        this.authorized = true;
        this.send(this.reply(tag).u32(PROTOCOL_VERSION));
    }

    private onSetClientName(tag: number, t: TagReader): void {
        const props = t.proplist();
        this.log.debug(
            `PulseAudio client: ${props.get('application.name')?.toString('utf8').replace(/\0$/, '') ?? ''}`,
        );
        this.send(this.reply(tag).u32(this.server.nextIndex()));
    }

    private onCreateStream(tag: number, t: TagReader): void {
        const spec = t.sampleSpec();
        const channelMap = t.channelMap();
        t.u32(); // sink index
        t.string(); // sink name, there is only one sink
        const maxlength = t.u32();
        const corked = t.bool();
        const tlength = t.u32();
        const prebuf = t.u32();
        const minreq = t.u32();
        t.u32(); // sync id
        const volume = t.cvolume();
        for (let i = 0; i < 7; i++) {
            t.bool(); // no_remap, no_remix, fix_format, fix_rate, fix_channels, no_move, variable_rate
        }
        t.bool(); // muted
        t.bool(); // adjust_latency
        const props = t.proplist();
        const volumeSet = t.bool();
        t.bool(); // early_requests
        t.bool(); // muted_set
        t.bool(); // dont_inhibit_auto_suspend
        t.bool(); // fail_on_suspend
        t.bool(); // relative_volume
        t.bool(); // passthrough
        const formats = t.u8();
        for (let i = 0; i < formats; i++) {
            t.formatInfo();
        }

        const format = SAMPLE_FORMATS[spec.format];
        if (!format || !spec.channels || !spec.rate || channelMap.length !== spec.channels) {
            this.log.warn(
                `PulseAudio client asked for an unsupported format: ${spec.format}, ${spec.channels} channels, ${spec.rate} Hz`,
            );
            this.sendError(tag, PaError.NOTSUPPORTED);
            return;
        }

        const frameSize = format.size * spec.channels;
        const attr = fixBufferAttr({ maxlength, tlength, prebuf, minreq }, spec, frameSize);
        const channel = this.server.nextIndex();
        const sinkInput = this.server.nextIndex();
        const name = props.get('media.name')?.toString('utf8').replace(/\0$/, '') || 'playback';
        const stream = new PlaybackStream(
            channel,
            sinkInput,
            name,
            spec,
            channelMap,
            attr,
            volumeSet && volume.length ? volume : new Array<number>(spec.channels).fill(VOLUME_NORM),
            corked,
            this,
        );
        this.streams.set(channel, stream);
        this.log.debug(
            `PulseAudio stream "${name}": ${format.name} ${spec.rate} Hz ${spec.channels} ch, tlength ${attr.tlength}, prebuf ${attr.prebuf}, minreq ${attr.minreq}`,
        );

        this.send(
            this.reply(tag)
                .u32(channel)
                .u32(sinkInput)
                .u32(attr.tlength) // initial request: the whole buffer
                .u32(attr.maxlength)
                .u32(attr.tlength)
                .u32(attr.prebuf)
                .u32(attr.minreq)
                .sampleSpec(spec)
                .channelMap(channelMap)
                .u32(0)
                .string(SINK_NAME)
                .bool(false) // suspended
                .usec(0) // configured sink latency
                .formatInfo(ENCODING_PCM),
        );
        this.server.emitSinkInputEvent(Subscription.TYPE_NEW, sinkInput);
    }

    private onDeleteStream(tag: number, t: TagReader): void {
        this.withStream(tag, t, s => {
            s.close();
            this.streams.delete(s.channel);
            this.server.emitSinkInputEvent(Subscription.TYPE_REMOVE, s.sinkInputIndex);
            this.sendAck(tag);
        });
    }

    private onGetLatency(tag: number, t: TagReader): void {
        this.withStream(tag, t, s => {
            const local = t.timeval();
            // microseconds, or libpulse sees a remote time before its local time and distrusts the clocks
            const now = performance.timeOrigin + performance.now();
            const timing = s.timing();
            this.send(
                this.reply(tag)
                    .usec(0) // sink latency
                    .usec(0) // source latency
                    .bool(timing.playing)
                    .timeval(local)
                    .timeval({ sec: Math.floor(now / 1000), usec: Math.floor((now % 1000) * 1000) })
                    .s64(timing.write)
                    .s64(timing.read)
                    .u64(timing.underrunFor)
                    .u64(timing.playingFor),
            );
        });
    }

    private findBySinkInput(index: number): PlaybackStream | undefined {
        for (const s of this.streams.values()) {
            if (s.sinkInputIndex === index) {
                return s;
            }
        }
    }

    private onGetSinkInputInfo(tag: number, t: TagReader): void {
        const s = this.findBySinkInput(t.u32());
        if (!s) {
            this.sendError(tag, PaError.NOENTITY);
            return;
        }
        this.send(
            this.reply(tag)
                .u32(s.sinkInputIndex)
                .string(s.name)
                .u32(INVALID_INDEX) // module
                .u32(INVALID_INDEX) // client
                .u32(0) // sink
                .sampleSpec(s.spec)
                .channelMap(s.channelMap)
                .cvolume(s.volumes)
                .usec(0) // buffer latency
                .usec(0) // sink latency
                .string(null) // resample method
                .string('ioBroker.spotify-connect')
                .bool(false) // muted
                .proplist()
                .bool(s.corked)
                .bool(true) // has volume
                .bool(true) // volume writable
                .formatInfo(ENCODING_PCM),
        );
    }

    private onSetVolume(tag: number, t: TagReader): void {
        const s = this.findBySinkInput(t.u32());
        const volume = t.cvolume();
        if (!s) {
            this.sendError(tag, PaError.NOENTITY);
            return;
        }
        if (volume.length !== s.spec.channels) {
            this.sendError(tag, PaError.INVALID);
            return;
        }
        s.setVolume(volume);
        this.server.emitSinkInputEvent(Subscription.TYPE_CHANGE, s.sinkInputIndex);
        this.sendAck(tag);
    }

    private onGetServerInfo(tag: number): void {
        this.send(
            this.reply(tag)
                .string('pulseaudio')
                .string('17.0.0')
                .string('iobroker')
                .string('iobroker')
                .sampleSpec({ format: 3, channels: SINK_CHANNELS, rate: SINK_RATE })
                .string(SINK_NAME)
                .string(null) // no source
                .u32(0)
                .channelMap([1, 2]), // front-left, front-right
        );
    }
}

/**
 * The part of a PulseAudio server that Soloist needs, without any audio system below it: Soloist connects with its
 * libpulse to the socket and plays one stream. The stream is consumed in real time by a virtual sink, so Soloist plays
 * at the correct speed. What the sink produces is emitted as PCM, silence when nothing plays, so that the encoder and
 * the connected players keep running during a pause.
 *
 * Events: "pcm" (Buffer of s16le stereo at SINK_RATE)
 */
export class PulseServer extends EventEmitter {
    private server?: net.Server;
    private timer?: NodeJS.Timeout;
    private readonly connections = new Set<Connection>();
    private index = 0;
    private lastTick = 0;
    private frameDebt = 0;
    private readonly socketPath: string;
    /** All audio bytes received so far. Shows that a client really plays into this server. */
    public bytesReceived = 0;

    public constructor(
        private readonly runtimeDir: string,
        private readonly log: PulseLog,
        private readonly onFailure: (reason: string) => void,
    ) {
        super();
        this.socketPath = join(runtimeDir, 'pulse', 'native');
    }

    /** Environment that makes libpulse use this server and keeps it away from any audio system of the host. */
    public get env(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            XDG_RUNTIME_DIR: this.runtimeDir,
            // Soloist tries PipeWire first: it must not find a running PipeWire of the host
            PIPEWIRE_RUNTIME_DIR: this.runtimeDir,
            PULSE_RUNTIME_PATH: dirname(this.socketPath),
            PULSE_SERVER: `unix:${this.socketPath}`,
            // otherwise libpulse creates a cookie in the home directory of the user
            PULSE_COOKIE: join(this.runtimeDir, 'cookie'),
        };
        delete env.PIPEWIRE_REMOTE;
        delete env.DBUS_SESSION_BUS_ADDRESS;
        return env;
    }

    /** @param listen where to listen instead of the socket in the runtime folder, for tests */
    public async start(listen?: net.ListenOptions): Promise<void> {
        await fs.rm(this.runtimeDir, { recursive: true, force: true });
        await fs.mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
        await new Promise<void>((resolve, reject) => {
            const server = net.createServer(socket => {
                this.connections.add(new Connection(socket, this, this.log));
            });
            server.once('error', reject);
            server.listen(listen || { path: this.socketPath }, () => {
                server.off('error', reject);
                server.on('error', err => this.onFailure(`PulseAudio socket failed: ${err.message}`));
                this.server = server;
                resolve();
            });
        });
        this.lastTick = performance.now();
        this.timer = setInterval(() => this.tick(), TICK_MS);
    }

    public async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        for (const c of this.connections) {
            c.destroy();
        }
        const server = this.server;
        this.server = undefined;
        await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
        await fs.rm(this.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    }

    /** The address the server listens on, for tests. */
    public get address(): net.AddressInfo | string | null {
        return this.server?.address() ?? null;
    }

    public nextIndex(): number {
        return this.index++;
    }

    public removeConnection(connection: Connection): void {
        this.connections.delete(connection);
        connection.closeStreams();
    }

    public emitSinkInputEvent(type: number, index: number): void {
        for (const c of this.connections) {
            c.sendSubscriptionEvent(Subscription.FACILITY_SINK_INPUT, type, index);
        }
    }

    private tick(): void {
        const now = performance.now();
        const exact = ((now - this.lastTick) * SINK_RATE) / 1000 + this.frameDebt;
        this.lastTick = now;
        const frames = Math.min(Math.floor(exact), MAX_TICK_FRAMES);
        this.frameDebt = exact - Math.floor(exact);
        if (frames <= 0) {
            return;
        }
        const mix = new Float64Array(frames * SINK_CHANNELS);
        for (const c of this.connections) {
            for (const s of c.streams.values()) {
                s.pull(frames, mix);
                s.requestData();
            }
        }
        this.emit('pcm', toS16le(mix));
    }
}

/** Saturating conversion, s16 samples pass unchanged. */
export function toS16le(mix: Float64Array): Buffer {
    const out = Buffer.allocUnsafe(mix.length * 2);
    for (let i = 0; i < mix.length; i++) {
        out.writeInt16LE(Math.max(-0x8000, Math.min(0x7fff, Math.round(mix[i] * 0x8000))), i * 2);
    }
    return out;
}
