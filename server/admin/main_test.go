package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestSingleBindingAndRevocation(t *testing.T) {
	d := registry{t.TempDir(), t.TempDir()}
	id := digest("invite")
	a := strings.Repeat("a", 64)
	b := strings.Repeat("b", 64)
	file := filepath.Join(d.issued, id)
	if err := os.WriteFile(file, []byte("phone"), 0644); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan bool, 2)
	for _, proof := range []string{a, b} {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			ok, err := d.bind(id, p)
			if err != nil {
				t.Error(err)
			}
			results <- ok
		}(proof)
	}
	wg.Wait()
	close(results)
	wins := 0
	for ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal("two devices claimed one invite")
	}
	winner := a
	if !d.matches(id, a) {
		winner = b
	}
	if ok, err := d.bind(id, winner); err != nil || !ok {
		t.Fatal("activation retry failed")
	}
	os.Remove(file)
	if _, ok := d.issuedTo(id); ok {
		t.Fatal("revoked invite accepted")
	}
}
