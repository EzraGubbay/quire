// Generates PWA icons: oxblood rounded square with a "Q" monogram. Re-run after design changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

mkdirSync('public/icons', { recursive: true });
for (const [size, name, maskable] of [
  [192, 'icon-192.png', false],
  [512, 'icon-512.png', false],
  [512, 'icon-512-maskable.png', true],
  [180, 'apple-touch-icon.png', false],
]) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6E1E2B';
  if (maskable) ctx.fillRect(0, 0, size, size);
  else {
    const r = size * 0.22;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fill();
  }
  ctx.fillStyle = '#F6F1E7';
  ctx.font = `600 ${Math.round(size * 0.58)}px "Georgia", "Times New Roman", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Q', size / 2, size / 2 + size * 0.03);
  writeFileSync(`public/icons/${name}`, c.toBuffer('image/png'));
}
console.log('icons written');
