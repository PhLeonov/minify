const $ = (id) => document.getElementById(id);
const state = { photos: [], results: new Map(), busy: false, outputDir: '' };
const api = () => window.go?.main?.App;
const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < 2) { value /= 1024; index++; }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[index]}`;
};
function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
function render() {
  $('count').textContent = state.photos.length;
  $('total-size').textContent = state.photos.length ? `Общий размер: ${formatSize(state.photos.reduce((sum, p) => sum + p.size, 0))}` : 'Файлы ещё не добавлены';
  $('clear').disabled = state.busy || !state.photos.length;
  $('compress').disabled = state.busy || !state.photos.length;
  for (const id of ['add-area', 'add-more', 'format', 'dimensions', 'quality', 'choose-folder', 'reset-folder']) $(id).disabled = state.busy;
  document.querySelectorAll('[data-quality]').forEach(el => { el.disabled = state.busy; });
  document.body.classList.toggle('busy', state.busy);
  const list = $('photo-list');
  list.replaceChildren();
  if (!state.photos.length) {
    list.innerHTML = '<div class="empty"><span>▧</span><p>Здесь появятся ваши фотографии</p><small>Можно выбрать несколько файлов сразу</small></div>';
    return;
  }
  for (const photo of state.photos) {
    const row = document.createElement('div'); row.className = 'photo-row';
    const img = document.createElement('img'); img.src = photo.thumbnail; img.alt = '';
    const details = document.createElement('div'); details.className = 'photo-details';
    const name = document.createElement('div'); name.className = 'photo-name'; name.textContent = photo.name; name.title = photo.path;
    const meta = document.createElement('div'); meta.className = 'photo-meta'; meta.textContent = `${photo.width} × ${photo.height} · ${formatSize(photo.size)}`;
    details.append(name, meta);
    const result = state.results.get(photo.path);
    const status = document.createElement('div'); status.className = 'photo-result';
    if (result?.error) { status.textContent = 'Ошибка'; status.title = result.error; status.classList.add('error'); }
    else if (result) {
      status.textContent = result.unchanged ? 'Уже компактно' : `${formatSize(result.outputSize)} · −${Math.round((1 - result.outputSize / result.originalSize) * 100)}%`;
      status.title = result.outputPath;
    } else { status.textContent = state.busy ? 'В очереди' : 'Готово к сжатию'; }
    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать ${photo.name}`); remove.disabled = state.busy;
    remove.onclick = () => { state.photos = state.photos.filter(p => p.path !== photo.path); state.results.delete(photo.path); render(); resetSummary(); };
    row.append(img, details, status, remove); list.append(row);
  }
}
function resetSummary() {
  $('open-results').hidden = true;
  $('summary-title').textContent = 'Большие моменты. Маленькие файлы.';
  $('summary-text').textContent = 'Добавьте фотографии — и узнайте, сколько места можно освободить.';
  $('savings').textContent = ''; $('progress-track').hidden = true;
}
async function selectPhotos() {
  if (state.busy) return;
  if (!api()) { message('Выбор файлов доступен в desktop-приложении Minify.exe.'); return; }
  state.busy = true; render(); message();
  try {
    const selection = await api().SelectPhotos();
    const existing = new Set(state.photos.map(p => p.path.toLowerCase()));
    for (const photo of selection.photos || []) {
      const key = photo.path.toLowerCase();
      if (!existing.has(key)) { state.photos.push(photo); existing.add(key); }
    }
    if (selection.errors?.length) message(selection.errors.join('\n'));
  } catch (error) { message(String(error)); }
  finally { state.busy = false; render(); }
}
function setQuality(value) {
  $('quality').value = value;
  $('quality-value').innerHTML = `${Number(value)}<span>%</span>`;
  document.querySelectorAll('[data-quality]').forEach(el => el.classList.toggle('active', Number(el.dataset.quality) === Number(value)));
}
$('add-area').onclick = selectPhotos;
$('add-more').onclick = selectPhotos;
$('clear').onclick = () => { state.photos = []; state.results.clear(); message(); render(); resetSummary(); };
$('quality').oninput = e => setQuality(e.target.value);
document.querySelectorAll('[data-quality]').forEach(el => el.onclick = () => setQuality(el.dataset.quality));
$('format').onchange = () => {
  $('format-note').textContent = $('format').value === 'jpeg' ? 'PNG тоже станут JPEG. Прозрачные области получат белый фон.' : 'JPEG: сжатие с потерями. PNG: оптимизация без потери пикселей.';
};
$('choose-folder').onclick = async () => {
  if (!api()) return;
  try {
    const path = await api().SelectOutputDirectory();
    if (path) { state.outputDir = path; $('folder-label').textContent = path; $('folder-label').title = path; $('reset-folder').hidden = false; }
  } catch (error) { message(String(error)); }
};
$('reset-folder').onclick = () => { state.outputDir = ''; $('folder-label').textContent = 'Папка Minify рядом с оригиналом'; $('folder-label').title = ''; $('reset-folder').hidden = true; };
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  try { await api().Cancel(); } catch (error) { message(String(error)); }
};
function progress(event) {
  if (!state.busy) return;
  state.results.set(event.result.path, event.result);
  $('summary-title').textContent = `Обработано ${event.completed} из ${event.total}`;
  $('progress-bar').style.width = `${event.completed / event.total * 100}%`;
  render();
}
if (window.runtime?.EventsOn) window.runtime.EventsOn('compression:progress', progress);
$('compress').onclick = async () => {
  if (state.busy || !state.photos.length || !api()) return;
  state.busy = true; state.results.clear(); message(); render();
  $('open-results').hidden = true;
  $('cancel').hidden = false; $('cancel').disabled = false;
  $('summary-title').textContent = 'Сжимаем фотографии…';
  $('summary-text').textContent = 'Можно остановить обработку. Готовые файлы сохранятся.';
  $('savings').textContent = ''; $('progress-track').hidden = false; $('progress-bar').style.width = '0%';
  try {
    const batch = await api().Compress(state.photos.map(p => p.path), { quality: Number($('quality').value), format: $('format').value, maxDimension: Number($('dimensions').value), outputDir: state.outputDir });
    state.results = new Map(batch.results.map(r => [r.path, r]));
    const success = batch.results.filter(r => !r.error);
    const failed = batch.results.filter(r => r.error);
    const saved = success.reduce((sum, r) => sum + r.originalSize - r.outputSize, 0);
    if (success.length) {
      $('open-results').hidden = false;
      $('open-results').onclick = async () => {
        try { await api().OpenResultFolder(success[0].outputPath); } catch (error) { message(String(error)); }
      };
      $('open-results').title = 'Открыть папку первого сохранённого файла';
    }
    const unchanged = success.filter(r => r.unchanged).length;
    $('summary-title').textContent = batch.cancelled ? 'Обработка остановлена' : failed.length ? 'Обработка завершена с ошибками' : 'Готово! Фотографии сохранены';
    $('summary-text').textContent = `Сохранено: ${success.length} из ${state.photos.length}. ${saved ? `Освобождено ${formatSize(saved)}.` : 'Дополнительной экономии нет.'}${unchanged ? ` Уже компактных: ${unchanged} — скопированы без изменений.` : ''}`;
    $('summary-text').title = success.map(r => r.outputPath).join('\n');
    $('savings').textContent = saved ? `−${formatSize(saved)}` : '';
    if (failed.length) message(failed.map(r => `${state.photos.find(p => p.path === r.path)?.name}: ${r.error}`).join('\n'));
  } catch (error) { message(String(error)); $('summary-title').textContent = 'Не удалось завершить обработку'; $('summary-text').textContent = 'Проверьте сообщение об ошибке и попробуйте снова.'; }
  finally { state.busy = false; $('cancel').hidden = true; $('progress-track').hidden = true; render(); }
};
render();
