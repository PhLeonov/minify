package compress

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// fixture создаёт тестовое изображение вместо использования личных фотографий.
// Фиксированное зерно генератора делает пиксели одинаковыми при каждом запуске.
// t.TempDir создаёт отдельную папку, которую Go удалит после завершения теста.
func fixture(t *testing.T, format string) (string, []byte) {
	// Helper указывает Go показывать место вызова помощника при сообщении об ошибке.
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 320, 240))
	rng := rand.New(rand.NewSource(42))
	for y := 0; y < 240; y++ {
		for x := 0; x < 320; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), uint8(rng.Intn(256)), 255})
		}
	}
	var b bytes.Buffer
	var err error
	if format == "jpg" {
		err = jpeg.Encode(&b, img, &jpeg.Options{Quality: 100})
	} else {
		err = png.Encode(&b, img)
	}
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "фото."+format)
	if err := os.WriteFile(path, b.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	return path, b.Bytes()
}

// Проверяем экономию места, неизменность исходника и разрешения,
// а также создание другого имени при повторном сжатии.
func TestJPEGCompressionPreservesOriginalAndDimensions(t *testing.T) {
	path, before := fixture(t, "jpg")
	s := Settings{Quality: 75, Format: "original"}
	r, err := Process(context.Background(), path, s)
	if err != nil {
		t.Fatal(err)
	}
	if r.OutputSize >= r.OriginalSize || r.Unchanged {
		t.Fatalf("expected savings: %+v", r)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("original was changed")
	}
	b, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width != 320 || cfg.Height != 240 {
		t.Fatalf("unexpected dimensions: %+v, %v", cfg, err)
	}
	r2, err := Process(context.Background(), path, s)
	if err != nil {
		t.Fatal(err)
	}
	if r2.OutputPath == r.OutputPath {
		t.Fatal("existing output overwritten")
	}
	t.Logf("JPEG: %d → %d bytes", r.OriginalSize, r.OutputSize)
}

// Проверяем одновременно переход PNG → JPEG и сохранение пропорций: 320×240 → 160×120.
func TestResizeAndConvert(t *testing.T) {
	path, _ := fixture(t, "png")
	r, err := Process(context.Background(), path, Settings{Quality: 70, Format: "jpeg", MaxDimension: 160, OutputDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || format != "jpeg" || cfg.Width != 160 || cfg.Height != 120 {
		t.Fatalf("bad conversion: %+v %s %v", cfg, format, err)
	}
}

// Сравниваем все пиксели PNG, включая полупрозрачный: экономия не должна менять цвета.
func TestPNGPreservesAlphaAndPixels(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	img.SetNRGBA(10, 10, color.NRGBA{R: 200, G: 30, B: 50, A: 100})
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.NoCompression}
	if err := enc.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "alpha.png")
	if err := os.WriteFile(path, b.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	r, err := Process(context.Background(), path, Settings{Quality: 80, Format: "original"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	got, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			wantColor := color.NRGBAModel.Convert(img.At(x, y))
			gotColor := color.NRGBAModel.Convert(got.At(x, y))
			if gotColor != wantColor {
				t.Fatalf("pixel changed at %d,%d: %v != %v", x, y, gotColor, wantColor)
			}
		}
	}
}

// Для крошечного PNG JPEG оказывается больше. Ожидаем точную копию PNG,
// а не увеличенный файл и не JPEG под неправильным расширением.
func TestLargerResultFallsBackToExactOriginal(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "small.png")
	if err := os.WriteFile(path, b.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	r, err := Process(context.Background(), path, Settings{Quality: 100, Format: "jpeg"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Unchanged || !bytes.Equal(got, b.Bytes()) || filepath.Ext(r.OutputPath) != ".png" {
		t.Fatal("fallback did not preserve original bytes and extension")
	}
}

// Значения каналов выбраны так, чтобы переход к 8 битам потерял точность.
// Сравнение обнаружит такое нежелательное преобразование.
func TestPNG16BitPreserved(t *testing.T) {
	img := image.NewNRGBA64(image.Rect(0, 0, 20, 20))
	img.SetNRGBA64(4, 5, color.NRGBA64{R: 12345, G: 54321, B: 11111, A: 33333})
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.NoCompression}
	if err := enc.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "16bit.png")
	if err := os.WriteFile(path, b.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	r, err := Process(context.Background(), path, Settings{Quality: 80, Format: "original"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	got, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if color.NRGBA64Model.Convert(got.At(4, 5)) != img.NRGBA64At(4, 5) {
		t.Fatal("16-bit pixel changed")
	}
}

// Заранее отменённая задача не должна создавать папку результата.
// Также проверяем отклонение неверного качества и файла, который не является фото.
func TestCancellationAndInvalidInputCreateNoOutput(t *testing.T) {
	path, _ := fixture(t, "jpg")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Process(ctx, path, Settings{Quality: 80, Format: "original"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "Minify")); !os.IsNotExist(err) {
		t.Fatal("cancelled job created output directory")
	}
	if _, err := Process(context.Background(), path, Settings{Quality: 101, Format: "original"}); err == nil {
		t.Fatal("invalid quality accepted")
	}
	bad := filepath.Join(t.TempDir(), "invalid.jpg")
	if err := os.WriteFile(bad, []byte("not an image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(bad); err == nil {
		t.Fatal("invalid image accepted")
	}
}

// Проверяем, что и превью, и результат учитывают поворот из EXIF.
func TestEXIFOrientation(t *testing.T) {
	path, data := fixture(t, "jpg")
	// Вставляем в JPEG блок APP1 с EXIF: TIFF с младшим байтом вперёд,
	// orientation=6 означает поворот на 90° по часовой стрелке.
	payload := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	// Первые два байта JPEG — маркер начала. После него добавляем EXIF,
	// затем оставшуюся часть файла; «...» передаёт в append все байты среза.
	withExif := append([]byte{}, data[:2]...)
	withExif = append(withExif, 0xff, 0xe1, 0, byte(len(payload)+2))
	withExif = append(withExif, payload...)
	withExif = append(withExif, data[2:]...)
	if err := os.WriteFile(path, withExif, 0644); err != nil {
		t.Fatal(err)
	}
	p, err := Inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 240 || p.Height != 320 {
		t.Fatalf("preview ignores EXIF: %+v", p)
	}
	r, err := Process(context.Background(), path, Settings{Quality: 75, Format: "original"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(r.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width != 240 || cfg.Height != 320 {
		t.Fatalf("output ignores EXIF: %+v %v", cfg, err)
	}
}
