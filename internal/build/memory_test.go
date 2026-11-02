package build

import "testing"

// Guest RAM is a size: none or less (from --memory or the image's label) is an error at once, not
// a machine that can't boot minutes into the build.
func TestResolveRefusesMemoryThatIsNone(t *testing.T) {
	for name, tc := range map[string]struct {
		o      Options
		labels map[string]string
	}{
		"a negative flag":  {Options{Memory: -256}, nil},
		"a zero label":     {Options{}, map[string]string{"snowglobe.memory": "0"}},
		"a negative label": {Options{}, map[string]string{"snowglobe.memory": "-1"}},
	} {
		if s, err := Resolve(tc.o, image(tc.labels, "sh")); err == nil {
			t.Errorf("%s: memory %d", name, s.Memory)
		}
	}
}
