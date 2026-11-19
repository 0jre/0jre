import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { palettes, parseTheme } from './palette';

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
for (const [mode, c] of Object.entries(palettes)) {
  test(`${mode}: semantic text stays readable on theme surfaces`, () => {
    for (const surface of [c.bg, c.card, c.raised]) {
      for (const foreground of [c.ink, c.muted, c.green, c.red]) assert.ok(contrast(foreground, surface) >= 4.5, `${foreground} on ${surface}`);
    }
    assert.ok(contrast(c.onBrand, c.brand) >= 4.5, 'primary label contrast');
    assert.ok(contrast(c.green, c.positiveTint) >= 4.5);
    assert.ok(contrast(c.red, c.negativeTint) >= 4.5);
  });
}
test('persisted theme accepts only light or dark', () => {
  assert.equal(parseTheme('light'), 'light'); assert.equal(parseTheme('dark'), 'dark');
  for (const value of [null, '', 'system', '{}']) assert.equal(parseTheme(value), null);
});
test('native adapter remains DOM-free and web uses official registry components', () => {
  const native = readFileSync(new URL('./tuff.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(native, /tuffui\/|\.css|react-dom/);
  const web = readFileSync(new URL('./tuff.web.tsx', import.meta.url), 'utf8');
  assert.match(web, /from '.\/tuffui\/action-button'/); assert.match(web, /from '.\/tuffui\/status-pill'/);
  const css = readFileSync(new URL('./tuffui.css', import.meta.url), 'utf8');
  for (const [mode, c] of Object.entries(palettes)) {
    const section = mode === 'light' ? css.split(':root {')[1].split('.dark {')[0] : css.split('.dark {')[1].split('@theme')[0];
    for (const [token, value] of Object.entries({ background:c.bg, foreground:c.ink, brand:c.brand, positive:c.green, negative:c.red })) assert.ok(section.includes(`--${token}: ${value}`));
  }
});
