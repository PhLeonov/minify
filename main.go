// Приложение состоит из трёх частей:
// main.go запускает окно, app.go связывает интерфейс с Go,
// а internal/compress выполняет обработку изображений.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// assets содержит файлы интерфейса прямо внутри исполняемого файла.
// Директива go:embed выполняется при сборке: отдельная папка frontend
// рядом с готовым Minify.exe не нужна. embed.FS — файловая система только для чтения.
//
//go:embed all:frontend
var assets embed.FS

// main — точка входа: Go вызывает эту функцию при запуске программы.
func main() {
	app := NewApp()
	// Wails создаёт нативное окно с веб-интерфейсом и работает до его закрытия.
	// AssetServer раздаёт встроенные HTML/CSS/JS, OnStartup и OnShutdown
	// вызываются при запуске и завершении приложения.
	err := wails.Run(&options.App{
		Title: "Minify — сжатие фотографий", Width: 1180, Height: 800,
		MinWidth: 940, MinHeight: 680,
		BackgroundColour: &options.RGBA{R: 246, G: 247, B: 249, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup, OnShutdown: app.shutdown,
		// Bind делает экспортируемые методы App (с заглавной буквы)
		// доступными из JavaScript как window.go.main.App.ИмяМетода(...).
		Bind: []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}
