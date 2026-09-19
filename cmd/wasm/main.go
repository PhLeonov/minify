//go:build js && wasm

// Эта программа компилируется в WebAssembly и работает в Web Worker браузера.
// Она использует то же ядро сжатия, что и desktop-приложение.
package main

import (
	"bytes"
	"context"
	"image"
	"syscall/js"

	"minify/internal/compress"
)

// encode получает Uint8Array из JavaScript и возвращает объект с байтами результата.
// Вызов синхронный, но выполняется в Worker, поэтому не блокирует экран приложения.
func encode(this js.Value, args []js.Value) interface{} {
	if len(args) != 4 {
		return map[string]interface{}{"error": "неверные параметры сжатия"}
	}
	input := args[0]
	if input.Get("byteLength").Int() > 64<<20 {
		return map[string]interface{}{"error": "для браузера выберите файл до 64 МБ"}
	}
	data := make([]byte, input.Get("byteLength").Int())
	js.CopyBytesToGo(data, input)
	// Мобильный браузер имеет ограниченную память. Проверяем заголовок
	// до выделения больших массивов пикселей, а файлы обрабатываем по одному.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return map[string]interface{}{"error": "не удалось прочитать JPEG/PNG; HEIC и другие форматы пока не поддерживаются"}
	}
	if int64(cfg.Width)*int64(cfg.Height) > 24_000_000 {
		return map[string]interface{}{"error": "для мобильной версии выберите фото до 24 Мп"}
	}
	result, err := compress.Encode(context.Background(), data, compress.Settings{
		Quality: args[1].Int(), Format: args[2].String(), MaxDimension: args[3].Int(),
	})
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	output := js.Global().Get("Uint8Array").New(len(result.Data))
	js.CopyBytesToJS(output, result.Data)
	return map[string]interface{}{
		"data": output, "format": result.Format, "width": result.Width,
		"height": result.Height, "unchanged": result.Unchanged,
	}
}

func main() {
	// Сохраняем функцию на всё время жизни Worker. Worker завершает JS-код
	// при отмене или после файла, освобождая вместе с ним память Go.
	callback := js.FuncOf(encode)
	js.Global().Set("minifyEncode", callback)
	js.Global().Call("postMessage", map[string]interface{}{"type": "ready"})
	select {}
}
