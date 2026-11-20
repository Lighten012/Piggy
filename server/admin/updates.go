package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

const updatePrefix = "/updates/android/"
const maxAPKBytes = 128 << 20

var shaPattern = regexp.MustCompile("^[a-f0-9]{64}$")

type androidRelease struct {
	Package string `json:"packageName"`
	Code    int    `json:"versionCode"`
	Name    string `json:"versionName"`
	MinSDK  int    `json:"minSdk"`
	Size    int64  `json:"size"`
	SHA     string `json:"sha256"`
	Signer  string `json:"signerSha256"`
}

func readRelease(dir string) (androidRelease, error) {
	var r androidRelease
	data, err := os.ReadFile(filepath.Join(dir, "latest.json"))
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(data, &r); err != nil {
		return r, err
	}
	if r.Package != "dev.pichat" || r.Code <= 0 || r.Name == "" || r.MinSDK <= 0 || r.Size <= 0 || r.Size > maxAPKBytes || !shaPattern.MatchString(r.SHA) || !shaPattern.MatchString(r.Signer) {
		return r, errors.New("invalid Android release manifest")
	}
	return r, nil
}

func updateDirectory() string {
	if dir := os.Getenv("PIGGY_UPDATES_DIR"); dir != "" {
		return dir
	}
	return "/lighten012/projects/Piggy/updates/android"
}

// Publish the immutable APK first. Readers see the new manifest only after the
// entire binary has been verified and synced to disk.
func publishAndroid(dir, bundle string) error {
	next, err := readRelease(bundle)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, ".publish.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	current, err := readRelease(dir)
	if err == nil {
		if current.Signer != next.Signer {
			return errors.New("release signing certificate changed")
		}
		if next.Code < current.Code || (next.Code == current.Code && current != next) {
			return errors.New("versionCode must increase")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	src, err := os.Open(filepath.Join(bundle, "Piggy.apk"))
	if err != nil {
		return err
	}
	defer src.Close()
	apk, err := os.CreateTemp(dir, ".apk-")
	if err != nil {
		return err
	}
	defer os.Remove(apk.Name())
	defer apk.Close()
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(apk, h), io.LimitReader(src, next.Size+1))
	if err != nil {
		return err
	}
	if size != next.Size || hex.EncodeToString(h.Sum(nil)) != next.SHA {
		return errors.New("APK size or SHA-256 mismatch")
	}
	if err = finishFile(apk, filepath.Join(dir, next.SHA+".apk")); err != nil {
		return err
	}
	manifest, err := os.CreateTemp(dir, ".manifest-")
	if err != nil {
		return err
	}
	defer os.Remove(manifest.Name())
	defer manifest.Close()
	if err = json.NewEncoder(manifest).Encode(next); err != nil {
		return err
	}
	if err = finishFile(manifest, filepath.Join(dir, "latest.json")); err != nil {
		return err
	}
	root, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	return root.Sync()
}

func finishFile(f *os.File, dest string) error {
	if err := f.Chmod(0644); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), dest)
}

func androidUpdates(dir string, w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, 405, "仅支持下载")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, updatePrefix)
	if name == "latest.json" || name == "Piggy.apk" {
		release, err := readRelease(dir)
		if errors.Is(err, os.ErrNotExist) {
			fail(w, 404, "尚未发布 Android 版本")
			return
		}
		if err != nil {
			fail(w, 503, "版本信息暂时不可用")
			return
		}
		if name == "Piggy.apk" {
			http.Redirect(w, r, updatePrefix+release.SHA+".apk", http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			json.NewEncoder(w).Encode(release)
		}
		return
	}
	hash, ok := strings.CutSuffix(name, ".apk")
	if !ok || !shaPattern.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="Piggy.apk"`)
	w.Header().Set("ETag", fmt.Sprintf("%q", hash))
	http.ServeFile(w, r, filepath.Join(dir, name))
}
