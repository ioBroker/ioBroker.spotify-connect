const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
    buildFrame,
    Command,
    COMMAND_CHANNEL,
    FrameParser,
    PROTOCOL_VERSION,
    TagReader,
    TagWriter,
    VOLUME_NORM,
    PaError,
} = require('../build/lib/pulse-protocol');
const { fixBufferAttr, PulseServer, SINK_RATE, toS16le } = require('../build/lib/pulse-server');
const { StreamServer } = require('../build/lib/stream-server');
const { findFfmpeg } = require('../build/lib/installer');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const S16LE = 3;
const FLOAT32LE = 5;
const STEREO_MAP = [1, 2];
const INVALID = 0xffffffff;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition, what, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > end) {
            throw new Error(`Timeout waiting for ${what}`);
        }
        await delay(5);
    }
}

/** Speaks to the server the way libpulse does. Replies are parsed by the caller, field by field. */
class MockClient {
    constructor(port) {
        this.port = port;
        this.tag = 0;
        this.pending = new Map();
        this.notifications = [];
        this.closed = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.connect(this.port, '127.0.0.1', resolve);
            this.socket.once('error', reject);
            this.socket.on('close', () => (this.closed = true));
            const parser = new FrameParser((channel, payload) => {
                assert.equal(channel, COMMAND_CHANNEL, 'the server never sends audio');
                const t = new TagReader(payload);
                const command = t.u32();
                const tag = t.u32();
                if (tag === INVALID) {
                    this.notifications.push({ command, t });
                } else {
                    const p = this.pending.get(tag);
                    this.pending.delete(tag);
                    p({ command, t });
                }
            });
            this.socket.on('data', chunk => parser.push(chunk));
        });
    }

    /** Sends a command and returns the reader of the reply. Rejects on an error reply. */
    request(command, fill = () => {}) {
        const tag = this.tag++;
        const w = new TagWriter().u32(command).u32(tag);
        fill(w);
        this.socket.write(buildFrame(COMMAND_CHANNEL, w.toBuffer()));
        return new Promise((resolve, reject) => {
            this.pending.set(tag, ({ command: c, t }) => {
                if (c === Command.ERROR) {
                    const err = new Error('error reply');
                    err.code = t.u32();
                    reject(err);
                } else {
                    assert.equal(c, Command.REPLY);
                    resolve(t);
                }
            });
        });
    }

    async auth(version = PROTOCOL_VERSION | 0x80000000 | 0x40000000) {
        const t = await this.request(Command.AUTH, w => w.u32(version).arbitrary(Buffer.alloc(256)));
        const serverVersion = t.u32();
        assert.ok(t.eof);
        return serverVersion;
    }

    async hello() {
        await this.auth();
        const t = await this.request(Command.SET_CLIENT_NAME, w =>
            w.proplist(new Map([['application.name', Buffer.from('test\0')]])),
        );
        t.u32();
        assert.ok(t.eof);
    }

    /** Field order of pa_stream_connect_playback(), reply parsed like pa_create_stream_callback(). */
    async createStream(options = {}) {
        const spec = {
            format: options.format ?? S16LE,
            channels: options.channels ?? 2,
            rate: options.rate ?? SINK_RATE,
        };
        const map = options.map ?? STEREO_MAP.slice(0, spec.channels);
        const volume = options.volume ?? new Array(spec.channels).fill(VOLUME_NORM);
        const t = await this.request(Command.CREATE_PLAYBACK_STREAM, w => {
            w.sampleSpec(spec)
                .channelMap(map)
                .u32(INVALID)
                .string(null)
                .u32(options.maxlength ?? INVALID)
                .bool(!!options.corked)
                .u32(options.tlength ?? INVALID)
                .u32(options.prebuf ?? INVALID)
                .u32(options.minreq ?? INVALID)
                .u32(0)
                .cvolume(volume);
            for (let i = 0; i < 7; i++) {
                w.bool(false);
            }
            w.bool(false).bool(false).proplist(new Map([['media.name', Buffer.from('Music\0')]]));
            w.bool(true).bool(false); // volume_set, early_requests
            w.bool(false).bool(false).bool(false); // muted_set, dont_inhibit_auto_suspend, fail_on_suspend
            w.bool(false); // relative_volume
            w.bool(false); // passthrough
            w.u8(0); // n_formats
        });
        const stream = {
            channel: t.u32(),
            sinkInput: t.u32(),
            missing: t.u32(),
            maxlength: t.u32(),
            tlength: t.u32(),
            prebuf: t.u32(),
            minreq: t.u32(),
        };
        assert.deepEqual(t.sampleSpec(), spec);
        assert.deepEqual(t.channelMap(), map);
        assert.equal(t.u32(), 0);
        assert.ok(t.string());
        assert.equal(t.bool(), false);
        return { ...stream, t };
    }

    write(channel, data) {
        this.socket.write(buildFrame(channel, data));
    }

    received(command) {
        return this.notifications.filter(n => n.command === command);
    }

    close() {
        this.socket.destroy();
    }
}

/** Reads what createStream() leaves in the reply: sink latency and format info. */
function finishCreateReply(t) {
    t.usec();
    t.formatInfo();
    assert.ok(t.eof, 'libpulse fails the connection on trailing fields');
}

/** Never 0: the tests recognize audio by samples that are not silent. */
const sampleValue = i => 1 + (i % 29999);

function samples(count) {
    const b = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) {
        b.writeInt16LE(sampleValue(i), i * 4);
        b.writeInt16LE(-sampleValue(i), i * 4 + 2);
    }
    return b;
}

describe('pulse protocol', () => {
    it('encodes tags byte by byte like tagstruct.c', () => {
        const b = new TagWriter()
            .u32(0x01020304)
            .u8(5)
            .string('ab')
            .string(null)
            .bool(true)
            .bool(false)
            .sampleSpec({ format: 3, channels: 2, rate: 44100 })
            .channelMap([1, 2])
            .cvolume([0x10000])
            .toBuffer();
        assert.deepEqual(
            [...b],
            [
                0x4c, 1, 2, 3, 4, 0x42, 5, 0x74, 0x61, 0x62, 0, 0x4e, 0x31, 0x30, 0x61, 3, 2, 0, 0, 0xac, 0x44, 0x6d, 2, 1,
                2, 0x76, 1, 0, 1, 0, 0,
            ],
        );
    });

    it('encodes a proplist as key, length, arbitrary and a null string', () => {
        const b = new TagWriter().proplist(new Map([['a', Buffer.from([9])]])).toBuffer();
        assert.deepEqual([...b], [0x50, 0x74, 0x61, 0, 0x4c, 0, 0, 0, 1, 0x78, 0, 0, 0, 1, 9, 0x4e]);
    });

    it('encodes format info with nested u8 and proplist tags', () => {
        assert.deepEqual([...new TagWriter().formatInfo(1).toBuffer()], [0x66, 0x42, 1, 0x50, 0x4e]);
    });

    it('reads back what it writes', () => {
        const t = new TagReader(
            new TagWriter()
                .u32(7)
                .string('x')
                .string(null)
                .bool(true)
                .timeval({ sec: 3, usec: 4 })
                .cvolume([1, 2])
                .proplist(new Map([['k', Buffer.from('v')]]))
                .toBuffer(),
        );
        assert.equal(t.u32(), 7);
        assert.equal(t.string(), 'x');
        assert.equal(t.string(), null);
        assert.equal(t.bool(), true);
        assert.deepEqual(t.timeval(), { sec: 3, usec: 4 });
        assert.deepEqual(t.cvolume(), [1, 2]);
        assert.equal(t.proplist().get('k').toString(), 'v');
        assert.ok(t.eof);
    });

    it('throws on wrong tags and truncated data', () => {
        assert.throws(() => new TagReader(new TagWriter().u8(1).toBuffer()).u32());
        assert.throws(() => new TagReader(Buffer.from([0x4c, 0])).u32());
        assert.throws(() => new TagReader(Buffer.from([0x74, 0x61])).string());
    });

    it('reassembles frames from any fragmentation', () => {
        const frames = [];
        const parser = new FrameParser((channel, payload) => frames.push([channel, payload.toString()]));
        const all = Buffer.concat([buildFrame(1, Buffer.from('abc')), buildFrame(2, Buffer.from('')), buildFrame(3, Buffer.from('de'))]);
        for (const byte of all) {
            parser.push(Buffer.from([byte]));
        }
        assert.deepEqual(frames, [
            [1, 'abc'],
            [2, ''],
            [3, 'de'],
        ]);
    });

    it('refuses oversized frames and frames with shared memory', () => {
        const parser = new FrameParser(() => {});
        const big = Buffer.alloc(20);
        big.writeUInt32BE(64 * 1024 * 1024, 0);
        assert.throws(() => parser.push(big));
        const shm = Buffer.alloc(20);
        shm.writeUInt32BE(0x80000000, 16);
        assert.throws(() => new FrameParser(() => {}).push(shm));
    });

    it('selects the same default buffer sizes as PulseAudio', () => {
        const attr = fixBufferAttr(
            { maxlength: INVALID, tlength: INVALID, prebuf: INVALID, minreq: INVALID },
            { format: S16LE, channels: 2, rate: 44100 },
            4,
        );
        assert.deepEqual(attr, { maxlength: 4194304, tlength: 352800, prebuf: 349276, minreq: 3528 });
    });

    it('keeps requested buffer sizes and repairs impossible ones', () => {
        const spec = { format: S16LE, channels: 2, rate: 44100 };
        assert.deepEqual(fixBufferAttr({ maxlength: 100000, tlength: 8000, prebuf: 0, minreq: 1000 }, spec, 4), {
            maxlength: 100000,
            tlength: 8000,
            prebuf: 0,
            minreq: 1000,
        });
        const zero = fixBufferAttr({ maxlength: 0, tlength: 0, prebuf: 0, minreq: 0 }, spec, 4);
        assert.ok(zero.maxlength >= 4 && zero.tlength >= 4 && zero.minreq >= 4);
    });

    it('converts to s16le without changing s16 samples and saturates', () => {
        const pcm = toS16le(Float64Array.from([-32768 / 32768, 12345 / 32768, 2, -2]));
        assert.equal(pcm.readInt16LE(0), -32768);
        assert.equal(pcm.readInt16LE(2), 12345);
        assert.equal(pcm.readInt16LE(4), 32767);
        assert.equal(pcm.readInt16LE(6), -32768);
    });
});

describe('pulse server', function () {
    this.timeout(15_000);
    let dir;
    let server;
    let client;
    let pcm;
    let collect;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'pulse-test-'));
        server = new PulseServer(join(dir, 'run'), silent, reason => assert.fail(reason));
        pcm = [];
        collect = chunk => pcm.push(chunk);
        server.on('pcm', collect);
        await server.start({ port: 0, host: '127.0.0.1' });
        client = new MockClient(server.address.port);
        await client.connect();
    });

    afterEach(async () => {
        client.close();
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    const output = () => Buffer.concat(pcm);
    const nonSilent = () => {
        const all = output();
        const frames = [];
        for (let i = 0; i + 4 <= all.length; i += 4) {
            if (all.readInt16LE(i) !== 0 || all.readInt16LE(i + 2) !== 0) {
                frames.push([all.readInt16LE(i), all.readInt16LE(i + 2)]);
            }
        }
        return frames;
    };

    it('answers AUTH without SHM and memfd flags, so that the client sends audio inline', async () => {
        assert.equal(await client.auth(), PROTOCOL_VERSION);
    });

    it('refuses commands before AUTH', async () => {
        await assert.rejects(
            client.request(Command.GET_SERVER_INFO),
            err => err.code === PaError.ACCESS,
        );
    });

    it('refuses clients with a very old protocol', async () => {
        await assert.rejects(client.auth(12), err => err.code === PaError.VERSION);
    });

    it('answers unknown commands with an error instead of closing the connection', async () => {
        await client.hello();
        await assert.rejects(
            client.request(Command.GET_PLAYBACK_LATENCY + 1000),
            err => err.code === PaError.NOTSUPPORTED,
        );
        assert.equal(client.closed, false);
    });

    it('drops a client that breaks the protocol and keeps running', async () => {
        await client.hello();
        client.socket.write(buildFrame(COMMAND_CHANNEL, Buffer.from([1, 2, 3])));
        await waitFor(() => client.closed, 'connection to close');
        const other = new MockClient(server.address.port);
        await other.connect();
        await other.hello();
        other.close();
    });

    it('creates a stream with a reply that libpulse can parse to the last byte', async () => {
        await client.hello();
        const s = await client.createStream();
        assert.equal(s.missing, s.tlength, 'the first request is the whole buffer');
        finishCreateReply(s.t);
    });

    it('refuses formats it cannot convert', async () => {
        await client.hello();
        await assert.rejects(client.createStream({ format: 0 }), err => err.code === PaError.NOTSUPPORTED);
    });

    it('emits silence while nothing plays', async () => {
        await waitFor(() => output().length > 4000, 'pcm');
        assert.ok(output().every(b => b === 0));
    });

    it('passes s16le samples unchanged and in order', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 8000, prebuf: 4000, minreq: 400 });
        const count = 4000;
        client.write(s.channel, samples(count));
        await waitFor(() => nonSilent().length >= count, 'all frames', 5000);
        const frames = nonSilent();
        assert.equal(frames.length, count);
        frames.forEach(([l, r], i) => {
            assert.equal(l, sampleValue(i));
            assert.equal(r, -sampleValue(i));
        });
    });

    it('consumes the stream in real time', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 400000, prebuf: 4, minreq: 400 });
        client.write(s.channel, samples(44100));
        const start = Date.now();
        await waitFor(() => nonSilent().length >= 22050, 'half a second of audio', 3000);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 400, `half a second of audio took only ${elapsed} ms`);
        assert.ok(elapsed <= 1500, `half a second of audio took ${elapsed} ms`);
    });

    it('asks for more data as it plays, not more than the buffer holds', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 20000, prebuf: 4, minreq: 2000 });
        client.write(s.channel, samples(s.tlength / 4));
        await waitFor(() => client.received(Command.REQUEST).length >= 2, 'REQUEST');
        let total = 0;
        for (const { t } of client.received(Command.REQUEST)) {
            assert.equal(t.u32(), s.channel);
            const bytes = t.u32();
            assert.ok(bytes >= s.minreq, `request of ${bytes} bytes is below minreq`);
            assert.ok(t.eof);
            total += bytes;
        }
        assert.ok(total <= s.tlength);
    });

    it('waits for prebuf, then reports STARTED, then UNDERFLOW when the queue runs dry', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 40000, prebuf: 8000, minreq: 400 });
        client.write(s.channel, samples(1000));
        await delay(150);
        assert.equal(nonSilent().length, 0, 'must not start below prebuf');
        assert.equal(client.received(Command.STARTED).length, 0);

        client.write(s.channel, samples(1000));
        await waitFor(() => client.received(Command.STARTED).length === 1, 'STARTED');
        await waitFor(() => client.received(Command.UNDERFLOW).length === 1, 'UNDERFLOW');
        const { t } = client.received(Command.UNDERFLOW)[0];
        assert.equal(t.u32(), s.channel);
        assert.equal(t.s64(), 8000, 'read index');
        assert.ok(t.eof, 'libpulse fails the connection on trailing fields');
        assert.equal(nonSilent().length, 2000);
    });

    it('stops consuming while corked and continues afterwards', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 400000, prebuf: 4, minreq: 400, corked: true });
        client.write(s.channel, samples(44100));
        await delay(150);
        assert.equal(nonSilent().length, 0, 'a corked stream must not play');

        await client.request(Command.CORK_PLAYBACK_STREAM, w => w.u32(s.channel).bool(false));
        await waitFor(() => nonSilent().length > 2000, 'playback after uncork');
        await client.request(Command.CORK_PLAYBACK_STREAM, w => w.u32(s.channel).bool(true));
        await delay(40);
        const whileCorked = nonSilent().length;
        await delay(150);
        assert.equal(nonSilent().length, whileCorked);
    });

    it('drops queued audio on flush and moves the read index to the write index', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 400000, prebuf: 400000, minreq: 400 });
        client.write(s.channel, samples(1000));
        await delay(50);
        await client.request(Command.FLUSH_PLAYBACK_STREAM, w => w.u32(s.channel));
        const t = await client.request(Command.GET_PLAYBACK_LATENCY, w => w.u32(s.channel).timeval({ sec: 1, usec: 0 }));
        const timing = readLatencyReply(t);
        assert.equal(timing.write, 4000);
        assert.equal(timing.read, 4000);
    });

    it('answers the latency request with the layout of stream_get_timing_info_callback', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 400000, prebuf: 4, minreq: 400 });
        client.write(s.channel, samples(44100));
        await waitFor(() => nonSilent().length > 4410, 'playback');
        const before = Date.now() * 1000;
        const sent = { sec: Math.floor(before / 1e6), usec: Math.floor(before % 1e6) };
        const t = await client.request(Command.GET_PLAYBACK_LATENCY, w => w.u32(s.channel).timeval(sent));
        const timing = readLatencyReply(t);
        assert.equal(timing.playing, true);
        assert.deepEqual(timing.local, sent);
        assert.equal(timing.write, 176400);
        assert.ok(timing.read >= 4410 * 4 && timing.read < 176400);
        assert.ok(timing.playingFor > 0);
        const remote = timing.remote.sec * 1e6 + timing.remote.usec;
        assert.ok(remote >= before - 2000, 'remote time must be comparable with the local time');
    });

    it('applies the cubic PulseAudio volume and reports the change', async () => {
        await client.hello();
        await client.request(Command.SUBSCRIBE, w => w.u32(0x0004));
        const s = await client.createStream({ tlength: 400000, prebuf: 4, minreq: 400, corked: true });
        await client.request(Command.SET_SINK_INPUT_VOLUME, w =>
            w.u32(s.sinkInput).cvolume([VOLUME_NORM / 2, VOLUME_NORM / 2]),
        );

        const frame = Buffer.alloc(4);
        frame.writeInt16LE(16000, 0);
        frame.writeInt16LE(-16000, 2);
        client.write(s.channel, Buffer.concat(new Array(4410).fill(frame)));
        await client.request(Command.CORK_PLAYBACK_STREAM, w => w.u32(s.channel).bool(false));
        await waitFor(() => nonSilent().length >= 4410, 'playback');
        for (const [l, r] of nonSilent()) {
            assert.equal(l, 2000); // 16000 * 0.5^3
            assert.equal(r, -2000);
        }
        await waitFor(() => client.received(Command.SUBSCRIBE_EVENT).length >= 2, 'event');
        const events = client.received(Command.SUBSCRIBE_EVENT).map(({ t }) => [t.u32(), t.u32()]);
        assert.deepEqual(events[0], [0x0002, s.sinkInput], 'new sink input');
        assert.deepEqual(events[1], [0x0012, s.sinkInput], 'changed sink input');
    });

    it('does not send subscription events without a matching subscription', async () => {
        await client.hello();
        await client.request(Command.SUBSCRIBE, w => w.u32(0x0001));
        const s = await client.createStream({ corked: true });
        await client.request(Command.SET_SINK_INPUT_VOLUME, w => w.u32(s.sinkInput).cvolume([0, 0]));
        assert.equal(client.received(Command.SUBSCRIBE_EVENT).length, 0);
    });

    it('answers the sink input info with the layout of context_get_sink_input_info_callback', async () => {
        await client.hello();
        const s = await client.createStream({ corked: true, volume: [VOLUME_NORM / 2, VOLUME_NORM / 4] });
        const t = await client.request(Command.GET_SINK_INPUT_INFO, w => w.u32(s.sinkInput));
        assert.equal(t.u32(), s.sinkInput);
        assert.equal(t.string(), 'Music');
        t.u32();
        t.u32();
        assert.equal(t.u32(), 0);
        assert.deepEqual(t.sampleSpec(), { format: S16LE, channels: 2, rate: SINK_RATE });
        assert.deepEqual(t.channelMap(), STEREO_MAP);
        assert.deepEqual(t.cvolume(), [VOLUME_NORM / 2, VOLUME_NORM / 4]);
        t.usec();
        t.usec();
        assert.equal(t.string(), null);
        assert.ok(t.string());
        assert.equal(t.bool(), false);
        t.proplist();
        assert.equal(t.bool(), true, 'corked');
        assert.equal(t.bool(), true, 'has volume');
        assert.equal(t.bool(), true, 'volume writable');
        t.formatInfo();
        assert.ok(t.eof);

        await assert.rejects(
            client.request(Command.GET_SINK_INPUT_INFO, w => w.u32(9999)),
            err => err.code === PaError.NOENTITY,
        );
    });

    it('converts float32 to s16', async () => {
        await client.hello();
        const s = await client.createStream({ format: FLOAT32LE, tlength: 80000, prebuf: 8, minreq: 800 });
        const data = Buffer.alloc(4410 * 8);
        for (let i = 0; i < 4410; i++) {
            data.writeFloatLE(0.5, i * 8);
            data.writeFloatLE(-0.25, i * 8 + 4);
        }
        client.write(s.channel, data);
        await waitFor(() => nonSilent().length >= 4410, 'playback');
        assert.deepEqual(nonSilent()[100], [16384, -8192]);
    });

    it('copies mono to both output channels', async () => {
        await client.hello();
        const s = await client.createStream({ channels: 1, map: [0], tlength: 40000, prebuf: 2, minreq: 200 });
        const data = Buffer.alloc(4410 * 2);
        for (let i = 0; i < 4410; i++) {
            data.writeInt16LE(1000, i * 2);
        }
        client.write(s.channel, data);
        await waitFor(() => nonSilent().length >= 4410, 'playback');
        assert.deepEqual(nonSilent()[100], [1000, 1000]);
    });

    it('resamples other rates and keeps the correct speed', async () => {
        await client.hello();
        const rate = 48000;
        const s = await client.createStream({ rate, tlength: 400000, prebuf: 4, minreq: 400 });
        const frames = rate / 2; // half a second
        const data = Buffer.alloc(frames * 4);
        for (let i = 0; i < frames; i++) {
            data.writeInt16LE(1000 + (i % 100), i * 4);
            data.writeInt16LE(1000 + (i % 100), i * 4 + 2);
        }
        client.write(s.channel, data);
        const start = Date.now();
        await waitFor(() => client.received(Command.UNDERFLOW).length === 1, 'end of the stream', 3000);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 400 && elapsed <= 1500, `half a second took ${elapsed} ms`);
        const out = nonSilent().length;
        assert.ok(Math.abs(out - SINK_RATE / 2) <= 3, `${out} frames instead of ${SINK_RATE / 2}`);
    });

    it('answers a drain request when the queue is empty', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 40000, prebuf: 40000, minreq: 400 });
        client.write(s.channel, samples(2000));
        const before = Date.now();
        await client.request(Command.DRAIN_PLAYBACK_STREAM, w => w.u32(s.channel));
        assert.equal(nonSilent().length, 2000, 'drain plays what is below prebuf');
        assert.ok(Date.now() - before >= 30);
    });

    it('fails a pending drain when the stream is deleted', async () => {
        await client.hello();
        const s = await client.createStream({ corked: true });
        client.write(s.channel, samples(100));
        const drain = client.request(Command.DRAIN_PLAYBACK_STREAM, w => w.u32(s.channel));
        await client.request(Command.DELETE_PLAYBACK_STREAM, w => w.u32(s.channel));
        await assert.rejects(drain, err => err.code === PaError.NOENTITY);
    });

    it('reports an overflow and keeps memory bounded when a client ignores the requests', async () => {
        await client.hello();
        const s = await client.createStream({ maxlength: 4000, tlength: 2000, prebuf: 2000, minreq: 400, corked: true });
        client.write(s.channel, Buffer.alloc(20000, 1));
        await waitFor(() => client.received(Command.OVERFLOW).length === 1, 'OVERFLOW');
    });

    it('removes the streams of a client that disconnects and goes on with silence', async () => {
        await client.hello();
        const s = await client.createStream({ tlength: 400000, prebuf: 4, minreq: 400 });
        client.write(s.channel, samples(44100));
        await waitFor(() => nonSilent().length > 1000, 'playback');
        client.close();
        await delay(60);
        pcm.length = 0;
        await waitFor(() => output().length > 4000, 'pcm');
        assert.equal(nonSilent().length, 0);
    });

    it('mixes two streams', async () => {
        await client.hello();
        const a = await client.createStream({ tlength: 80000, prebuf: 4, minreq: 400, corked: true });
        const b = await client.createStream({ tlength: 80000, prebuf: 4, minreq: 400, corked: true });
        const frame = Buffer.alloc(4);
        frame.writeInt16LE(1000, 0);
        frame.writeInt16LE(1000, 2);
        const data = Buffer.concat(new Array(4410).fill(frame));
        client.write(a.channel, data);
        client.write(b.channel, data);
        await delay(30);
        await client.request(Command.CORK_PLAYBACK_STREAM, w => w.u32(a.channel).bool(false));
        await client.request(Command.CORK_PLAYBACK_STREAM, w => w.u32(b.channel).bool(false));
        await waitFor(() => nonSilent().some(([l]) => l === 2000), 'both streams together');
    });

    it('counts received audio', async () => {
        await client.hello();
        const s = await client.createStream({ corked: true });
        client.write(s.channel, samples(100));
        await waitFor(() => server.bytesReceived === 400, 'bytes');
    });

    it('has an environment that keeps Soloist away from the audio of the host', () => {
        const before = { PIPEWIRE_REMOTE: process.env.PIPEWIRE_REMOTE, DBUS: process.env.DBUS_SESSION_BUS_ADDRESS };
        process.env.PIPEWIRE_REMOTE = 'x';
        process.env.DBUS_SESSION_BUS_ADDRESS = 'y';
        const env = server.env;
        assert.equal(env.PIPEWIRE_REMOTE, undefined);
        assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
        assert.ok(env.PULSE_SERVER.startsWith('unix:'));
        assert.equal(env.PIPEWIRE_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
        assert.ok(env.PULSE_COOKIE.startsWith(env.XDG_RUNTIME_DIR));
        restoreEnv('PIPEWIRE_REMOTE', before.PIPEWIRE_REMOTE);
        restoreEnv('DBUS_SESSION_BUS_ADDRESS', before.DBUS);
    });
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function readLatencyReply(t) {
    const result = {
        sink: t.usec(),
        source: t.usec(),
        playing: t.bool(),
        local: t.timeval(),
        remote: t.timeval(),
        write: t.s64(),
        read: t.s64(),
        underrunFor: t.u64(),
        playingFor: t.u64(),
    };
    assert.ok(t.eof, 'libpulse fails the connection on trailing fields');
    return result;
}

describe('stream server with ffmpeg-static', function () {
    this.timeout(30_000);
    let ffmpeg;

    before(async function () {
        ffmpeg = await findFfmpeg(silent);
        if (!ffmpeg) {
            // npm leaves out the optional package if GitHub could not deliver the binary, which does happen
            console.warn('ffmpeg-static could not be downloaded and the system has no ffmpeg: skipping these tests');
            this.skip();
        }
    });

    /** Sends one second of a sine, then decodes what the HTTP client received and returns its peak. */
    async function roundtrip(format, port) {
        const source = new EventEmitter();
        const stream = new StreamServer({ port, format, ffmpeg, source, sampleRate: SINK_RATE, channels: 2 }, silent, () => {});
        await stream.start();

        const chunks = [];
        const response = await new Promise((resolve, reject) => {
            http.get({ port, host: '127.0.0.1', path: stream.path }, resolve).on('error', reject);
        });
        assert.equal(response.statusCode, 200);
        response.on('data', c => chunks.push(c));
        response.on('error', () => {});

        // by the clock like PulseServer: timers are too coarse for a fixed number of frames per tick
        let n = 0;
        const start = performance.now();
        const timer = setInterval(() => {
            const frames = Math.floor(((performance.now() - start) * SINK_RATE) / 1000) - n;
            const b = Buffer.alloc(frames * 4);
            for (let i = 0; i < frames; i++, n++) {
                const v = Math.round(Math.sin((n * 2 * Math.PI * 440) / SINK_RATE) * 20000);
                b.writeInt16LE(v, i * 4);
                b.writeInt16LE(v, i * 4 + 2);
            }
            source.emit('pcm', b);
        }, 20);
        await delay(1500);
        clearInterval(timer);
        const received = Buffer.concat(chunks);
        response.destroy();
        await stream.stop();

        const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', format, '-i', 'pipe:0', '-f', 's16le', '-ac', '2', '-ar', '44100', 'pipe:1'], {
            input: received,
            maxBuffer: 64 * 1024 * 1024,
        });
        assert.equal(decoded.status, 0, decoded.stderr?.toString());
        let peak = 0;
        for (let i = 0; i + 2 <= decoded.stdout.length; i += 2) {
            peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(i)));
        }
        return { bytes: received.length, peak, seconds: decoded.stdout.length / 4 / SINK_RATE };
    }

    it('delivers a decodable MP3 stream with the audio', async () => {
        const r = await roundtrip('mp3', 18197);
        assert.ok(r.bytes > 10_000, `only ${r.bytes} bytes`);
        assert.ok(r.seconds > 0.8, `only ${r.seconds} s`);
        assert.ok(r.peak > 15_000 && r.peak < 26_000, `peak ${r.peak}`);
    });

    it('delivers a decodable FLAC stream with the audio', async () => {
        const r = await roundtrip('flac', 18198);
        assert.ok(r.seconds > 0.8, `only ${r.seconds} s`);
        assert.ok(r.peak > 19_000 && r.peak < 21_000, `peak ${r.peak}`);
    });

    it('answers 404 and HEAD without starting an encoder', async () => {
        const port = 18199;
        const source = new EventEmitter();
        const stream = new StreamServer({ port, format: 'mp3', ffmpeg, source, sampleRate: SINK_RATE, channels: 2 }, silent, () => {});
        await stream.start();
        const status = (method, path) =>
            new Promise((resolve, reject) => {
                const req = http.request({ port, host: '127.0.0.1', method, path }, res => {
                    res.resume();
                    resolve(res.statusCode);
                });
                req.on('error', reject);
                req.end();
            });
        assert.equal(await status('GET', '/other'), 404);
        assert.equal(await status('HEAD', stream.path), 200);
        assert.equal(stream.encoders.size, 0);
        await stream.stop();
    });

    it('delivers the first audio quickly, players give up on a silent connection', async () => {
        const port = 18201;
        const source = new EventEmitter();
        const stream = new StreamServer({ port, format: 'mp3', ffmpeg, source, sampleRate: SINK_RATE, channels: 2 }, silent, () => {});
        await stream.start();
        const timer = setInterval(() => source.emit('pcm', Buffer.alloc(882 * 4)), 20);
        const start = Date.now();
        const firstByte = await new Promise((resolve, reject) => {
            http.get({ port, host: '127.0.0.1', path: stream.path }, res => {
                res.once('data', () => {
                    resolve(Date.now() - start);
                    res.destroy();
                });
            }).on('error', reject);
        });
        clearInterval(timer);
        await stream.stop();
        assert.ok(firstByte < 1000, `first audio after ${firstByte} ms`);
    });

    it('falls back to the system when npm left out the optional package', async () => {
        const Module = require('node:module');
        const load = Module._load;
        Module._load = function (request, ...rest) {
            if (request === 'ffmpeg-static') {
                throw new Error('Cannot find module');
            }
            return load.call(this, request, ...rest);
        };
        try {
            const found = await findFfmpeg(silent);
            assert.ok(found === null || found === 'ffmpeg', `found ${found}`);
        } finally {
            Module._load = load;
        }
    });

    it('survives a missing ffmpeg', async () => {
        const port = 18200;
        const errors = [];
        const source = new EventEmitter();
        const stream = new StreamServer(
            { port, format: 'mp3', ffmpeg: join(tmpdir(), 'no-such-ffmpeg'), source, sampleRate: SINK_RATE, channels: 2 },
            { ...silent, error: msg => errors.push(msg) },
            () => {},
        );
        await stream.start();
        await new Promise(resolve => {
            http.get({ port, host: '127.0.0.1', path: stream.path }, res => {
                res.on('data', () => {});
                res.on('end', resolve);
                res.on('close', resolve);
            }).on('error', resolve);
        });
        source.emit('pcm', Buffer.alloc(1000));
        await waitFor(() => errors.length > 0, 'error message');
        await stream.stop();
    });
});

/**
 * The real client library, as far as it can be tested without Soloist. pacat comes from pulseaudio-utils and links
 * libpulse, the same library Soloist loads. Skipped where it is not installed, runs in the CI job "libpulse".
 */
describe('real libpulse', function () {
    this.timeout(30_000);
    const pacat = process.env.PACAT || 'pacat';
    const available = spawnSync(pacat, ['--version']).status === 0;
    let dir;
    let server;

    before(function () {
        if (!available) {
            this.skip();
        }
    });

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'pulse-real-'));
        server = new PulseServer(join(dir, 'run'), silent, reason => assert.fail(reason));
    });

    afterEach(async () => {
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    /** Plays raw audio with pacat and returns the non silent frames that came out of the server. */
    async function play(data, args = []) {
        const out = [];
        server.on('pcm', c => out.push(c));
        await server.start(process.platform === 'win32' ? { port: 0, host: '127.0.0.1' } : undefined);
        const env =
            process.platform === 'win32'
                ? { ...process.env, PULSE_SERVER: `tcp:127.0.0.1:${server.address.port}` }
                : server.env;
        const child = spawn(pacat, ['--playback', '--raw', '--format=s16le', '--rate=44100', '--channels=2', ...args], {
            env,
            stdio: ['pipe', 'inherit', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', d => (stderr += d));
        child.stdin.end(data);
        const code = await new Promise(resolve => child.on('close', resolve));
        assert.equal(code, 0, `pacat failed: ${stderr}`);
        const all = Buffer.concat(out);
        const frames = [];
        for (let i = 0; i + 4 <= all.length; i += 4) {
            if (all.readInt16LE(i) !== 0 || all.readInt16LE(i + 2) !== 0) {
                frames.push([all.readInt16LE(i), all.readInt16LE(i + 2)]);
            }
        }
        return frames;
    }

    it('plays audio from pacat bit-exact and in real time', async () => {
        const count = 44100;
        const start = Date.now();
        const frames = await play(samples(count));
        const elapsed = Date.now() - start;
        assert.equal(frames.length, count);
        frames.forEach(([l, r], i) => {
            assert.equal(l, sampleValue(i));
            assert.equal(r, -sampleValue(i));
        });
        assert.ok(elapsed >= 800, `one second of audio took only ${elapsed} ms`);
    });

    it('applies the volume requested on connect', async () => {
        const frame = Buffer.alloc(4);
        frame.writeInt16LE(16000, 0);
        frame.writeInt16LE(16000, 2);
        const frames = await play(Buffer.concat(new Array(22050).fill(frame)), [`--volume=${VOLUME_NORM / 2}`]);
        assert.deepEqual(frames[1000], [2000, 2000]);
    });

    it('works with low latency buffer settings', async () => {
        const frames = await play(samples(22050), ['--latency-msec=50', '--process-time-msec=10']);
        assert.equal(frames.length, 22050);
    });
});
