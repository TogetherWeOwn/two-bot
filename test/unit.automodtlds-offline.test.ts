import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAutomod } from '../src/automod/matcher.ts';
import { BARE_TLDS } from '../src/automod/tlds.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

// Hermetic matcher coverage: no database, Discord client or network requests.
const policy: AutomodPolicy = {
  badWords: [],
  blockedAttachmentExtensions: [],
  allowedDomains: ['two.gg'],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

function match(content: string, allowedDomains = policy.allowedDomains) {
  const message: AutomodMessage = {
    guildId: 'guild',
    channelId: 'channel',
    messageId: 'message',
    authorId: 'author',
    authorIsBot: false,
    roleIds: [],
    content,
    mentionedUserIds: [],
    attachmentNames: [],
    observedTimestamp: 0,
  };
  return matchAutomod(message, { ...policy, allowedDomains }, { observe: () => false });
}

test('bare phishing and shortener domains match their explicit-scheme forms (TOG-10050)', () => {
  for (const host of ['bit.ly', 'evil.de', 'evil.link', 'evil.shop', 'evil.online', 'evil.club', 'evil.ai', 'evil.xn--p1ai']) {
    for (const candidate of [host, host.toUpperCase(), `sub.${host}`]) {
      for (const prefix of ['', 'https://', 'http://', 'www.']) {
        assert.equal(match(`read ${prefix}${candidate}/abc`), 'external_link', `${prefix}${candidate}`);
      }
    }
  }
});

test('every IANA snapshot TLD is detected in bare and scheme forms', () => {
  // A missing import or an accidentally empty snapshot must not make this vacuous.
  assert.ok(BARE_TLDS.size > 1000);
  for (const tld of BARE_TLDS) {
    assert.match(tld, /^[a-z][a-z0-9-]{1,62}$/);
    for (const link of [`evil.${tld}`, `EVIL.${tld.toUpperCase()}/x`, `https://evil.${tld}/x`]) {
      assert.equal(match(`read ${link}`), 'external_link', link);
    }
  }
});

test('new TLDs preserve exact/subdomain allowlisting, not suffix or userinfo spoofing', () => {
  for (const host of ['bit.ly', 'good.de', 'good.club', 'good.xn--p1ai']) {
    for (const prefix of ['', 'https://', 'www.']) {
      for (const candidate of [host, `sub.${host}`, host.toUpperCase()]) {
        assert.equal(match(`read ${prefix}${candidate}/x`, [host]), null, `${prefix}${candidate}`);
      }
      for (const candidate of [`evil${host}`, `${host}.evil.de`]) {
        assert.equal(match(`read ${prefix}${candidate}/x`, [host]), 'external_link', candidate);
      }
    }
    assert.equal(match(`read https://${host}@evil.de/x`, [host]), 'external_link');
  }
});

test('bare dot lookalikes are detected without changing URL accent identity', () => {
  for (const code of [0x3002, 0xff61, 0x00b7, 0x2027, 0xff0e]) {
    const dot = String.fromCodePoint(code);
    assert.equal(match(`read evil${dot}de/x`), 'external_link', `U+${dot.codePointAt(0)?.toString(16)}`);
    assert.equal(match(`read two${dot}gg/rules`), null);
  }
  assert.equal(match('read café.de/x', ['cafe.de']), 'external_link');
  assert.equal(match('read https://café.de/x', ['cafe.de']), 'external_link');
});

test('bare matching still excludes email, source paths, common filenames and numeric versions', () => {
  for (const content of [
    'email person@evil.de',
    'inspect src/config.ts',
    'inspect src/index.de',
    'inspect README.md',
    'inspect package.json',
    'inspect config.dev',
    'inspect tsconfig.json',
    'inspect notes.txt',
    'inspect code.ts',
    'version v1.2.3',
    'address 127.0.0.1',
    'ordinary message',
  ]) {
    assert.equal(match(content), null, content);
  }
  // .md and .mov are real TLDs: only the established filename-stem guard
  // exempts bare filenames. A path or explicit scheme does not exempt a host.
  assert.equal(match('read evil.md/x'), 'external_link');
  assert.equal(match('read evil.mov/x'), 'external_link');
  assert.equal(match('read https://config.dev/x'), 'external_link');
});
