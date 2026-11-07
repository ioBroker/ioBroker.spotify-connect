import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cpus, release } from 'node:os';
import { hasBinary, run, type RunResult } from './run';

/** Debian packages and the binary that proves each one is installed. */
const OS_PACKAGES: { pkg: string; bin: string }[] = [
    { pkg: 'pipewire', bin: 'pipewire' },
    { pkg: 'pipewire-pulse', bin: 'pipewire-pulse' },
    { pkg: 'wireplumber', bin: 'wireplumber' },
    { pkg: 'pulseaudio-utils', bin: 'pactl' },
    { pkg: 'ffmpeg', bin: 'ffmpeg' },
];

const DOWNLOAD_BASE = 'https://soloist-builds.spotifycdn.com';
/** Builds are valid for 90 days after their build date (documented by Spotify). */
export const BUILD_LIFETIME_DAYS = 90;
/**
 * Oldest glibc the Soloist builds run on. All builds (x86_64, arm64, arm32) link against
 * GLIBC_2.38 symbols (__isoc23_strtol, strlcpy), so Debian 12 / Raspberry Pi OS Bookworm (2.36) cannot run them.
 */
export const MIN_GLIBC = '2.38';

export interface SoloistVersion {
    version: string;
    buildTimestamp: number; // seconds since epoch
    expiresAt: number; // ms since epoch
    raw: string;
}

export interface InstallerLog {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
}

/** Maps Node's arch to Spotify's archive name. */
export function soloistArch(): string {
    switch (process.arch) {
        case 'arm64':
            return 'arm64';
        case 'arm':
            return 'arm32';
        case 'x64':
            return 'x86_64';
        default:
            throw new Error(`Spotify Soloist is not available for architecture "${process.arch}"`);
    }
}

/** Compares dotted version strings: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) {
            return d;
        }
    }
    return 0;
}

/** glibc version of this system, or null if Node does not run on glibc (e.g. musl/Alpine). */
export function glibcVersion(): string | null {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return header?.glibcVersionRuntime || null;
}

async function osName(): Promise<string> {
    try {
        const text = await fs.readFile('/etc/os-release', 'utf8');
        const m = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        return m ? m[1] : 'this system';
    } catch {
        return 'this system';
    }
}

/**
 * Checks whether Soloist can run on this system at all. Returns an error message if not.
 * Nothing the adapter can install fixes these problems, only an OS upgrade.
 */
export async function checkSystem(): Promise<string | null> {
    if (process.platform !== 'linux') {
        return 'This adapter currently supports Linux only';
    }
    const glibc = glibcVersion();
    if (!glibc) {
        return `Spotify Soloist needs a glibc based Linux (Debian, Ubuntu, Raspberry Pi OS). ${await osName()} is not supported (musl/Alpine?)`;
    }
    if (compareVersions(glibc, MIN_GLIBC) < 0) {
        return `Spotify Soloist needs glibc ${MIN_GLIBC} or newer, but ${await osName()} has glibc ${glibc}. Please upgrade to Debian 13 (Trixie), Raspberry Pi OS based on Trixie or Ubuntu 24.04 or newer`;
    }
    return null;
}

export function soloistUrl(): string {
    return `${DOWNLOAD_BASE}/soloist_release_${soloistArch()}.tar.gz`;
}

/**
 * Installs missing Debian packages with "sudo -n apt-get". Standard ioBroker installations allow this
 * without password. Returns the list of packages that are still missing.
 */
export async function ensureOsPackages(log: InstallerLog): Promise<string[]> {
    if (process.platform !== 'linux') {
        throw new Error('This adapter currently supports Linux only');
    }
    const missing: string[] = [];
    for (const p of OS_PACKAGES) {
        if (!(await hasBinary(p.bin))) {
            missing.push(p.pkg);
        }
    }
    if (!missing.length) {
        return [];
    }
    log.info(`Installing missing packages: ${missing.join(', ')}`);
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    let res = await run('sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', ...missing], { env });
    if (res.code !== 0 && /Unable to locate|has no installation candidate/i.test(res.stderr + res.stdout)) {
        await run('sudo', ['-n', 'apt-get', 'update'], { env });
        res = await run('sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', ...missing], { env });
    }
    if (res.code !== 0) {
        log.warn(`apt-get failed: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    const still: string[] = [];
    for (const p of OS_PACKAGES) {
        if (!(await hasBinary(p.bin))) {
            still.push(p.pkg);
        }
    }
    return still;
}

/** Parses "soloist 1.3.10.51 build 1793988108 (20261106) (g19412df6ea) (linux/aarch64)". */
export function parseVersion(raw: string): SoloistVersion | null {
    const m = raw.match(/soloist\s+([\d.]+)\s+build\s+(\d+)/i);
    if (!m) {
        return null;
    }
    const buildTimestamp = parseInt(m[2], 10);
    return {
        version: m[1],
        buildTimestamp,
        expiresAt: buildTimestamp * 1000 + BUILD_LIFETIME_DAYS * 24 * 3600 * 1000,
        raw: raw.trim(),
    };
}

/** Runs "soloist --version". On failure, error holds the reason (e.g. missing library or glibc version). */
export async function probeBinary(binary: string): Promise<{ version: SoloistVersion | null; error: string }> {
    if (!existsSync(binary)) {
        return { version: null, error: 'binary not found' };
    }
    const res = await run(binary, ['--version'], { timeout: 15_000 });
    const version = parseVersion(res.stdout + res.stderr);
    if (version) {
        return { version, error: '' };
    }
    const output = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ').trim();
    return { version: null, error: describeFailure(res, output) };
}

function describeFailure(res: RunResult, output: string): string {
    const parts: string[] = [];
    if (res.spawnError === 'EACCES') {
        parts.push('permission denied - is the data directory mounted with "noexec"?');
    } else if (res.spawnError === 'ENOENT') {
        parts.push('cannot execute - ELF interpreter /lib/ld-linux* missing (musl/Alpine or wrong architecture?)');
    } else if (res.spawnError) {
        parts.push(res.spawnError);
    }
    if (res.signal === 'SIGILL') {
        parts.push(`killed by SIGILL - the CPU (${cpuModel()}) does not support the instructions used by this build`);
    } else if (res.signal === 'SIGSYS') {
        parts.push('killed by SIGSYS - a system call is blocked (Docker seccomp profile or old kernel)');
    } else if (res.signal) {
        parts.push(`killed by ${res.signal}`);
    }
    if (output) {
        parts.push(output);
    }
    if (!parts.length) {
        parts.push(`exit code ${res.code}`);
    }
    return `${parts.join('; ')}; kernel ${release()}`;
}

function cpuModel(): string {
    return cpus()[0]?.model?.trim() || 'unknown';
}

export async function getVersion(binary: string): Promise<SoloistVersion | null> {
    return (await probeBinary(binary)).version;
}

export interface RemoteInfo {
    lastModified: string;
    etag: string;
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
    const res = await fetch(soloistUrl(), { method: 'HEAD' });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${soloistUrl()}`);
    }
    return { lastModified: res.headers.get('last-modified') || '', etag: res.headers.get('etag') || '' };
}

/**
 * Downloads the current Soloist build from Spotify into <dir>/soloist. The new binary is verified
 * before it replaces the old one; the previous binary is kept as soloist.bak.
 */
export async function downloadSoloist(
    dir: string,
    log: InstallerLog,
): Promise<{ version: SoloistVersion; remote: RemoteInfo }> {
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, 'download');
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });

    const url = soloistUrl();
    log.info(`Downloading Spotify Soloist from ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Download failed: HTTP ${res.status}`);
    }
    const remote = { lastModified: res.headers.get('last-modified') || '', etag: res.headers.get('etag') || '' };
    const archive = join(tmp, 'soloist.tar.gz');
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(archive));

    const tar = await run('tar', ['xzf', archive, '-C', tmp]);
    if (tar.code !== 0) {
        throw new Error(`Cannot unpack archive: ${tar.stderr.trim()}`);
    }
    const find = await run('find', [tmp, '-maxdepth', '3', '-type', 'f', '-name', 'soloist']);
    const newBin = find.stdout.trim().split('\n')[0];
    if (!newBin) {
        throw new Error('Archive does not contain a "soloist" binary');
    }
    await fs.chmod(newBin, 0o755);
    const { version, error } = await probeBinary(newBin);
    if (!version) {
        await fs.rm(tmp, { recursive: true, force: true });
        throw new Error(`Downloaded binary does not start on this system (${error})`);
    }

    const target = join(dir, 'soloist');
    if (existsSync(target)) {
        await fs.rm(join(dir, 'soloist.bak'), { force: true });
        await fs.rename(target, join(dir, 'soloist.bak'));
    }
    await fs.copyFile(newBin, target);
    await fs.chmod(target, 0o755);
    await fs.rm(tmp, { recursive: true, force: true });
    log.info(
        `Spotify Soloist ${version.version} installed (build ${new Date(version.buildTimestamp * 1000).toISOString().slice(0, 10)})`,
    );
    return { version, remote };
}
