//go:build embedvm

package native

import _ "embed"

// Release builds put this system's snowglobe-vm, zstd-compressed, at embedded/snowglobe-vm.zst
//
//go:embed embedded/snowglobe-vm.zst
var embeddedFile []byte

func init() { embeddedVM = embeddedFile }
