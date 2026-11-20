package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const devicesPath = "/lighten012/projects/Piggy/devices"

var hexID = regexp.MustCompile("^[a-f0-9]{64}$")

func digest(s string) string {
	hash := sha256.Sum256([]byte(s))
	return hex.EncodeToString(hash[:])
}

type registry struct{ issued, bindings string }

func (d registry) issuedTo(id string) (string, bool) {
	if !hexID.MatchString(id) {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(d.issued, id))
	return strings.TrimSpace(string(data)), err == nil
}

// A hard link atomically publishes the complete binding. Two phones cannot
// both claim an invite, and the same phone can retry after a lost response.
func (d registry) bind(id, proof string) (bool, error) {
	path := filepath.Join(d.bindings, id)
	tmp, err := os.CreateTemp(d.bindings, ".activate-")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.WriteString(digest(proof))
	closeErr := tmp.Close()
	if writeErr != nil {
		return false, writeErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	if err = os.Link(tmp.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return false, err
	}
	return d.matches(id, proof), nil
}
func (d registry) matches(id, proof string) bool {
	if !hexID.MatchString(id) || !hexID.MatchString(proof) {
		return false
	}
	data, err := os.ReadFile(filepath.Join(d.bindings, id))
	return err == nil && subtle.ConstantTimeCompare(data, []byte(digest(proof))) == 1
}
func fail(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func bearer(r *http.Request) string {
	t, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return t
}
func (d registry) activate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		fail(w, 405, "请使用 POST")
		return
	}
	code := bearer(r)
	if !hexID.MatchString(code) {
		fail(w, 401, "设备邀请码无效")
		return
	}
	id := digest(code)
	if _, ok := d.issuedTo(id); !ok {
		fail(w, 401, "设备邀请码无效或已撤销")
		return
	}
	var in struct{ Proof string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil || !hexID.MatchString(in.Proof) {
		fail(w, 400, "设备请求格式有误")
		return
	}
	bound, err := d.bind(id, in.Proof)
	if err != nil {
		fail(w, 503, "设备登记暂时不可用")
		return
	}
	if !bound {
		fail(w, 409, "此邀请码已绑定其他设备")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": id})
}

func main() {
	password := os.Getenv("PIGGY_ADMIN_PASSWORD")
	workerToken := os.Getenv("PIGGY_WORKER_TOKEN")
	state := os.Getenv("STATE_DIRECTORY")
	if password == "" || workerToken == "" || state == "" {
		log.Fatal("missing service configuration")
	}
	devices := registry{devicesPath, state}
	expected := digest("piggy:" + password)
	target, _ := url.Parse("http://127.0.0.1:18889")
	proxy := httputil.ReverseProxy{FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Header.Set("Authorization", "Bearer "+workerToken)
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Origin")
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { fail(w, 502, "对话服务暂时不可用") }}
	files := http.FileServer(http.Dir("web/dist"))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+r.Host {
			fail(w, 403, "请求来源无效")
			return
		}
		if r.URL.Path == "/device/activate" {
			devices.activate(w, r)
			return
		}
		owner := "admin"
		if token := bearer(r); token != "" {
			id, proof, _ := strings.Cut(token, ".")
			if _, ok := devices.issuedTo(id); !ok || !devices.matches(id, proof) {
				fail(w, 401, "设备授权无效或已撤销")
				return
			}
			if r.URL.Path != "/chat" {
				fail(w, 403, "此凭证仅用于设备对话")
				return
			}
			owner = "device-" + id
		} else {
			user, pass, ok := r.BasicAuth()
			if !ok || subtle.ConstantTimeCompare([]byte(digest(user+":"+pass)), []byte(expected)) != 1 {
				w.Header().Set("WWW-Authenticate", `Basic realm="Piggy", charset="UTF-8"`)
				fail(w, 401, "请登录 Piggy")
				return
			}
		}
		if r.URL.Path == "/chat" {
			r.Header.Set("X-Piggy-Owner", owner)
			proxy.ServeHTTP(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	server := http.Server{Addr: "127.0.0.1:18888", Handler: handler, ReadTimeout: 15 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 * 1024}
	log.Fatal(server.ListenAndServe())
}
