//go:build darwin

package main

import (
	"fmt"
	"os"
	"sync/atomic"

	"bbflow/internal/webui"

	"github.com/gogpu/systray"
)

const menuBarSupported = true

// Preview builds can set a display version at link time.
var menuVersion string

// systray locks the initial OS thread during init. Only this child enters AppKit. The
// CLI and server remain independent of the native event loop.
// tag names an instance directory that is not the default directory of the build. It
// is empty for the default directory.
func runNativeMenu(ended <-chan struct{}, tag string, openUI, quit func() error) error {
	select {
	case <-ended:
		return nil
	default:
	}
	tray := systray.New()
	menu := systray.NewMenu()
	displayVersion := version
	if menuVersion != "" {
		displayVersion = menuVersion
	}
	quitLabel := menuQuitLabel(displayVersion, tag)
	tooltip := "bbflow"
	if tag != "" {
		tooltip += " " + tag
	}
	var busy atomic.Bool
	var openItem, quitItem *systray.MenuItem
	action := func(item *systray.MenuItem, label string, fn func() error, quitting bool) {
		if !busy.CompareAndSwap(false, true) {
			return
		}
		// Menu updates dispatch to the native thread. Return from its callback first.
		go func() {
			openItem.SetDisabled(true)
			quitItem.SetDisabled(true)
			if quitting {
				item.SetLabel("Quitting bbflow…")
			}
			err := fn()
			select {
			case <-ended:
				return
			default:
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "bbflow menu bar:", err)
				item.SetLabel(label + " — failed; retry")
			} else if quitting {
				return // Keep disabled until the server closes its lifetime pipe.
			} else {
				item.SetLabel(label)
			}
			openItem.SetDisabled(false)
			quitItem.SetDisabled(false)
			busy.Store(false)
		}()
	}
	openItem = menu.Add("Open UI", func() { action(openItem, "Open UI", openUI, false) })
	menu.AddSeparator()
	quitItem = menu.Add(quitLabel, func() { action(quitItem, quitLabel, quit, true) })
	tray.SetTemplateIcon(webui.MenuBarIcon).SetTooltip(tooltip).SetMenu(menu).Show()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ended:
			tray.Remove()
		case <-finished:
		}
	}()
	return tray.Run()
}
