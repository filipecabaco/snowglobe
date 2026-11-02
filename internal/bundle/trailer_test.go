package bundle

import (
	"encoding/binary"
	"testing"
)

// A file that ends like a bundle but whose index offsets overflow is not one (snowglobe reads the
// trailer of whatever --runtime names): an error, not a panic.
func TestATrailerWithOverflowingOffsetsIsNoBundle(t *testing.T) {
	for _, tc := range []struct{ exe, at, n uint64 }{
		{0, 1<<64 - 8, 16}, // at+n wraps round to 8
		{0, 4, 1<<64 - 1},  // so does n
		{1<<64 - 1, 0, 0},  // exe past everything
	} {
		data := make([]byte, 64)
		for _, v := range []uint64{tc.exe, tc.at, tc.n} {
			data = binary.LittleEndian.AppendUint64(data, v)
		}
		data = append(data, Magic...)
		if _, err := Read(data); err == nil {
			t.Errorf("%+v: read as a bundle", tc)
		}
	}
}
