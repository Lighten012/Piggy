package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicMobileAndAuthenticatedWeb(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIGGY_UPDATES_DIR", dir)
	release := androidRelease{Package: "dev.pichat", Code: 6, Name: "0.5.0", MinSDK: 24, Size: 1, SHA: strings.Repeat("a", 64), Signer: strings.Repeat("b", 64)}
	data, _ := json.Marshal(release)
	if err := os.WriteFile(filepath.Join(dir, "latest.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path != "/model-settings" && r.URL.Path != "/capabilities" && r.URL.Path != "/chat" && r.URL.Path != "/context" && r.URL.Path != "/cycle" && r.URL.Path != "/history" && r.URL.Path != "/attachments" && r.URL.Path != "/history/files/test") || r.Header.Get("Authorization") != "Bearer internal" {
			t.Error("unexpected upstream request")
		}
		w.Header().Set("X-Test-Owner", r.Header.Get("X-Piggy-Owner"))
	}))
	defer worker.Close()
	target, _ := url.Parse(worker.URL)
	h := gateway("pw", "internal", target, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	for _, c := range []struct {
		method, path string
		login        bool
		want         int
		owner        string
	}{
		{"GET", "/capabilities", false, 401, ""}, {"GET", "/capabilities", true, 200, "admin"},
		{"PUT", "/model-settings", true, 200, "admin"}, {"PUT", "/model-settings", false, 401, ""},
		{"PUT", "/mobile/model-settings", false, 401, ""},
		{"HEAD", "/capabilities", true, 200, "admin"}, {"POST", "/capabilities", true, 405, ""},
		{"POST", "/mobile/cycle", false, 200, "mobile"},
		{"GET", "/mobile/capabilities", false, 401, ""},
		{"POST", mobileContext, false, 200, "mobile"}, {"GET", mobileContext, false, 405, ""},
		{"POST", mobileFiles, false, 200, "mobile"}, {"GET", mobileFiles, false, 405, ""},
		{"POST", mobileChat, false, 200, "mobile"}, {"GET", mobileChat, false, 405, ""},
		{"GET", "/history/files/test", false, 401, ""}, {"HEAD", "/history/files/test", true, 200, "admin"},
		{"GET", "/history/files/test?download=1", true, 200, "admin"}, {"POST", "/history/files/test", true, 405, ""},
		{"GET", "/", false, 401, ""}, {"GET", "/assets/app.js", false, 401, ""}, {"POST", "/chat", false, 401, ""},
		{"GET", "/", true, 200, ""}, {"POST", "/chat", true, 405, ""}, {"GET", "/history", false, 401, ""}, {"GET", "/history?after=1", true, 200, "admin"},
	} {
		r := httptest.NewRequest(c.method, c.path, nil)
		r.Header.Set("X-Piggy-Version-Code", "6")
		r.Header.Set("X-Piggy-Owner", "admin")
		if c.login {
			r.SetBasicAuth("piggy", "pw")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want || w.Header().Get("X-Test-Owner") != c.owner {
			t.Errorf("%s %s: got %d, owner %q", c.method, c.path, w.Code, w.Header().Get("X-Test-Owner"))
		}
	}
	for _, code := range []string{"", "5", "7"} {
		r := httptest.NewRequest("POST", mobileChat, nil)
		r.Header.Set("X-Piggy-Version-Code", code)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 426 {
			t.Fatalf("client %q got %d", code, w.Code)
		}
	}

}
