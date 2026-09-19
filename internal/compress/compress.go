// Package compress читает, проверяет и сжимает фотографии.
// Он не зависит от Wails: обработку можно использовать в консольной программе
// или проверять тестами без запуска графического интерфейса.
package compress

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/disintegration/imaging"
)

// Лимиты проверяются до полного декодирования: изображение в оперативной памяти
// может занимать намного больше места, чем сжатый файл на диске.
const maxPixels = 60_000_000
const maxFileBytes = 256 << 20 // Сдвиг на 20 бит: 256 × 2^20 байт, то есть 256 МиБ.

// Photo — описание исходника для интерфейса. Size измеряется в байтах,
// Width и Height — в пикселях с учётом поворота, Thumbnail — строка с миниатюрой.
type Photo struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Thumbnail string `json:"thumbnail"`
}

// Settings управляет обработкой одной фотографии или целой очереди.
type Settings struct {
	Quality      int    `json:"quality"`      // Качество JPEG: 1–100; не влияет на PNG.
	Format       string `json:"format"`       // "original" сохраняет формат, "jpeg" преобразует в JPEG.
	MaxDimension int    `json:"maxDimension"` // Максимум длинной стороны; 0 сохраняет разрешение.
	OutputDir    string `json:"outputDir"`    // Пустая строка означает подпапку Minify рядом с исходником.
}

// Result описывает сохранённый файл. Размеры в байтах позволяют вычислить экономию.
// Unchanged означает копирование исходных байтов, если перекодирование не помогло.
// Process возвращает ошибку отдельно; App.Compress записывает её текст в Error для UI.
type Result struct {
	Path         string `json:"path"`
	OutputPath   string `json:"outputPath"`
	OriginalSize int64  `json:"originalSize"`
	OutputSize   int64  `json:"outputSize"`
	Unchanged    bool   `json:"unchanged"`
	Error        string `json:"error"`
}

// Validate проверяет настройки и на стороне Go, независимо от ограничений интерфейса.
func Validate(s Settings) error {
	if s.Quality < 1 || s.Quality > 100 {
		return errors.New("качество должно быть от 1 до 100")
	}
	if s.Format != "original" && s.Format != "jpeg" {
		return errors.New("неизвестный формат результата")
	}
	if s.MaxDimension < 0 || s.MaxDimension > 20000 {
		return errors.New("недопустимое ограничение разрешения")
	}
	return nil
}

// readPhoto возвращает байты файла, параметры изображения и распознанный формат.
// Полное декодирование пикселей выполняется позднее, после проверки размеров.
func readPhoto(path string) ([]byte, image.Config, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, image.Config{}, "", err
	}
	defer f.Close() // Файл закроется при любом выходе из функции.
	stat, err := f.Stat()
	if err != nil {
		return nil, image.Config{}, "", err
	}
	if !stat.Mode().IsRegular() || stat.Size() > maxFileBytes {
		return nil, image.Config{}, "", errors.New("ожидается файл размером до 256 МБ")
	}
	// Файл мог вырасти после Stat. Ограничиваем само чтение и берём один
	// дополнительный байт, чтобы отличить допустимый размер от превышения лимита.
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, image.Config{}, "", err
	}
	if len(b) > maxFileBytes {
		return nil, image.Config{}, "", errors.New("файл превышает 256 МБ")
	}
	cfg, format, err := validateBytes(b)
	return b, cfg, format, err
}

// validateBytes отделяет проверку изображения от файловой системы:
// браузер передаёт байты выбранного фото, не имея доступа к пути на диске.
func validateBytes(b []byte) (image.Config, string, error) {
	if len(b) > maxFileBytes {
		return image.Config{}, "", errors.New("файл превышает 256 МБ")
	}
	// DecodeConfig читает заголовок, а формат определяет по содержимому,
	// не по расширению. bytes.NewReader позволяет читать срез байтов как поток.
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return cfg, format, errors.New("не удалось прочитать изображение JPEG или PNG; HEIC пока не поддерживается")
	}
	if format != "jpeg" && format != "png" {
		return cfg, format, errors.New("поддерживаются только JPEG и PNG")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return cfg, format, errors.New("поддерживаются изображения до 60 мегапикселей")
	}
	// Не превращаем анимированный PNG в неподвижную картинку с потерей кадров.
	if format == "png" && animatedPNG(b) {
		return cfg, format, errors.New("анимированный PNG не поддерживается")
	}
	return cfg, format, nil
}

// animatedPNG ищет блок управления анимацией acTL в структуре PNG.
// Первые 8 байт — сигнатура; каждый блок содержит длину (4 байта),
// тип (4), данные (n) и контрольную сумму (4), всего n + 12 байт.
func animatedPNG(b []byte) bool {
	for offset := 8; offset+12 <= len(b); {
		// Длина записана старшим байтом вперёд. Сдвиги и побитовое ИЛИ
		// собирают четыре байта в одно число; int64 защищает расчёт от переполнения int32.
		n := int64(b[offset])<<24 | int64(b[offset+1])<<16 | int64(b[offset+2])<<8 | int64(b[offset+3])
		if string(b[offset+4:offset+8]) == "acTL" {
			return true
		}
		next := int64(offset) + n + 12
		if next > int64(len(b)) {
			return false
		}
		offset = int(next)
	}
	return false
}

// Inspect подготавливает миниатюру и описание, не создавая файлов на диске.
func Inspect(path string) (Photo, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return Photo{}, err
	}
	// Символ _ отбрасывает возвращённое значение: здесь параметры заголовка не нужны.
	b, _, _, err := readPhoto(path)
	if err != nil {
		return Photo{}, err
	}
	// EXIF может хранить поворот камеры отдельно от пикселей. AutoOrientation
	// применяет его, чтобы миниатюра и размеры соответствовали видимому фото.
	img, err := imaging.Decode(bytes.NewReader(b), imaging.AutoOrientation(true))
	if err != nil {
		return Photo{}, err
	}
	// Thumbnail обрезает только превью до квадрата; исходное фото не обрезается.
	// Lanczos — фильтр пересчёта пикселей при изменении размера.
	thumb := imaging.Thumbnail(img, 88, 88, imaging.Lanczos)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, flatten(thumb), &jpeg.Options{Quality: 75}); err != nil {
		return Photo{}, err
	}
	// Base64 представляет байты JPEG текстом. Такой data URL можно сразу
	// присвоить атрибуту src у HTML-изображения, без отдельного файла миниатюры.
	return Photo{Path: path, Name: filepath.Base(path), Size: int64(len(b)), Width: img.Bounds().Dx(), Height: img.Bounds().Dy(), Thumbnail: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(out.Bytes())}, nil
}

// flatten накладывает изображение на белый фон: JPEG не поддерживает прозрачность.
func flatten(img image.Image) image.Image {
	rgba := image.NewRGBA(img.Bounds())
	// Src заполняет фон, Over рисует исходник поверх него с учётом прозрачности.
	draw.Draw(rgba, rgba.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(rgba, rgba.Bounds(), img, img.Bounds().Min, draw.Over)
	return rgba
}

// Process обрабатывает один файл: чтение → декодирование → необязательное
// уменьшение разрешения → кодирование → сравнение размеров → запись новой копии.
// ctx передаёт сигнал отмены; проверки между этапами прекращают дальнейшую работу.
func Process(ctx context.Context, path string, s Settings) (Result, error) {
	r := Result{Path: path}
	if err := Validate(s); err != nil {
		return r, err
	}
	if err := ctx.Err(); err != nil {
		return r, err
	}
	b, _, _, err := readPhoto(path)
	if err != nil {
		return r, err
	}
	r.OriginalSize = int64(len(b))
	encoded, err := Encode(ctx, b, s)
	if err != nil {
		return r, err
	}
	data := encoded.Data
	ext := ".jpg"
	if encoded.Format == "png" {
		ext = ".png"
	}
	if encoded.Unchanged {
		ext = filepath.Ext(path)
	}
	r.Unchanged = encoded.Unchanged
	dir := s.OutputDir
	if dir == "" {
		dir = filepath.Join(filepath.Dir(path), "Minify")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return r, err
	}
	// Например: «отпуск.jpg» → базовое имя «отпуск-min».
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)) + "-min"
	outputPath, err := writeUnique(ctx, dir, base, ext, data)
	if err != nil {
		return r, err
	}
	r.OutputPath = outputPath
	r.OutputSize = int64(len(data))
	return r, nil
}

// Encoded содержит результат обработки в памяти, без записи на диск.
// Этот тип используется и desktop-приложением, и Go-модулем в браузере.
type Encoded struct {
	Data          []byte
	Format        string
	Width, Height int
	Unchanged     bool
}

// Encode — общее ядро сжатия. Байты приходят из файла (desktop) или из
// выбранного пользователем File (PWA); здесь нет зависимости от интерфейса.
func Encode(ctx context.Context, b []byte, s Settings) (Encoded, error) {
	r := Encoded{}
	if err := Validate(s); err != nil {
		return r, err
	}
	if err := ctx.Err(); err != nil {
		return r, err
	}
	cfg, format, err := validateBytes(b)
	if err != nil {
		return r, err
	}
	var img image.Image
	if format == "png" {
		// Стандартный декодер сохраняет 16-битные каналы PNG, если потом
		// не выполняются изменение размера или преобразование в JPEG.
		img, err = png.Decode(bytes.NewReader(b))
	} else {
		img, err = imaging.Decode(bytes.NewReader(b), imaging.AutoOrientation(true))
	}
	if err != nil {
		return r, err
	}
	// Fit сохраняет пропорции. Условие не позволяет увеличивать маленькие фото.
	if s.MaxDimension > 0 && (img.Bounds().Dx() > s.MaxDimension || img.Bounds().Dy() > s.MaxDimension) {
		img = imaging.Fit(img, s.MaxDimension, s.MaxDimension, imaging.Lanczos)
	}
	if err := ctx.Err(); err != nil {
		return r, err
	}
	target := format
	if s.Format == "jpeg" {
		target = "jpeg"
	}
	// Сначала кодируем в буфер памяти, чтобы сравнить размер с исходником
	// до записи на диск. Метаданные исходного файла в новый поток не переносятся.
	var out bytes.Buffer
	if target == "jpeg" {
		// JPEG уменьшает размер за счёт потери части деталей; Quality задаёт компромисс.
		err = jpeg.Encode(&out, flatten(img), &jpeg.Options{Quality: s.Quality})
	} else {
		// PNG сжимает без потери пикселей: BestCompression увеличивает усилия
		// кодировщика, но не снижает качество, как параметр Quality у JPEG.
		enc := png.Encoder{CompressionLevel: png.BestCompression}
		err = enc.Encode(&out, img)
	}
	if err != nil {
		return r, err
	}
	if err := ctx.Err(); err != nil {
		return r, err
	}
	data := out.Bytes()
	// Если экономии нет, сохраняем исходные байты и расширение. В этой ветке
	// также сохраняются метаданные и не применяются выбранные изменения размера/формата.
	if len(data) >= len(b) {
		data = b
		target = format
		r.Unchanged = true
	}
	r.Data, r.Format = data, target
	r.Width, r.Height = img.Bounds().Dx(), img.Bounds().Dy()
	if r.Unchanged {
		r.Width, r.Height = cfg.Width, cfg.Height
	}
	return r, nil
}

// writeUnique создаёт новый файл, подбирая свободное имя: photo-min.jpg,
// photo-min-1.jpg и так далее. Существующие файлы никогда не перезаписываются.
func writeUnique(ctx context.Context, dir, base, ext string, data []byte) (string, error) {
	for i := 0; i < 10000; i++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		name := base + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		path := filepath.Join(dir, name)
		// O_CREATE|O_EXCL атомарно создают файл, только если его ещё нет.
		// Проверка существования отдельным вызовом была бы ненадёжной:
		// между проверкой и записью другая программа могла бы занять это имя.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, writeErr := f.Write(data)
		// Ошибка может возникнуть и при закрытии файла, поэтому учитываем её тоже.
		closeErr := f.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr != nil {
			// Убираем только созданный нами неполный результат; исходник не затрагиваем.
			_ = os.Remove(path)
			return "", writeErr
		}
		return path, nil
	}
	return "", errors.New("слишком много файлов с одинаковым именем")
}
