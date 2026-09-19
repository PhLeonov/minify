// Каждый файл получает отдельный Worker: память Go освобождается после результата.
importScripts('./wasm_exec.js');
const go = new Go();
(async () => {
  try {
    const response = await fetch('./minify.wasm');
    if (!response.ok) throw new Error('Не удалось загрузить модуль сжатия. Откройте приложение с интернетом ещё раз.');
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    go.run(instance).catch(error => postMessage({ type: 'error', error: String(error) }));
  } catch (error) { postMessage({ type: 'error', error: String(error) }); }
})();
self.onmessage = ({ data }) => {
  if (data.type !== 'compress') return;
  try {
    const result = self.minifyEncode(new Uint8Array(data.bytes), data.quality, data.format, data.maxDimension);
    if (result.error) postMessage({ type: 'error', error: result.error });
    else postMessage({ type: 'result', ...result }, [result.data.buffer]);
  } catch (error) { postMessage({ type: 'error', error: String(error) }); }
};
