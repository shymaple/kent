/**
 * The description sanitiser.
 *
 * Descriptions are written into the page as HTML, and a description can begin
 * as text derived from someone else's Slack message, so every case here is a
 * way markup has actually been used to run script - plus the formatting the
 * editor really produces, which has to come through intact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, linksInHtml, sanitizeHtml } from './richtext.js';

test('the formatting the editor produces survives', () => {
  const html = '<div>Ship <b>today</b>, <i>not</i> tomorrow</div><ul><li>draft</li><li>send</li></ul>';
  assert.equal(sanitizeHtml(html), html);
});

test('a link keeps its address and is made safe to open', () => {
  assert.equal(
    sanitizeHtml('<a href="https://docs.google.com/document/d/abc?x=1&amp;y=2">the doc</a>'),
    '<a href="https://docs.google.com/document/d/abc?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">the doc</a>'
  );
});

const ATTACKS = [
  ['a script element', '<script>alert(1)</script>hello'],
  ['an unterminated script element', 'hello<script>alert(1)'],
  ['an event handler on an allowed tag', '<b onclick="alert(1)">hello</b>'],
  ['an image with an error handler', '<img src=x onerror=alert(1)>hello'],
  ['a javascript: link', '<a href="javascript:alert(1)">hello</a>'],
  ['a javascript: link hidden behind entities', '<a href="&#106;avascript:alert(1)">hello</a>'],
  ['a data: link', '<a href="data:text/html,<script>alert(1)</script>">hello</a>'],
  ['an inline style', '<p style="background:url(javascript:alert(1))">hello</p>'],
  ['an iframe', '<iframe src="https://evil.example"></iframe>hello'],
  ['an svg with an onload', '<svg onload=alert(1)>hello</svg>'],
  ['a tag split to dodge a filter', '<scr<script>ipt>alert(1)</scr</script>ipt>hello'],
  ['an attribute that tries to close the tag early', '<a href="https://ok.example" title="><img src=x onerror=alert(1)>">hello</a>'],
  ['a comment hiding markup', '<!-- <script>alert(1)</script> -->hello'],
];

for (const [name, input] of ATTACKS) {
  test(`${name} cannot get through`, () => {
    const out = sanitizeHtml(input) ?? '';
    assert.ok(!/<script|<img|<svg|<iframe|<style/i.test(out), `dangerous tag survived: ${out}`);
    assert.ok(!/javascript:|data:text/i.test(out.replace(/&[a-z]+;/g, '')) || !/<a /.test(out), `dangerous link survived: ${out}`);
    // No attribute of any kind except the ones this module writes itself.
    for (const tag of out.match(/<[^>]+>/g) ?? []) {
      assert.match(tag, /^<\/?[a-z]+>$|^<a href="(https?:|mailto:)[^"]*" target="_blank" rel="noreferrer noopener">$/, `unexpected tag: ${tag}`);
    }
    assert.match(htmlToText(out), /hello/, 'the visible text is kept');
  });
}

test('a stray angle bracket is shown as text, not read as markup', () => {
  assert.equal(sanitizeHtml('if a < b then ship'), 'if a &lt; b then ship');
});

test('markup with nothing visible in it is no description at all', () => {
  assert.equal(sanitizeHtml('<div><br></div>'), null);
  assert.equal(sanitizeHtml('   '), null);
  assert.equal(sanitizeHtml(null), null);
});

test('an unclosed link is closed rather than swallowing the rest', () => {
  assert.equal(
    sanitizeHtml('<a href="https://a.example">open'),
    '<a href="https://a.example/" target="_blank" rel="noreferrer noopener">open</a>'
  );
});

test('the plain rendering keeps lists and paragraphs readable', () => {
  assert.equal(
    htmlToText('<div>Steps &amp; notes:</div><ul><li>draft</li><li>send <b>today</b></li></ul><div>Thanks</div>'),
    'Steps & notes:\n\n- draft\n- send today\nThanks'
  );
});

test('links are found with the text they were given', () => {
  const html = sanitizeHtml('See <a href="https://figma.com/file/x">the mock</a> and <a href="https://a.example/">https://a.example/</a>');
  assert.deepEqual(linksInHtml(html), [
    { url: 'https://figma.com/file/x', label: 'the mock' },
    { url: 'https://a.example/', label: null },
  ]);
});
