// Сборка PWA: node scripts/build-web.cjs. Нужны только Go и Node.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'web');
fs.mkdirSync(output, { recursive: true });
const files = [];
function copy(dir, relative = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) copy(path.join(dir, entry.name), name);
    else { fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true }); fs.copyFileSync(path.join(dir, entry.name), path.join(output, name)); files.push(name); }
  }
}
copy(path.join(root, 'web'));
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(output, 'minify.wasm'), './cmd/wasm'], { cwd: root, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' }, stdio: 'inherit' });
const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: root, encoding: 'utf8' }).trim();
fs.copyFileSync(path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'), path.join(output, 'wasm_exec.js'));
files.push('minify.wasm', 'wasm_exec.js');

// CRC32 используется форматами PNG и ZIP. Никакие сетевые сервисы для иконок не нужны.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type); const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8); return result;
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bars = [[25,35,34,67],[34,32,45,41],[43,35,52,67],[52,32,63,41],[61,35,70,67],[73,59,81,67]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ink = bars.some(([x1,y1,x2,y2]) => x >= x1 * size / 100 && x < x2 * size / 100 && y >= y1 * size / 100 && y < y2 * size / 100);
    const i = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(ink ? [209,238,163,255] : [29,66,47,255], i);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.mkdirSync(path.join(output, 'icons'), { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(output, 'icons', name), icon(size)); files.push(`icons/${name}`);
}
files.sort();
const hash = crypto.createHash('sha256');
for (const name of files) { hash.update(name); hash.update(fs.readFileSync(path.join(output, name))); }
const version = hash.digest('hex').slice(0, 16);
const swPath = path.join(output, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replaceAll('__BUILD_VERSION__', version));

// ZIP собираем только из файлов текущей сборки, без случайных старых артефактов.
const local = [], central = []; let offset = 0;
for (const name of files) {
  const bytes = fs.readFileSync(path.join(output, name));
  const packed = zlib.deflateRawSync(bytes); const filename = Buffer.from(name); const crc = crc32(bytes);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
  const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(8, 10); index.writeUInt16LE(33, 14);
  index.writeUInt32LE(crc, 16); index.writeUInt32LE(packed.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42);
  local.push(header, filename, packed); central.push(index, filename); offset += header.length + filename.length + packed.length;
}
const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
fs.writeFileSync(path.join(root, 'build', 'minify-pwa.zip'), Buffer.concat([...local, centralBytes, end]));
console.log(`PWA: ${output}\nZIP: build/minify-pwa.zip\nВерсия кеша: ${version}`);
