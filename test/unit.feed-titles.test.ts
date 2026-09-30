import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmlFeed } from '../src/announcements/discord.ts';

function feedXml(format: 'rss' | 'atom', title: string): string {
  return format === 'rss'
    ? `<rss><channel><item><guid>item-1</guid><title>${title}</title><link>https://example.com/item</link></item></channel></rss>`
    : `<feed><entry><id>item-1</id><title type="text">${title}</title><link rel="alternate" href="https://example.com/item" /></entry></feed>`;
}

for (const format of ['rss', 'atom'] as const) {
  test(`${format} titles decode the five predefined XML entities and numeric references`, () => {
    const [item] = parseXmlFeed(feedXml(format, '&amp; &lt; &gt; &quot; &apos; &#38; &#233; &#xE9; &#x1F680; &#128640;'));
    assert.equal(item?.title, '& < > " \' & é é 🚀 🚀');
  });

  test(`${format} titles decode only one layer of entity-looking text`, () => {
    const [item] = parseXmlFeed(feedXml(format, '&amp;lt;literal&amp;gt; &amp;#38; &amp;apos; &#38;lt; &#x26;#xE9;'));
    assert.equal(item?.title, '&lt;literal&gt; &#38; &apos; &lt; &#xE9;');
  });

  test(`${format} titles preserve literal CDATA and its position among decoded text`, () => {
    const [item] = parseXmlFeed(feedXml(format, 'Before&amp;<![CDATA[&amp; &#38; <literal>]]>&lt;<![CDATA[&apos;]]>After&#xE9;'));
    assert.equal(item?.title, 'Before&&amp; &#38; <literal><&apos;Afteré');
    assert.equal(parseXmlFeed(feedXml(format, '<![CDATA[&amp;lt; &#xE9; &apos;]]>'))[0]?.title, '&amp;lt; &#xE9; &apos;');
  });

  test(`${format} titles preserve unknown, malformed and illegal XML references`, () => {
    const title = '&custom; &nbsp; &AMP; &#0; &#8; &#xD800; &#xDFFF; &#xFFFE; &#xFFFF; &#x110000; &#999999999999999999999; &#-1; &#x; &#X41; &#65';
    assert.equal(parseXmlFeed(feedXml(format, title))[0]?.title, title);
  });

  test(`${format} titles accept the XML 1.0 character range boundaries`, () => {
    const title = 'A&#9;B&#10;C&#13;D&#32;E&#xD7FF;F&#xE000;G&#xFFFD;H&#x10000;I&#x10FFFF;Z';
    assert.equal(parseXmlFeed(feedXml(format, title))[0]?.title, 'A\tB\nC\rD E퟿FG�H\u{10000}I\u{10FFFF}Z');
  });
}

test('title decoding does not expand DOCTYPE-defined entities or leak definitions between feeds', () => {
  const declaration = '<!DOCTYPE rss [<!ENTITY custom "expanded"><!ENTITY amp "overridden">]>';
  const xml = feedXml('rss', '&custom; &amp;');
  assert.equal(parseXmlFeed(declaration + xml)[0]?.title, '&custom; &');
  assert.equal(parseXmlFeed(xml)[0]?.title, '&custom; &');
});

test('title decoding leaves historical keys, links and dates on their existing decoder', () => {
  const rss = parseXmlFeed('<rss><channel><item><guid>&amp;lt;key&amp;gt; &#38;</guid><title>&amp;lt;title&amp;gt; &#38;</title><link>https://example.com/?a=1&amp;b=&#38;</link><pubDate>&amp;lt;date&amp;gt; &#38;</pubDate></item></channel></rss>');
  const atom = parseXmlFeed('<feed><entry><id>&amp;lt;key&amp;gt; &#38;</id><title>&amp;lt;title&amp;gt; &#38;</title><link rel="alternate" href="https://example.com/?a=1&amp;b=&#38;"/><updated>&amp;lt;date&amp;gt; &#38;</updated></entry></feed>');
  const expected = [{ key: '<key> &#38;', title: '&lt;title&gt; &', url: 'https://example.com/?a=1&b=&#38;', publishedAt: '<date> &#38;' }];
  assert.deepEqual(rss, expected);
  assert.deepEqual(atom, expected);
});

test('title decoding keeps empty-title fallback and feed size/item caps', () => {
  assert.equal(parseXmlFeed(feedXml('rss', ''))[0]?.title, 'Untitled');
  assert.equal(parseXmlFeed(feedXml('atom', '   '))[0]?.title, 'Untitled');
  assert.throws(() => parseXmlFeed('x'.repeat(2_000_001)), /larger than 2 MB/);
  const item = '<item><guid>x</guid><title>&#38;</title><link>https://example.com/x</link></item>';
  assert.equal(parseXmlFeed(`<rss><channel>${item.repeat(200)}</channel></rss>`).length, 200);
  assert.throws(() => parseXmlFeed(`<rss><channel>${item.repeat(201)}</channel></rss>`), /too many items/);
});
