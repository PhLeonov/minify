'use strict';
const $ = id => document.getElementById(id);
const state = { photos: [], busy: false, cancelled: false, job: null, nextID: 1 };
const MAX_FILE = 64 * 1024 * 1024;
const MAX_QUEUE = 128 * 1024 * 1024;
let installPrompt = null;
const size = bytes => {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ']; let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < 2) { n /= 1024; i++; }
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[i]}`;
};
function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
function revoke(photo) { URL.revokeObjectURL(photo.preview); if (photo.result) URL.revokeObjectURL(photo.result.url); }
function setSummary(title, text, saved = 0) {
  $('summary-title').textContent = title; $('summary-text').textContent = text;
  $('savings').textContent = saved > 0 ? `−${size(saved)}` : '';
}
function canShare(files) {
  try { return !!navigator.canShare && !!navigator.share && navigator.canShare({ files }); }
  catch { return false; }
}
async function share(files) {
  try { await navigator.share({ files }); }
  catch (error) { if (error.name !== 'AbortError') message('Не удалось открыть меню сохранения. Используйте «Скачать» у фотографии.'); }
}
function render() {
  $('count').textContent = state.photos.length;
  $('total').textContent = state.photos.length ? `Общий размер: ${size(state.photos.reduce((n, p) => n + p.file.size, 0))}` : 'Файлы ещё не добавлены';
  for (const id of ['add', 'add-more', 'file-input', 'format', 'dimensions', 'quality']) $(id).disabled = state.busy;
  $('clear').disabled = state.busy || !state.photos.length;
  $('compress').disabled = state.busy || !state.photos.length;
  $('cancel').hidden = !state.busy;
  document.querySelectorAll('[data-quality]').forEach(button => { button.disabled = state.busy; });
  document.body.classList.toggle('busy', state.busy);
  const files = state.photos.filter(p => p.result).map(p => p.result.file);
  $('share-all').hidden = state.busy || !files.length || !canShare(files);
  $('save-note').hidden = !files.length;
  const list = $('list'); list.replaceChildren();
  if (!state.photos.length) {
    list.innerHTML = '<div class="empty"><span aria-hidden="true">▧</span><p>Здесь появятся ваши фотографии</p><small>Начните с пары любимых снимков</small></div>';
    return;
  }
  for (const photo of state.photos) {
    const row = document.createElement('div'); row.className = 'photo-row';
    const img = document.createElement('img'); img.src = photo.preview; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const details = document.createElement('div');
    const name = document.createElement('div'); name.className = 'photo-name'; name.textContent = photo.file.name; name.title = photo.file.name;
    const meta = document.createElement('div'); meta.className = 'photo-meta'; meta.textContent = size(photo.file.size);
    const status = document.createElement('div'); status.className = 'photo-status';
    if (photo.error) { status.textContent = photo.error; status.classList.add('error'); }
    else if (photo.result) {
      const r = photo.result;
      status.textContent = r.unchanged ? 'Уже компактно — исходный файл' : `${size(r.file.size)} · −${Math.round((1 - r.file.size / photo.file.size) * 100)}% · ${r.width} × ${r.height}`;
    } else { status.textContent = photo.processing ? 'Сжимаем…' : state.busy ? 'В очереди' : 'Готово к сжатию'; }
    details.append(name, meta, status);
    if (photo.result) {
      const actions = document.createElement('div'); actions.className = 'result-actions';
      const download = document.createElement('a'); download.href = photo.result.url; download.download = photo.result.file.name; download.textContent = 'Скачать ↓';
      actions.append(download);
      if (canShare([photo.result.file])) {
        const button = document.createElement('button'); button.textContent = 'Поделиться / сохранить';
        // File уже создан: вызов share остаётся непосредственно внутри жеста пользователя.
        button.onclick = () => share([photo.result.file]); actions.append(button);
      }
      details.append(actions);
    }
    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.disabled = state.busy;
    remove.setAttribute('aria-label', `Убрать ${photo.file.name}`);
    remove.onclick = () => {
      revoke(photo); state.photos = state.photos.filter(p => p.id !== photo.id);
      setSummary('Список обновлён', 'Готовые результаты можно сохранить, остальные фотографии — сжать.'); render();
    };
    row.append(img, details, remove); list.append(row);
  }
}
function addFiles(files) {
  if (state.busy) return;
  const errors = [];
  let bytes = state.photos.reduce((n, p) => n + p.file.size, 0);
  const keys = new Set(state.photos.map(p => p.key));
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (keys.has(key)) continue;
    if (!/\.(jpe?g|png)$/i.test(file.name) && !['image/jpeg', 'image/png'].includes(file.type)) { errors.push(`${file.name}: поддерживаются JPEG и PNG. Для HEIC сначала экспортируйте JPEG.`); continue; }
    if (file.size > MAX_FILE) { errors.push(`${file.name}: файл больше 64 МБ.`); continue; }
    if (state.photos.length >= 40 || bytes + file.size > MAX_QUEUE) { errors.push('Очередь заполнена: максимум 40 фотографий и 128 МБ. Обработайте их, сохраните результаты и очистите список.'); break; }
    state.photos.push({ id: state.nextID++, file, key, preview: URL.createObjectURL(file), result: null, error: '', processing: false });
    keys.add(key); bytes += file.size;
  }
  message(errors.join('\n')); render();
  if (state.photos.length) setSummary('Фотографии готовы к сжатию', 'Выберите настройки и нажмите «Сжать фотографии».');
}
for (const id of ['add', 'add-more']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = event => { addFiles(event.target.files); event.target.value = ''; };
for (const type of ['dragenter', 'dragover']) $('add').addEventListener(type, event => { event.preventDefault(); if (!state.busy) $('add').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('add').addEventListener(type, event => { event.preventDefault(); $('add').classList.remove('dragging'); if (type === 'drop') addFiles(event.dataTransfer.files); });
// Предотвращаем открытие перетащенной фотографии вместо приложения.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('clear').onclick = () => {
  state.photos.forEach(revoke); state.photos = []; message(); render();
  setSummary('Большие моменты. Маленькие файлы.', 'Добавьте фотографии, чтобы узнать, насколько меньше станут копии.');
};
function quality(value) {
  $('quality').value = value; $('quality-value').innerHTML = `${Number(value)}<span>%</span>`;
  document.querySelectorAll('[data-quality]').forEach(button => { const active = Number(button.dataset.quality) === Number(value); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}
$('quality').oninput = event => quality(event.target.value);
document.querySelectorAll('[data-quality]').forEach(button => { button.onclick = () => quality(button.dataset.quality); });
$('format').onchange = () => { $('format-note').textContent = $('format').value === 'jpeg' ? 'PNG тоже станут JPEG. Прозрачность заменяется белым фоном; сжатие с потерями.' : 'JPEG: сжатие с потерями. PNG: оптимизация без изменения пикселей при исходном разрешении.'; };
function runWorker(file, settings) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./worker.js');
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); worker.terminate(); state.job = null;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Обработка заняла слишком много времени. Попробуйте фотографию меньшего размера.')), 180000);
    state.job = { cancel: () => finish(new DOMException('Остановлено', 'AbortError')) };
    worker.onerror = () => finish(new Error('Модуль сжатия не запустился или телефону не хватило памяти. Попробуйте фото поменьше и повторно откройте приложение с интернетом.'));
    worker.onmessage = async ({ data }) => {
      if (data.type === 'ready') {
        try {
          const bytes = await file.arrayBuffer();
          if (!done) worker.postMessage({ type: 'compress', bytes, ...settings }, [bytes]);
        } catch (error) { finish(error); }
      } else if (data.type === 'error') finish(new Error(data.error));
      else if (data.type === 'result') finish(null, data);
    };
  });
}
$('compress').onclick = async () => {
  if (state.busy || !state.photos.length) return;
  state.busy = true; state.cancelled = false; message();
  for (const p of state.photos) { if (p.result) URL.revokeObjectURL(p.result.url); p.result = null; p.error = ''; }
  const settings = { quality: Number($('quality').value), format: $('format').value, maxDimension: Number($('dimensions').value) };
  $('progress-track').hidden = false; $('progress-bar').style.width = '0%'; $('progress-track').setAttribute('aria-valuenow', '0');
  let completed = 0;
  try {
    for (const photo of state.photos) {
      if (state.cancelled) break;
      photo.processing = true; render();
      setSummary(`Сжимаем ${completed + 1} из ${state.photos.length}`, 'Оставьте приложение открытым. Фотографии не покидают устройство.');
      try {
        const r = await runWorker(photo.file, settings);
        const ext = r.format === 'jpeg' ? '.jpg' : '.png';
        const name = r.unchanged ? photo.file.name : `${photo.file.name.replace(/\.[^.]+$/, '')}-min${ext}`;
        const file = new File([r.data], name, { type: r.format === 'jpeg' ? 'image/jpeg' : 'image/png' });
        photo.result = { file, url: URL.createObjectURL(file), width: r.width, height: r.height, unchanged: r.unchanged };
      } catch (error) {
        if (error.name === 'AbortError') break;
        photo.error = error.message || String(error);
      } finally { photo.processing = false; }
      completed++;
      const pct = Math.round(completed / state.photos.length * 100);
      $('progress-bar').style.width = `${pct}%`; $('progress-track').setAttribute('aria-valuenow', String(pct));
      render();
    }
  } finally {
    state.busy = false; state.job = null; $('progress-track').hidden = true; render();
    const success = state.photos.filter(p => p.result);
    const failed = state.photos.filter(p => p.error).length;
    const saved = success.reduce((n, p) => n + p.file.size - p.result.file.size, 0);
    setSummary(state.cancelled ? 'Обработка остановлена' : failed ? 'Обработка завершена с ошибками' : 'Готово! Сохраните результаты', `Готово: ${success.length} из ${state.photos.length}.${failed ? ` Ошибок: ${failed}.` : ''} ${saved ? 'Сжатые копии занимают меньше места.' : 'Дополнительной экономии нет.'}`, saved);
  }
};
$('cancel').onclick = () => { state.cancelled = true; state.job?.cancel(); };
$('share-all').onclick = () => share(state.photos.filter(p => p.result).map(p => p.result.file));
window.addEventListener('beforeunload', event => {
  if (state.busy || state.photos.some(p => p.result)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
$('install').onclick = async () => {
  if (installPrompt) { await installPrompt.prompt(); installPrompt = null; }
  else $('install-dialog').showModal();
};
for (const id of ['close-install', 'install-done']) $(id).onclick = () => $('install-dialog').close();
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('install').hidden = true;
async function offline() {
  if (!('serviceWorker' in navigator) || !isSecureContext) { $('offline-status').textContent = 'Офлайн-режим требует HTTPS (или localhost).'; return; }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) $('offline-status').textContent = 'Обновление готово — закройте все окна Minify и откройте снова.';
        if (worker.state === 'redundant') $('offline-status').textContent = 'Офлайн-кеш не обновлён. Повторите с интернетом.';
      });
    });
    // ready означает активацию Worker, но он ещё может не контролировать
    // текущую вкладку. Показываем готовность только после clients.claim().
    let timeout;
    const prepared = async () => {
      const ready = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      return ready;
    };
    let ready;
    try { ready = await Promise.race([prepared(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 60000); })]); }
    finally { clearTimeout(timeout); }
    $('offline-status').textContent = ready.waiting ? 'Обновление готово — закройте все окна Minify.' : '✓ Готово к работе офлайн';
  } catch { $('offline-status').textContent = 'Офлайн-режим пока недоступен. Проверьте интернет и откройте приложение снова.'; }
}
render(); offline();
