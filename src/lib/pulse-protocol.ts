/**
 * Wire format of the PulseAudio native protocol: frames and tag structures.
 * Field order and tags follow src/pulsecore/tagstruct.c and pstream.c of PulseAudio.
 */

/** Protocol version of PulseAudio 15 to 17. Client and server use the lower of both versions. */
export const PROTOCOL_VERSION = 35;
export const PROTOCOL_VERSION_MASK = 0xffff;
export const INVALID_INDEX = 0xffffffff;
export const VOLUME_NORM = 0x10000;
/** The channel of a frame that carries a command instead of audio */
export const COMMAND_CHANNEL = 0xffffffff;
/** Tag of messages the server sends on its own */
export const NO_TAG = 0xffffffff;

const DESCRIPTOR_SIZE = 20;
/** FRAME_SIZE_MAX_ALLOW in pstream.c */
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

/** Values of the command enum in native-common.h that the server handles or sends. */
export const Command = {
    ERROR: 0,
    REPLY: 2,
    CREATE_PLAYBACK_STREAM: 3,
    DELETE_PLAYBACK_STREAM: 4,
    AUTH: 8,
    SET_CLIENT_NAME: 9,
    DRAIN_PLAYBACK_STREAM: 12,
    GET_PLAYBACK_LATENCY: 14,
    GET_SERVER_INFO: 20,
    GET_SINK_INPUT_INFO: 29,
    SUBSCRIBE: 35,
    SET_SINK_INPUT_VOLUME: 37,
    CORK_PLAYBACK_STREAM: 41,
    FLUSH_PLAYBACK_STREAM: 42,
    TRIGGER_PLAYBACK_STREAM: 43,
    PREBUF_PLAYBACK_STREAM: 60,
    REQUEST: 61,
    OVERFLOW: 62,
    UNDERFLOW: 63,
    SUBSCRIBE_EVENT: 66,
    UPDATE_PLAYBACK_STREAM_PROPLIST: 81,
    UPDATE_CLIENT_PROPLIST: 82,
    REMOVE_PLAYBACK_STREAM_PROPLIST: 84,
    REMOVE_CLIENT_PROPLIST: 85,
    STARTED: 86,
} as const;

/** Values of the error enum in def.h. */
export const PaError = {
    ACCESS: 1,
    INVALID: 3,
    NOENTITY: 5,
    VERSION: 17,
    NOTSUPPORTED: 19,
} as const;

export const Subscription = {
    FACILITY_SINK_INPUT: 0x0002,
    TYPE_NEW: 0x0000,
    TYPE_CHANGE: 0x0010,
    TYPE_REMOVE: 0x0020,
} as const;

/** PA_ENCODING_PCM */
export const ENCODING_PCM = 1;

const Tag = {
    STRING: 0x74, // t
    STRING_NULL: 0x4e, // N
    U32: 0x4c, // L
    U8: 0x42, // B
    U64: 0x52, // R
    S64: 0x72, // r
    SAMPLE_SPEC: 0x61, // a
    ARBITRARY: 0x78, // x
    BOOLEAN_TRUE: 0x31, // 1
    BOOLEAN_FALSE: 0x30, // 0
    TIMEVAL: 0x54, // T
    USEC: 0x55, // U
    CHANNEL_MAP: 0x6d, // m
    CVOLUME: 0x76, // v
    PROPLIST: 0x50, // P
    FORMAT_INFO: 0x66, // f
} as const;

export interface SampleSpec {
    format: number;
    channels: number;
    rate: number;
}

export interface Timeval {
    sec: number;
    usec: number;
}

/** A client sent something that does not follow the protocol: the connection has to be closed. */
export class ProtocolError extends Error {}

export class TagReader {
    private pos = 0;

    public constructor(private readonly buf: Buffer) {}

    public get eof(): boolean {
        return this.pos >= this.buf.length;
    }

    private need(bytes: number): void {
        if (this.pos + bytes > this.buf.length) {
            throw new ProtocolError('Tag structure is too short');
        }
    }

    private tag(expected: number): void {
        this.need(1);
        const tag = this.buf[this.pos++];
        if (tag !== expected) {
            throw new ProtocolError(
                `Expected tag "${String.fromCharCode(expected)}", got "${String.fromCharCode(tag)}"`,
            );
        }
    }

    private rawU8(): number {
        this.need(1);
        return this.buf[this.pos++];
    }

    private rawU32(): number {
        this.need(4);
        const v = this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    public u8(): number {
        this.tag(Tag.U8);
        return this.rawU8();
    }

    public u32(): number {
        this.tag(Tag.U32);
        return this.rawU32();
    }

    private withU64(tag: number): number {
        this.tag(tag);
        this.need(8);
        const v = Number(this.buf.readBigInt64BE(this.pos));
        this.pos += 8;
        return v;
    }

    public u64(): number {
        return this.withU64(Tag.U64);
    }

    public s64(): number {
        return this.withU64(Tag.S64);
    }

    public usec(): number {
        return this.withU64(Tag.USEC);
    }

    public bool(): boolean {
        this.need(1);
        const tag = this.buf[this.pos++];
        if (tag !== Tag.BOOLEAN_TRUE && tag !== Tag.BOOLEAN_FALSE) {
            throw new ProtocolError(`Expected boolean, got "${String.fromCharCode(tag)}"`);
        }
        return tag === Tag.BOOLEAN_TRUE;
    }

    public string(): string | null {
        this.need(1);
        const tag = this.buf[this.pos++];
        if (tag === Tag.STRING_NULL) {
            return null;
        }
        if (tag !== Tag.STRING) {
            throw new ProtocolError(`Expected string, got "${String.fromCharCode(tag)}"`);
        }
        const end = this.buf.indexOf(0, this.pos);
        if (end < 0) {
            throw new ProtocolError('String without terminator');
        }
        const s = this.buf.toString('utf8', this.pos, end);
        this.pos = end + 1;
        return s;
    }

    public arbitrary(length?: number): Buffer {
        this.tag(Tag.ARBITRARY);
        const len = this.rawU32();
        if (length !== undefined && len !== length) {
            throw new ProtocolError(`Expected ${length} bytes, got ${len}`);
        }
        this.need(len);
        const data = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return data;
    }

    public sampleSpec(): SampleSpec {
        this.tag(Tag.SAMPLE_SPEC);
        return { format: this.rawU8(), channels: this.rawU8(), rate: this.rawU32() };
    }

    public channelMap(): number[] {
        this.tag(Tag.CHANNEL_MAP);
        const channels = this.rawU8();
        const map: number[] = [];
        for (let i = 0; i < channels; i++) {
            map.push(this.rawU8());
        }
        return map;
    }

    public cvolume(): number[] {
        this.tag(Tag.CVOLUME);
        const channels = this.rawU8();
        const volumes: number[] = [];
        for (let i = 0; i < channels; i++) {
            volumes.push(this.rawU32());
        }
        return volumes;
    }

    public timeval(): Timeval {
        this.tag(Tag.TIMEVAL);
        return { sec: this.rawU32(), usec: this.rawU32() };
    }

    public proplist(): Map<string, Buffer> {
        this.tag(Tag.PROPLIST);
        const props = new Map<string, Buffer>();
        for (;;) {
            const key = this.string();
            if (key === null) {
                return props;
            }
            const length = this.u32();
            props.set(key, this.arbitrary(length));
        }
    }

    public formatInfo(): void {
        this.tag(Tag.FORMAT_INFO);
        this.u8();
        this.proplist();
    }
}

export class TagWriter {
    private readonly parts: Buffer[] = [];

    private raw(...bytes: number[]): this {
        this.parts.push(Buffer.from(bytes));
        return this;
    }

    private withU32(tag: number, value: number): this {
        const b = Buffer.alloc(5);
        b[0] = tag;
        b.writeUInt32BE(value >>> 0, 1);
        this.parts.push(b);
        return this;
    }

    private withU64(tag: number, value: number): this {
        const b = Buffer.alloc(9);
        b[0] = tag;
        b.writeBigInt64BE(BigInt(Math.trunc(value)), 1);
        this.parts.push(b);
        return this;
    }

    public u8(value: number): this {
        return this.raw(Tag.U8, value);
    }

    public u32(value: number): this {
        return this.withU32(Tag.U32, value);
    }

    public u64(value: number): this {
        return this.withU64(Tag.U64, value);
    }

    public s64(value: number): this {
        return this.withU64(Tag.S64, value);
    }

    public usec(value: number): this {
        return this.withU64(Tag.USEC, value);
    }

    public bool(value: boolean): this {
        return this.raw(value ? Tag.BOOLEAN_TRUE : Tag.BOOLEAN_FALSE);
    }

    public string(value: string | null): this {
        if (value === null) {
            return this.raw(Tag.STRING_NULL);
        }
        this.parts.push(Buffer.from([Tag.STRING]), Buffer.from(value, 'utf8'), Buffer.from([0]));
        return this;
    }

    public arbitrary(data: Buffer): this {
        this.withU32(Tag.ARBITRARY, data.length);
        this.parts.push(data);
        return this;
    }

    public sampleSpec(spec: SampleSpec): this {
        const b = Buffer.alloc(7);
        b[0] = Tag.SAMPLE_SPEC;
        b[1] = spec.format;
        b[2] = spec.channels;
        b.writeUInt32BE(spec.rate, 3);
        this.parts.push(b);
        return this;
    }

    public channelMap(map: number[]): this {
        return this.raw(Tag.CHANNEL_MAP, map.length, ...map);
    }

    public cvolume(volumes: number[]): this {
        this.raw(Tag.CVOLUME, volumes.length);
        for (const v of volumes) {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(v, 0);
            this.parts.push(b);
        }
        return this;
    }

    public timeval(tv: Timeval): this {
        const b = Buffer.alloc(9);
        b[0] = Tag.TIMEVAL;
        b.writeUInt32BE(tv.sec >>> 0, 1);
        b.writeUInt32BE(tv.usec >>> 0, 5);
        this.parts.push(b);
        return this;
    }

    public proplist(props: Map<string, Buffer> = new Map()): this {
        this.raw(Tag.PROPLIST);
        for (const [key, value] of props) {
            this.string(key).u32(value.length).arbitrary(value);
        }
        return this.string(null);
    }

    public formatInfo(encoding: number): this {
        this.raw(Tag.FORMAT_INFO);
        return this.u8(encoding).proplist();
    }

    public toBuffer(): Buffer {
        return Buffer.concat(this.parts);
    }
}

/** Builds a frame. A command frame has offset and flags 0. */
export function buildFrame(channel: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(DESCRIPTOR_SIZE);
    head.writeUInt32BE(payload.length, 0);
    head.writeUInt32BE(channel, 4);
    return Buffer.concat([head, payload]);
}

export type FrameHandler = (channel: number, payload: Buffer) => void;

/** Splits the byte stream of a socket into frames, however it was fragmented. */
export class FrameParser {
    private pending: Buffer = Buffer.alloc(0);

    public constructor(private readonly onFrame: FrameHandler) {}

    public push(chunk: Buffer): void {
        let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        while (buf.length >= DESCRIPTOR_SIZE) {
            const length = buf.readUInt32BE(0);
            if (length > MAX_FRAME_SIZE) {
                throw new ProtocolError(`Frame of ${length} bytes is too large`);
            }
            // Bytes 8-15 hold the seek offset: audio is always appended, Soloist does not seek in the stream.
            if ((buf.readUInt32BE(16) & 0xff000000) !== 0) {
                // would need shared memory, which the server never offers
                throw new ProtocolError('Frame refers to shared memory');
            }
            if (buf.length < DESCRIPTOR_SIZE + length) {
                break;
            }
            this.onFrame(buf.readUInt32BE(4), buf.subarray(DESCRIPTOR_SIZE, DESCRIPTOR_SIZE + length));
            buf = buf.subarray(DESCRIPTOR_SIZE + length);
        }
        // keep a copy: "chunk" may belong to a large pool buffer
        this.pending = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
    }
}
