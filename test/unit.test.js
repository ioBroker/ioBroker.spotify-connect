const assert = require('node:assert/strict');
const {
    parseVersion,
    soloistArch,
    soloistUrl,
    compareVersions,
    soloistCommand,
    debianPoolPath,
    runtimeArch,
    BUILD_LIFETIME_DAYS,
} = require('../build/lib/installer');
const { PlaybackClock } = require('../build/lib/playback-clock');
const { STATES } = require('../build/lib/states');

describe('PlaybackClock', () => {
    let time;
    let clock;

    beforeEach(() => {
        time = 1000;
        clock = new PlaybackClock(() => time);
    });

    it('runs only while the playback is running', () => {
        clock.setPosition(10_000);
        time += 5000;
        assert.equal(clock.seconds, 10);

        clock.setRunning(true);
        time += 5000;
        assert.equal(clock.seconds, 15);

        clock.setRunning(false);
        time += 5000;
        assert.equal(clock.seconds, 15);

        clock.setRunning(true);
        time += 1000;
        assert.equal(clock.seconds, 16);
    });

    it('does not lose time if "running" is reported twice', () => {
        clock.setRunning(true);
        time += 3000;
        clock.setRunning(true);
        time += 3000;
        assert.equal(clock.seconds, 6);
    });

    it('takes over a reported position during the playback', () => {
        clock.setRunning(true);
        time += 50_000;
        clock.setPosition(120_000);
        assert.equal(clock.seconds, 120);
        time += 2000;
        assert.equal(clock.seconds, 122);
    });

    it('does not run past the end of the track', () => {
        clock.setDuration(10_000);
        clock.setPosition(9000);
        clock.setRunning(true);
        time += 60_000;
        assert.equal(clock.seconds, 10);
    });
});

describe('installer', () => {
    it('parses the Soloist version line', () => {
        const v = parseVersion('soloist 1.3.10.51 build 1793988108 (20261106) (g19412df6ea) (linux/aarch64)');
        assert.ok(v);
        assert.equal(v.version, '1.3.10.51');
        assert.equal(v.buildTimestamp, 1793988108);
        assert.equal(v.expiresAt, 1793988108 * 1000 + BUILD_LIFETIME_DAYS * 86400 * 1000);
    });

    it('returns null for unknown output', () => {
        assert.equal(parseVersion('command not found'), null);
    });

    it('compares glibc versions', () => {
        assert.ok(compareVersions('2.36', '2.38') < 0);
        assert.equal(compareVersions('2.38', '2.38'), 0);
        assert.ok(compareVersions('2.41', '2.38') > 0);
        assert.ok(compareVersions('3.0', '2.38') > 0);
        assert.ok(compareVersions('2.38.1', '2.38') > 0);
    });

    it('builds the official download URL for this architecture', () => {
        const arch = soloistArch();
        assert.ok(['arm64', 'arm32', 'x86_64'].includes(arch));
        assert.equal(soloistUrl(), `https://soloist-builds.spotifycdn.com/soloist_release_${arch}.tar.gz`);
    });

    it('starts the binary directly without private glibc', () => {
        assert.deepEqual(soloistCommand('/data/soloist', null), { cmd: '/data/soloist', args: [] });
    });

    it('starts the binary with the loader of the private glibc', () => {
        const c = soloistCommand('/data/soloist', '/data/glibc');
        assert.equal(c.cmd, require('node:path').join('/data/glibc', runtimeArch().loader));
        assert.deepEqual(c.args, ['--library-path', '/data/glibc', '--argv0', '/data/soloist', '/data/soloist']);
    });

    it('builds Debian pool paths', () => {
        assert.equal(
            debianPoolPath('libc6', 'glibc', '2.41-12+deb13u4', 'amd64'),
            'pool/main/g/glibc/libc6_2.41-12%2Bdeb13u4_amd64.deb',
        );
        assert.equal(
            debianPoolPath('libatomic1', 'gcc-14', '14.2.0-19', 'arm64'),
            'pool/main/g/gcc-14/libatomic1_14.2.0-19_arm64.deb',
        );
        assert.equal(
            debianPoolPath('libfoo1', 'libfoo', '1:2.0-1', 'armhf'),
            'pool/main/libf/libfoo/libfoo1_2.0-1_armhf.deb',
        );
    });
});

describe('soloist log', () => {
    const { cleanLogLine, isLogProblem } = require('../build/lib/soloist');
    const color = '\u001b[1;31m';

    it('does not warn about PipeWire, Soloist always tries it first', () => {
        assert.equal(isLogProblem(`08:44:25.774 E [f:74   ] ${color}Pipewire initialization failed!!`), false);
        assert.equal(isLogProblem(`08:44:25.774 E [f:52   ] ${color}PipewireRenderer error isPipeWireDaemonReachable => 0`), false);
    });

    it('does not warn about informational lines', () => {
        assert.equal(isLogProblem('08:44:26.327 I [f:712  ] tryStartPlayback failed, not final + not enough buffered (10 tries)'), false);
    });

    it('warns about real errors in both log formats', () => {
        assert.equal(isLogProblem(`08:44:26.327 E [f:712  ] ${color}PulseAudio stream error`), true);
        assert.equal(isLogProblem('2026-11-08 08:44:26.327: Login failed'), true);
    });

    it('removes colors, time, level and position', () => {
        assert.equal(cleanLogLine(`08:44:26.327 E [f:712  ] ${color}Something failed`), 'Something failed');
        assert.equal(cleanLogLine('2026-11-08 08:44:26.327: Login failed'), 'Login failed');
    });
});

describe('states', () => {
    it('has no own state with role media.url (would be offered as target player)', () => {
        for (const [id, def] of Object.entries(STATES)) {
            assert.notEqual(def.role, 'media.url', id);
        }
    });

    it('has en, de and ru names for every state', () => {
        for (const [id, def] of Object.entries(STATES)) {
            for (const lang of ['en', 'de', 'ru']) {
                assert.ok(def.name[lang], `${id}: ${lang}`);
            }
        }
    });
});
