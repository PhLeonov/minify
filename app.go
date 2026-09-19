package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/pkg/browser"
	"minify/internal/compress"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App — связующее звено между кнопками интерфейса и пакетом compress.
// Методы с получателем (a *App) работают с одним общим экземпляром приложения.
type App struct {
	ctx    context.Context    // Контекст Wails нужен, например, для диалогов и событий.
	mu     sync.Mutex         // Защищает cancel от одновременного доступа из разных вызовов.
	cancel context.CancelFunc // Функция отмены текущего задания; nil означает, что задания нет.
}

// Selection возвращает успешно прочитанные фотографии и ошибки остальных файлов.
// Теги json задают имена полей, которые увидит JavaScript: Photos станет photos.
type Selection struct {
	Photos []compress.Photo `json:"photos"`
	Errors []string         `json:"errors"`
}

// Batch — итог пакетной обработки. При отмене Results содержит уже обработанные файлы.
type Batch struct {
	Results   []compress.Result `json:"results"`
	Cancelled bool              `json:"cancelled"`
}

// NewApp создаёт приложение; контекст будет передан Wails позднее, в startup.
func NewApp() *App { return &App{} }

// startup сохраняет контекст, предоставленный Wails после запуска.
func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// shutdown запрашивает отмену обработки при закрытии приложения.
func (a *App) shutdown(ctx context.Context) { a.Cancel() }

// SelectPhotos открывает системный диалог и готовит данные для списка фотографий.
func (a *App) SelectPhotos() (Selection, error) {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Выберите фотографии",
		Filters: []runtime.FileFilter{{DisplayName: "Фотографии (JPEG, PNG)", Pattern: "*.jpg;*.jpeg;*.png;*.JPG;*.JPEG;*.PNG"}},
	})
	if err != nil {
		return Selection{}, err
	}
	// Пустые срезы передаются в JavaScript как [], а не null.
	selection := Selection{Photos: []compress.Photo{}, Errors: []string{}}
	for _, path := range paths {
		p, err := compress.Inspect(path)
		if err != nil {
			// Ошибка одной фотографии не мешает добавить остальные.
			selection.Errors = append(selection.Errors, fmt.Sprintf("%s: %v", filepath.Base(path), err))
			continue
		}
		selection.Photos = append(selection.Photos, p)
	}
	return selection, nil
}

// SelectOutputDirectory возвращает выбранную папку; отмена диалога даёт пустую строку.
func (a *App) SelectOutputDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "Папка для сжатых фотографий"})
}

// OpenResultFolder открывает папку сохранённого файла в системном файловом менеджере.
func (a *App) OpenResultFolder(outputPath string) error {
	dir, err := filepath.Abs(filepath.Dir(outputPath))
	if err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("папка не найдена")
	}
	return browser.OpenFile(dir)
}

// Cancel подаёт сигнал отмены. Process проверяет его между этапами обработки;
// уже выполняющееся кодирование не прерывается в середине.
func (a *App) Cancel() {
	a.mu.Lock()
	// defer выполнит Unlock при выходе из функции, в том числе при раннем return.
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
}

// Compress последовательно обрабатывает выбранные файлы и отправляет прогресс в UI.
// Ошибки отдельных файлов попадают в Results, ошибка запуска — во второй результат.
func (a *App) Compress(paths []string, settings compress.Settings) (Batch, error) {
	if err := compress.Validate(settings); err != nil {
		return Batch{}, err
	}
	// Проверка и установка cancel выполняются под одним замком:
	// два одновременных вызова не смогут запустить два задания.
	a.mu.Lock()
	if a.cancel != nil {
		a.mu.Unlock()
		return Batch{}, errors.New("сжатие уже выполняется")
	}
	// Дочерний контекст можно отменить отдельно, не завершая всё приложение.
	ctx, cancel := context.WithCancel(a.ctx)
	a.cancel = cancel
	a.mu.Unlock()
	// При любом выходе освобождаем ресурсы контекста и разрешаем следующее задание.
	// На время сжатия замок отпущен, поэтому кнопка отмены может вызвать Cancel.
	defer func() { cancel(); a.mu.Lock(); a.cancel = nil; a.mu.Unlock() }()
	batch := Batch{Results: []compress.Result{}}
	for i, path := range paths {
		if ctx.Err() != nil {
			batch.Cancelled = true
			break
		}
		result, err := compress.Process(ctx, path, settings)
		if errors.Is(err, context.Canceled) {
			batch.Cancelled = true
			break
		}
		if err != nil {
			result.Error = err.Error()
		}
		batch.Results = append(batch.Results, result)
		// frontend/app.js слушает это событие и обновляет список и полосу прогресса,
		// не дожидаясь завершения вызова Compress для всей очереди.
		runtime.EventsEmit(a.ctx, "compression:progress", map[string]interface{}{"completed": i + 1, "total": len(paths), "result": result})
	}
	return batch, nil
}
