package main

import (
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"90":    90 * time.Second,
		"2.5":   2500 * time.Millisecond,
		"90s":   90 * time.Second,
		"1h30m": 90 * time.Minute,
	} {
		if got, err := parseDuration(in); err != nil || got != want {
			t.Errorf("%s: got %s, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "0", "-5", "0s", "-1m", "soon", "inf", "NaN"} {
		if _, err := parseDuration(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}
