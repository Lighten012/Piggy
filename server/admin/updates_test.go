package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAndroidPublishingAndDownloads(t *testing.T) {
	dir, bundle := t.TempDir(), t.TempDir()
	apk := []byte("verified fixture")
	rel := androidRelease{"dev.pichat", 5, "0.4.0", 24, int64(len(apk)), fmt.Sprintf("%x", sha256.Sum256(apk)), strings.Repeat("a", 64), nil}
	put := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bundle, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	save := func() { b, _ := json.Marshal(rel); put("latest.json", b) }
	read := func(path, method string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		androidUpdates(dir, w, httptest.NewRequest(method, updatePrefix+path, nil))
		return w
	}
	if read("latest.json", "GET").Code != 404 {
		t.Fatal("expected unpublished")
	}
	put("Piggy.apk", apk)
	save()
	if err := publishAndroid(dir, bundle); err != nil {
		t.Fatal(err)
	}
	var got androidRelease
	if err := json.Unmarshal(read("latest.json", "GET").Body.Bytes(), &got); err != nil || got != rel {
		t.Fatal(got, err)
	}
	if w := read("Piggy.apk", "GET"); w.Code != 307 || w.Header().Get("Location") != updatePrefix+rel.SHA+".apk" {
		t.Fatal(w)
	}
	if w := read(rel.SHA+".apk", "GET"); w.Code != 200 || w.Body.String() != string(apk) {
		t.Fatal(w)
	}
	if read("latest.json", "POST").Code != 405 || read(".publish.lock", "GET").Code != 404 {
		t.Fatal("unexpected endpoint")
	}
	rel.Code++
	save()
	put("Piggy.apk", []byte("corrupt"))
	if publishAndroid(dir, bundle) == nil {
		t.Fatal("accepted corrupt file")
	}
	put("Piggy.apk", apk)
	rel.Signer = strings.Repeat("b", 64)
	save()
	if publishAndroid(dir, bundle) == nil {
		t.Fatal("accepted signer change")
	}
	rel.Signer = got.Signer
	rel.Code = got.Code - 1
	save()
	if publishAndroid(dir, bundle) == nil {
		t.Fatal("accepted downgrade")
	}
	if latest, err := readRelease(dir); err != nil || latest != got {
		t.Fatal(latest, err)
	}
}

func TestCPUPackageSelection(t *testing.T) {
	dir, bundle := t.TempDir(), t.TempDir()
	create := func(path string, code int, payload string) {
		t.Helper()
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		m := androidRelease{"dev.pichat", code, "0.12.0", 24, int64(len(payload)), fmt.Sprintf("%x", sha256.Sum256([]byte(payload))), strings.Repeat("a", 64), nil}
		b, _ := json.Marshal(m)
		if err := os.WriteFile(filepath.Join(path, "latest.json"), b, 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "Piggy.apk"), []byte(payload), 0644); err != nil {
			t.Fatal(err)
		}
	}
	create(bundle, 22, "arm64")
	for _, abi := range alternateABIs {
		create(filepath.Join(bundle, "variants", abi), 22, abi)
	}
	if err := publishAndroid(dir, bundle); err != nil {
		t.Fatal(err)
	}
	for _, abi := range alternateABIs {
		get := func(path string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			androidUpdates(dir, w, httptest.NewRequest("GET", path, nil))
			return w
		}
		var m androidRelease
		if err := json.Unmarshal(get(updatePrefix+"latest.json?abi="+abi).Body.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		r := get(updatePrefix + "Piggy.apk?abi=" + abi)
		if m.Code != 22 || r.Code != 307 || get(r.Header().Get("Location")).Body.String() != abi {
			t.Fatal(abi)
		}
	}
	create(bundle, 23, "next")
	if err := publishAndroid(dir, bundle); err == nil {
		t.Fatal("published mixed versions")
	}
	old, err := readRelease(dir)
	if err != nil || old.Code != 22 {
		t.Fatal("changed active release")
	}
}

func TestPublishedEngineMatchesHTTPRanges(t *testing.T) {
	dir, bundle := t.TempDir(), t.TempDir()
	var apk bytes.Buffer
	zw := zip.NewWriter(&apk)
	eng := []byte("pinned-engine")
	part, err := zw.CreateHeader(&zip.FileHeader{Name: "assets/office.lopack", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(eng); err != nil {
		t.Fatal(err)
	}
	if err = zw.Close(); err != nil {
		t.Fatal(err)
	}
	rel := androidRelease{Package: "dev.pichat", Code: 23, Name: "test", MinSDK: 24, Size: int64(apk.Len()), SHA: fmt.Sprintf("%x", sha256.Sum256(apk.Bytes())), Signer: strings.Repeat("a", 64)}
	meta, _ := json.Marshal(rel)
	for name, data := range map[string][]byte{"Piggy.apk": apk.Bytes(), "latest.json": meta} {
		if err := os.WriteFile(filepath.Join(bundle, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := publishPackage(dir, bundle); err != nil {
			t.Fatal(err)
		}
	}
	got, err := readRelease(dir)
	if err != nil || got.Engine == nil {
		t.Fatalf("missing metadata: %v", err)
	}
	e := got.Engine
	if e.SHA != fmt.Sprintf("%x", sha256.Sum256(eng)) || e.Size != int64(len(eng)) {
		t.Fatal(e)
	}
	fetch := func(start, end int64) []byte {
		req := httptest.NewRequest("GET", updatePrefix+rel.SHA+".apk", nil)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
		res := httptest.NewRecorder()
		androidUpdates(dir, res, req)
		if res.Code != 206 || res.Header().Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", start, end, rel.Size) {
			t.Fatal(res)
		}
		return res.Body.Bytes()
	}
	restored := append(fetch(0, e.Offset-1), eng...)
	restored = append(restored, fetch(e.Offset+e.Size, rel.Size-1)...)
	if !bytes.Equal(restored, apk.Bytes()) {
		t.Fatal("reconstructed APK differs")
	}
}
