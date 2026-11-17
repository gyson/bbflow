//go:build !darwin

package main

import "errors"

const menuBarSupported = false

func runNativeMenu(<-chan struct{}, string, func() error, func() error) error {
	return errors.New("the menu bar is supported only on macOS")
}
