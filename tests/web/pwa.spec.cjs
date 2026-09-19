const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

// Создаём только синтетические изображения: личные фотографии для тестов не нужны.
async function fixture(page, type = 'image/jpeg', width = 320, height = 240) {
  const base64 = await page.evaluate(({ type, width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height); let seed = 42;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      image.data[i] = seed & 255; image.data[i + 1] = (seed >>> 8) & 255; image.data[i + 2] = (seed >>> 16) & 255; image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL(type, 1).split(',')[1];
  }, { type, width, height });
  return { name: type === 'image/jpeg' ? 'фото.jpg' : 'фото.png', mimeType: type, buffer: Buffer.from(base64, 'base64') };
}
test.beforeEach(async ({ page }) => { await page.goto('./'); });

test('mobile layout, real Go compression, download, no photo uploads', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = []; page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  const file = await fixture(page);
  await page.locator('#file-input').setInputFiles(file);
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await expect(page.locator('#summary-title')).toHaveText('Готово! Сохраните результаты');
  await expect(page.locator('.photo-status')).toContainText('320 × 240');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('фото-min.jpg');
  const bytes = await fs.readFile(await download.path());
  expect(bytes.length).toBeLessThan(file.buffer.length);
  expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // blob: — локальная память, edge: — встроенный экран загрузок браузера.
  // Проверяем именно сетевые запросы, а не эти внутренние ресурсы.
  expect(requests.filter(r => /^https?:/.test(r.url)).every(r => r.method === 'GET' && r.url.startsWith('http://localhost:4179/'))).toBe(true);
  expect(errors).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
});

test('offline cold page reload can start a fresh Go worker under a repository path', async ({ page }) => {
  // Реально выключаем отдельный сервер после кеширования, а не полагаемся
  // на эмуляцию сети: setOffline в WebKit на Windows ломает навигацию с SW.
  const server = spawn(process.execPath, ['scripts/serve-web.cjs'], { env: { ...process.env, MINIFY_PORT: '4180', MINIFY_BASE: '/minify/' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Preview exited: ${code}`))); });
    await page.goto('http://localhost:4180/minify/');
    await expect(page.locator('#offline-status')).toContainText('Готово к работе офлайн', { timeout: 60000 });
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const file = await fixture(page);
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    await page.reload();
    await page.locator('#file-input').setInputFiles(file);
    await page.getByRole('button', { name: 'Сжать фотографии' }).click();
    await expect(page.locator('#summary-title')).toHaveText('Готово! Сохраните результаты');
    await expect(page.locator('.photo-status')).toContainText('320 × 240');
    await expect(page.getByRole('link', { name: 'Скачать' })).toBeVisible();
  } finally { if (server.exitCode === null && !server.killed) server.kill(); }
});

test('invalid image is reported without preventing later files from compressing', async ({ page }) => {
  const good = await fixture(page);
  await page.locator('#file-input').setInputFiles([{ name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') }, good]);
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await expect(page.locator('#summary-title')).toHaveText('Обработка завершена с ошибками');
  await expect(page.locator('.photo-status.error')).toContainText('не удалось прочитать');
  await expect(page.getByRole('link', { name: 'Скачать' })).toHaveCount(1);
});

test('cancellation terminates a worker and a new batch can run', async ({ page }) => {
  await page.locator('#file-input').setInputFiles(await fixture(page, 'image/jpeg', 1200, 900));
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await page.getByRole('button', { name: 'Остановить сжатие' }).click();
  await expect(page.locator('#summary-title')).toHaveText('Обработка остановлена');
  await expect(page.getByRole('button', { name: 'Сжать фотографии' })).toBeEnabled();
  await page.locator('#dimensions').selectOption('1280');
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await expect(page.locator('#summary-title')).toHaveText('Готово! Сохраните результаты');
});

test('PNG to JPEG conversion resizes and replaces transparency with white', async ({ page }) => {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1500; canvas.height = 1000;
    const c = canvas.getContext('2d'); c.fillStyle = '#b74242'; c.fillRect(750, 0, 750, 1000);
    // Uncompressed-ish noisy region ensures JPEG is smaller than PNG.
    const pixels = c.getImageData(750, 0, 750, 1000); let seed = 1;
    for (let i = 0; i < pixels.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255; pixels.data[i + 2] = (seed >>> 16) & 255; }
    c.putImageData(pixels, 750, 0); return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#file-input').setInputFiles({ name: 'alpha.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  await page.locator('#format').selectOption('jpeg'); await page.locator('#dimensions').selectOption('1280');
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await expect(page.locator('#summary-title')).toHaveText('Готово! Сохраните результаты');
  const pixel = await page.evaluate(async () => {
    const img = new Image(); img.src = document.querySelector('.result-actions a').href; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const context = c.getContext('2d'); context.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, rgba: [...context.getImageData(20, 20, 1, 1).data] };
  });
  expect(pixel.width).toBe(1280); expect(pixel.height).toBe(853); expect(pixel.rgba).toEqual([255, 255, 255, 255]);
});

test('larger conversion returns exact original; install help and desktop layout', async ({ page }, info) => {
  const base64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL().split(',')[1]; });
  const original = Buffer.from(base64, 'base64');
  await page.locator('#file-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: original });
  await page.locator('#format').selectOption('jpeg');
  await page.getByRole('button', { name: 'Сжать фотографии' }).click();
  await expect(page.locator('.photo-status')).toHaveText('Уже компактно — исходный файл');
  const promise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Скачать' }).click();
  const download = await promise; expect(download.suggestedFilename()).toBe('tiny.png');
  expect(await fs.readFile(await download.path())).toEqual(original);
  // Don't depend on platform-specific browser install promotion in headless mode.
  await page.evaluate(() => { installPrompt = null; });
  await page.locator('#install').click(); await expect(page.getByRole('dialog')).toContainText('На экран Домой');
  await page.getByRole('button', { name: 'Понятно' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
});
