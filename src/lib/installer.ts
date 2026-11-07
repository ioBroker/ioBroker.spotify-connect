import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hasBinary, run } from './run';

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

export async function getVersion(binary: string): Promise<SoloistVersion | null> {
    if (!existsSync(binary)) {
        return null;
    }
    const res = await run(binary, ['--version'], { timeout: 15_000 });
    return parseVersion(res.stdout + res.stderr);
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
export async function downloadSoloist(dir: string, log: InstallerLog): Promise<{ version: SoloistVersion; remote: RemoteInfo }> {
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
    const version = await getVersion(newBin);
    if (!version) {
        throw new Error('Downloaded binary does not start on this system');
    }

    const target = join(dir, 'soloist');
    if (existsSync(target)) {
        await fs.rm(join(dir, 'soloist.bak'), { force: true });
        await fs.rename(target, join(dir, 'soloist.bak'));
    }
    await fs.copyFile(newBin, target);
    await fs.chmod(target, 0o755);
    await fs.rm(tmp, { recursive: true, force: true });
    log.info(`Spotify Soloist ${version.version} installed (build ${new Date(version.buildTimestamp * 1000).toISOString().slice(0, 10)})`);
    return { version, remote };
}
