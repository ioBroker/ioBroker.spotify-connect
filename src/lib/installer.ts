import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cpus, release } from 'node:os';
import { hasBinary, run, type RunResult } from './run';

/**
 * Debian package and the library that proves it is installed. Soloist loads libpulse with dlopen() at runtime and
 * silently plays into nothing if it is missing, so it does not show up as a dependency of the binary.
 */
const PULSE_PACKAGE = 'libpulse0';
const PULSE_LIBRARY = 'libpulse.so.0';

const DOWNLOAD_BASE = 'https://soloist-builds.spotifycdn.com';
/** Builds are valid for 90 days after their build date (documented by Spotify). */
export const BUILD_LIFETIME_DAYS = 90;
/**
 * Oldest glibc the Soloist builds run on directly. All builds (x86_64, arm64, arm32) link against
 * GLIBC_2.38 symbols (__isoc23_strtol & co, fmodf), so Debian 12 / Raspberry Pi OS Bookworm (2.36) cannot start
 * them with the system loader. On such systems Soloist is started with a private glibc from Debian 13, see
 * {@link ensureGlibcRuntime}.
 */
export const MIN_GLIBC = '2.38';

/** Debian suite whose glibc is used as private runtime on older systems. */
const RUNTIME_SUITE = 'trixie';
const DEBIAN_MIRROR = 'https://deb.debian.org/debian';
const MADISON_URL = 'https://api.ftp-master.debian.org/madison';
/**
 * Debian packages that make up the private runtime. Soloist needs libc, libm, libpthread, libdl, librt
 * (all in libc6) and libatomic. The fallback versions are used if the Debian API cannot be reached.
 */
const RUNTIME_PACKAGES: { pkg: string; source: string; fallback: string }[] = [
    { pkg: 'libc6', source: 'glibc', fallback: '2.41-12+deb13u4' },
    { pkg: 'libatomic1', source: 'gcc-14', fallback: '14.2.0-19' },
];

interface RuntimeArch {
    /** Debian architecture name */
    debian: string;
    /** Name of the dynamic loader */
    loader: string;
    /** Multiarch folder of the libraries */
    triplet: string;
}

/** Folder of the private glibc inside the Soloist folder. */
export const RUNTIME_DIR = 'glibc';

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

/** Maps Node's arch to Debian's architecture and loader name. */
export function runtimeArch(): RuntimeArch {
    switch (process.arch) {
        case 'arm64':
            return { debian: 'arm64', loader: 'ld-linux-aarch64.so.1', triplet: 'aarch64-linux-gnu' };
        case 'arm':
            return { debian: 'armhf', loader: 'ld-linux-armhf.so.3', triplet: 'arm-linux-gnueabihf' };
        case 'x64':
            return { debian: 'amd64', loader: 'ld-linux-x86-64.so.2', triplet: 'x86_64-linux-gnu' };
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

/** True if the system glibc is too old for Soloist and the private runtime from Debian 13 is needed. */
export function needsGlibcRuntime(): boolean {
    const glibc = glibcVersion();
    return !!glibc && compareVersions(glibc, MIN_GLIBC) < 0;
}

/**
 * Checks whether Soloist can run on this system at all. Returns an error message if not.
 * Nothing the adapter can install fixes these problems, only an OS change.
 */
export async function checkSystem(): Promise<string | null> {
    if (process.platform !== 'linux') {
        return 'This adapter currently supports Linux only';
    }
    if (!glibcVersion()) {
        return `Spotify Soloist needs a glibc based Linux (Debian, Ubuntu, Raspberry Pi OS). ${await osName()} is not supported (musl/Alpine?)`;
    }
    try {
        runtimeArch();
    } catch (e) {
        return (e as Error).message;
    }
    if (needsGlibcRuntime() && !(await hasBinary('dpkg-deb'))) {
        return `Spotify Soloist needs glibc ${MIN_GLIBC} or newer, but ${await osName()} has glibc ${glibcVersion()} and no "dpkg-deb" to install a newer one for Soloist only. Please upgrade to Debian 13 (Trixie), Raspberry Pi OS based on Trixie or Ubuntu 24.04 or newer`;
    }
    return null;
}

export interface SoloistCommand {
    cmd: string;
    /** Arguments that go before the Soloist arguments */
    args: string[];
}

/**
 * Command line to start Soloist. With a private runtime the binary is not executed directly but loaded
 * by the newer dynamic loader, which then uses the newer libc. The system libraries stay untouched.
 *
 * @param binary path to the soloist binary
 * @param runtime folder of the private glibc or null to start the binary directly
 */
export function soloistCommand(binary: string, runtime: string | null): SoloistCommand {
    if (!runtime) {
        return { cmd: binary, args: [] };
    }
    return {
        cmd: join(runtime, runtimeArch().loader),
        args: ['--library-path', runtime, '--argv0', binary, binary],
    };
}

/** Path of a binary package in the Debian pool, e.g. pool/main/g/glibc/libc6_2.41-12_amd64.deb */
export function debianPoolPath(pkg: string, source: string, version: string, arch: string): string {
    const prefix = source.startsWith('lib') ? source.slice(0, 4) : source[0];
    const fileVersion = version.replace(/^\d+:/, ''); // the epoch is not part of the file name
    return `pool/main/${prefix}/${source}/${pkg}_${encodeURIComponent(fileVersion)}_${arch}.deb`;
}

type MadisonInfo = Record<string, Record<string, Record<string, { source?: string }>>>;

/** Asks the Debian archive which versions of the runtime packages are current in the runtime suite. */
async function resolveRuntimePackages(arch: string): Promise<{ pkg: string; source: string; version: string }[]> {
    let info: MadisonInfo = {};
    try {
        const res = await fetch(
            `${MADISON_URL}?package=${RUNTIME_PACKAGES.map(p => p.pkg).join('%20')}&s=${RUNTIME_SUITE}&a=${arch}&f=json`,
            { signal: AbortSignal.timeout(30_000) },
        );
        if (res.ok) {
            info = ((await res.json()) as MadisonInfo[])[0] || {};
        }
    } catch {
        // use the fallback versions
    }
    return RUNTIME_PACKAGES.map(p => {
        const found = Object.values(info[p.pkg] || {}).flatMap(suite => Object.entries(suite))[0];
        return found
            ? { pkg: p.pkg, source: found[1].source || p.source, version: found[0] }
            : { pkg: p.pkg, source: p.source, version: p.fallback };
    });
}

/**
 * Makes sure a private glibc from Debian 13 is available in <dir>/glibc. It is only used to start Soloist,
 * the system libraries are not touched. Returns the runtime folder.
 */
export async function ensureGlibcRuntime(dir: string, log: InstallerLog): Promise<string> {
    const { debian, loader } = runtimeArch();
    const runtime = join(dir, RUNTIME_DIR);
    if (existsSync(join(runtime, loader)) && existsSync(join(runtime, 'libatomic.so.1'))) {
        return runtime;
    }
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, 'glibc-download');
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(join(tmp, 'root'), { recursive: true });

    try {
        const packages = await resolveRuntimePackages(debian);
        log.info(
            `glibc ${glibcVersion()} is too old for Spotify Soloist, installing ${packages.map(p => `${p.pkg} ${p.version}`).join(', ')} from Debian 13 for Soloist only`,
        );
        for (const p of packages) {
            const url = `${DEBIAN_MIRROR}/${debianPoolPath(p.pkg, p.source, p.version, debian)}`;
            log.debug(`Downloading ${url}`);
            const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
            if (!res.ok || !res.body) {
                throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
            }
            const deb = join(tmp, `${p.pkg}.deb`);
            await pipeline(Readable.fromWeb(res.body as any), createWriteStream(deb));
            const x = await run('dpkg-deb', ['-x', deb, join(tmp, 'root')]);
            if (x.code !== 0) {
                throw new Error(`Cannot unpack ${p.pkg}: ${(x.stderr || x.stdout).trim()}`);
            }
        }
        // all libraries are in usr/lib/<triplet>, next to libc.so.6
        const find = await run('find', [join(tmp, 'root'), '-name', 'libc.so.6', '-type', 'f']);
        const libc = find.stdout.trim().split('\n')[0];
        if (!libc) {
            throw new Error('libc.so.6 not found in the Debian package');
        }
        const libDir = dirname(libc);
        for (const file of [loader, 'libm.so.6', 'libatomic.so.1']) {
            if (!existsSync(join(libDir, file))) {
                throw new Error(`${file} not found in the Debian packages`);
            }
        }
        await fs.writeFile(join(libDir, 'VERSION'), `${packages.map(p => `${p.pkg} ${p.version}`).join('\n')}\n`);
        await fs.rm(runtime, { recursive: true, force: true });
        await fs.rename(libDir, runtime);
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
    return runtime;
}

export function soloistUrl(): string {
    return `${DOWNLOAD_BASE}/soloist_release_${soloistArch()}.tar.gz`;
}

/** True if libpulse is in one of the folders the dynamic loader searches. */
export function hasPulseLibrary(): boolean {
    const { triplet } = runtimeArch();
    return [
        `/lib/${triplet}`,
        `/usr/lib/${triplet}`,
        '/lib',
        '/usr/lib',
        '/lib64',
        '/usr/lib64',
        '/usr/local/lib',
    ].some(dir => existsSync(join(dir, PULSE_LIBRARY)));
}

/**
 * Finds a working ffmpeg: the binary of the ffmpeg-static package, or the one of the system if the download
 * of that package failed or its binary cannot run here. Returns null if there is none.
 */
export async function findFfmpeg(log: InstallerLog): Promise<string | null> {
    const works = async (bin: string): Promise<boolean> =>
        (await run(bin, ['-version'], { timeout: 15_000 })).code === 0;

    let bundled: string | null = null;
    try {
        // An optional dependency: npm leaves it out if the download of the binary fails during the installation.
        // As a normal dependency, that would make the installation of the whole adapter fail.
        bundled = require('ffmpeg-static') as string | null;
    } catch {
        log.debug('Package ffmpeg-static is not installed');
    }
    if (bundled) {
        if (!existsSync(bundled)) {
            // ffmpeg-static downloads the binary in its install script, which does not run with --ignore-scripts
            log.info('Downloading ffmpeg');
            const res = await run(process.execPath, [join(dirname(bundled), 'install.js')], {
                cwd: dirname(bundled),
            });
            if (res.code !== 0) {
                log.warn(
                    `Cannot download ffmpeg: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`,
                );
            }
        }
        if (existsSync(bundled) && (await works(bundled))) {
            return bundled;
        }
    }
    return (await hasBinary('ffmpeg')) && (await works('ffmpeg')) ? 'ffmpeg' : null;
}

/**
 * Installs the missing Debian package with "sudo -n apt-get". Standard ioBroker installations allow this
 * without password. Returns the list of packages that are still missing.
 */
export async function ensureOsPackages(log: InstallerLog): Promise<string[]> {
    if (process.platform !== 'linux') {
        throw new Error('This adapter currently supports Linux only');
    }
    if (hasPulseLibrary()) {
        return [];
    }
    log.info(`Installing missing package: ${PULSE_PACKAGE}`);
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    const install = ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', PULSE_PACKAGE];
    let res = await run('sudo', install, { env });
    if (res.code !== 0 && /Unable to locate|has no installation candidate/i.test(res.stderr + res.stdout)) {
        await run('sudo', ['-n', 'apt-get', 'update'], { env });
        res = await run('sudo', install, { env });
    }
    if (res.code !== 0) {
        log.warn(`apt-get failed: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    return hasPulseLibrary() ? [] : [PULSE_PACKAGE];
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

/**
 * Runs "soloist --version". On failure, error holds the reason (e.g. missing library or glibc version).
 *
 * @param binary path to the soloist binary
 * @param runtime folder of the private glibc or null
 */
export async function probeBinary(
    binary: string,
    runtime: string | null,
): Promise<{ version: SoloistVersion | null; error: string }> {
    if (!existsSync(binary)) {
        return { version: null, error: 'binary not found' };
    }
    const c = soloistCommand(binary, runtime);
    const res = await run(c.cmd, [...c.args, '--version'], { timeout: 15_000 });
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

export async function getVersion(binary: string, runtime: string | null): Promise<SoloistVersion | null> {
    return (await probeBinary(binary, runtime)).version;
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
    runtime: string | null,
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
    const { version, error } = await probeBinary(newBin, runtime);
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
