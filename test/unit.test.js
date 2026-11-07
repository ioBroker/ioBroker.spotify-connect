const assert = require('node:assert/strict');
const { parseVersion, soloistArch, soloistUrl, compareVersions, BUILD_LIFETIME_DAYS } = require('../build/lib/installer');
const { STATES } = require('../build/lib/states');

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
