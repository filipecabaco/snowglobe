// names prints the names of a fleet file's entries, as the native loader reads them, as JSON. The
// browser fleet page's tests (internal/site/fleet.test.cjs) compare them with what its own planner
// sees, so the two stay one format.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/filipecabaco/snowglobe/internal/fleet"
)

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: names FLEET.toml")
		os.Exit(2)
	}
	f, err := fleet.Load(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Each snapshot command's time limit, in seconds
	limits := map[string][]float64{}
	for n, s := range f.Snapshots {
		limits[n] = []float64{}
		for _, c := range s.Run {
			limits[n] = append(limits[n], s.Limit(c).Seconds())
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{
		"limits": limits, "name": f.Name, "templates": keys(f.Templates), "snapshots": keys(f.Snapshots),
		"services": keys(f.Services), "machines": keys(f.Machines), "links": keys(f.Links),
	})
}
