package main

import (
	"archive/zip"
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
	"strconv"
	"strings"
	"syscall"
)

const updatePrefix = "/updates/android/"
const maxAPKBytes = 128 << 20

var shaPattern = regexp.MustCompile("^[a-f0-9]{64}$")

type engineRegion struct {
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
	SHA    string `json:"sha256"`
}

func findEngine(apk *os.File, size int64) (*engineRegion, error) {
	archive, err := zip.NewReader(apk, size)
	if err != nil {
		return nil, err
	}
	for _, entry := range archive.File {
		if entry.Name != "assets/office.lopack" || entry.Method != zip.Store {
			continue
		}
		offset, err := entry.DataOffset()
		if err != nil {
			return nil, err
		}
		n := int64(entry.UncompressedSize64)
		if offset <= 0 || n <= 0 || n >= size-offset || entry.CompressedSize64 != entry.UncompressedSize64 {
			return nil, errors.New("invalid embedded engine extent")
		}
		h := sha256.New()
		if _, err := io.CopyN(h, io.NewSectionReader(apk, offset, n), n); err != nil {
			return nil, err
		}
		return &engineRegion{offset, n, hex.EncodeToString(h.Sum(nil))}, nil
	}
	// A future APK without a reusable stored asset can still be published in full.
	return nil, nil
}

type androidRelease struct {
	Package string        `json:"packageName"`
	Code    int           `json:"versionCode"`
	Name    string        `json:"versionName"`
	MinSDK  int           `json:"minSdk"`
	Size    int64         `json:"size"`
	SHA     string        `json:"sha256"`
	Signer  string        `json:"signerSha256"`
	Engine  *engineRegion `json:"engine,omitempty"`
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

var alternateABIs = []string{"armeabi-v7a", "x86", "x86_64"}

// Publish CPU-specific packages before switching the default manifest. Older
// clients receive an installable ARM64 package with a CPU-aware updater.
func publishAndroid(dir, bundle string) error {
	primary, err := readRelease(bundle)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(bundle, "variants")); err == nil {
		for _, abi := range alternateABIs {
			src := filepath.Join(bundle, "variants", abi)
			v, err := readRelease(src)
			if err != nil {
				return err
			}
			if v.Code != primary.Code || v.Name != primary.Name || v.Signer != primary.Signer || v.MinSDK != primary.MinSDK {
				return errors.New("inconsistent Android CPU variant")
			}
			if err := publishPackage(variantDir(dir, v.Code, abi), src); err != nil {
				return err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) || primary.Code >= 22 {
		return fmt.Errorf("missing Android CPU packages: %w", err)
	}
	return publishPackage(dir, bundle)
}

func variantDir(dir string, code int, abi string) string {
	return filepath.Join(dir, "variants", fmt.Sprint(code), abi)
}

func publishPackage(dir, bundle string) error {
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
	// Engine metadata is derived from the signed APK by this publisher.
	next.Engine = nil
	current, err := readRelease(dir)
	if err == nil {
		current.Engine = nil
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
	if next.Code >= 23 {
		next.Engine, err = findEngine(apk, size)
		if err != nil {
			return fmt.Errorf("inspect Android package: %w", err)
		}
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
	abi := r.URL.Query().Get("abi")
	if abi != "" && abi != "arm64-v8a" {
		known := false
		for _, a := range alternateABIs {
			if abi == a {
				known = true
				break
			}
		}
		if !known {
			http.NotFound(w, r)
			return
		}
		primary, err := readRelease(dir)
		if err != nil {
			fail(w, 503, "版本信息暂时不可用")
			return
		}
		code := primary.Code
		if name != "latest.json" && name != "Piggy.apk" {
			requested, err := strconv.Atoi(r.URL.Query().Get("v"))
			if err != nil || requested <= 0 || requested > primary.Code {
				http.NotFound(w, r)
				return
			}
			code = requested
		}
		dir = variantDir(dir, code, abi)
	}
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
			target := updatePrefix + release.SHA + ".apk"
			if abi != "" && abi != "arm64-v8a" {
				target += "?abi=" + abi + "&v=" + strconv.Itoa(release.Code)
			}
			http.Redirect(w, r, target, http.StatusTemporaryRedirect)
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
