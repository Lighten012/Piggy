package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

const mobileReplyPhrases = "/mobile/reply-phrases"
const mobileChat = "/mobile/chat"
const mobileContext = "/mobile/context"
const mobileCycle = "/mobile/cycle"
const mobileFiles = "/mobile/attachments"

func gateway(password, workerToken string, target *url.URL, files http.Handler) http.Handler {
	expected := sha256.Sum256([]byte("piggy:" + password))
	proxy := &httputil.ReverseProxy{FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		owner := "admin"
		if pr.In.URL.Path == mobileReplyPhrases || pr.In.URL.Path == mobileChat || pr.In.URL.Path == mobileFiles || pr.In.URL.Path == mobileContext || pr.In.URL.Path == mobileCycle || strings.HasPrefix(pr.In.URL.Path, "/mobile/reply-files/") {
			owner = "mobile"
		}
		pr.SetURL(target)
		pr.Out.URL.RawPath = ""
		if owner == "mobile" {
			pr.Out.URL.Path, pr.Out.URL.RawQuery = strings.TrimPrefix(pr.In.URL.Path, "/mobile"), ""
		}
		pr.Out.Header.Set("X-Piggy-Owner", owner)
		pr.Out.Header.Set("Authorization", "Bearer "+workerToken)
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Origin")
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { fail(w, 502, "对话服务暂时不可用") }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+r.Host {
			fail(w, 403, "请求来源无效")
			return
		}
		if strings.HasPrefix(r.URL.Path, updatePrefix) {
			androidUpdates(updateDirectory(), w, r)
			return
		}
		if r.URL.Path == mobileReplyPhrases {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", "GET")
				fail(w, 405, "请使用 GET")
				return
			}
			proxy.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/mobile/reply-files/") && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			proxy.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == mobileChat || r.URL.Path == mobileFiles || r.URL.Path == mobileContext || r.URL.Path == mobileCycle {
			if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Mode") != "" {
				fail(w, 403, "网页仅支持查看记录")
				return
			}
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", "POST")
				fail(w, 405, "请使用 POST")
				return
			}
			release, err := readRelease(updateDirectory())
			if err != nil {
				fail(w, 503, "版本服务暂时不可用，请稍后重试")
				return
			}
			if r.Header.Get("X-Piggy-Version-Code") != strconv.Itoa(release.Code) {
				fail(w, 426, "请重新打开 Piggy 并更新到 "+release.Name+" 后继续")
				return
			}
			proxy.ServeHTTP(w, r)
			return
		}
		user, pass, ok := r.BasicAuth()
		actual := sha256.Sum256([]byte(user + ":" + pass))
		if !ok || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Piggy", charset="UTF-8"`)
			fail(w, 401, "请登录 Piggy")
			return
		}
		if (r.URL.Path == "/reply-phrases" || r.URL.Path == "/model-settings") && r.Method == http.MethodPut {
			limit := int64(2048)
			if r.URL.Path == "/reply-phrases" {
				limit = 16384
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			proxy.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			fail(w, 405, "网页仅支持查看记录")
			return
		}
		if r.URL.Path == "/capabilities" || (r.URL.Path == "/history" && r.Method == http.MethodGet) || strings.HasPrefix(r.URL.Path, "/history/files/") {
			proxy.ServeHTTP(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// Embedded in the gateway so its service and publish-android command always
// agree on the package, ports and default update directory.
var releaseEnvironment = "production"

type deployment struct {
	root, androidPackage, gatewayAddr, workerAddr string
}

func currentDeployment() deployment {
	switch releaseEnvironment {
	case "production":
		return deployment{"/lighten012/projects/Piggy", "dev.pichat", "127.0.0.1:18888", "127.0.0.1:18889"}
	case "staging":
		return deployment{"/lighten012/projects/Piggy-staging", "dev.pichat.staging", "127.0.0.1:18988", "127.0.0.1:18989"}
	default:
		log.Fatalf("invalid release environment %q", releaseEnvironment)
		return deployment{}
	}
}

func main() {
	if len(os.Args) > 1 {
		if len(os.Args) != 3 || os.Args[1] != "publish-android" {
			log.Fatal("usage: piggy-admin publish-android <prepared-directory>")
		}
		if err := publishAndroid(updateDirectory(), os.Args[2]); err != nil {
			log.Fatal(err)
		}
		log.Print("Android release published")
		return
	}
	password, workerToken := os.Getenv("PIGGY_ADMIN_PASSWORD"), os.Getenv("PIGGY_WORKER_TOKEN")
	if password == "" || workerToken == "" {
		log.Fatal("missing service configuration")
	}
	config := currentDeployment()
	target, _ := url.Parse("http://" + config.workerAddr)
	server := http.Server{Addr: config.gatewayAddr, Handler: gateway(password, workerToken, target, http.FileServer(http.Dir("web/dist"))), ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 390 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 * 1024}
	log.Fatal(server.ListenAndServe())
}
