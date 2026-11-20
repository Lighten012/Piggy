package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestPublicMobileAndAuthenticatedWeb(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path != "/chat" && r.URL.Path != "/history") || r.Header.Get("Authorization") != "Bearer internal" {
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
		{"POST", mobileChat, false, 200, "mobile"}, {"GET", mobileChat, false, 405, ""},
		{"GET", "/", false, 401, ""}, {"GET", "/assets/app.js", false, 401, ""}, {"POST", "/chat", false, 401, ""},
		{"GET", "/", true, 200, ""}, {"POST", "/chat", true, 405, ""}, {"GET", "/history", false, 401, ""}, {"GET", "/history?after=1", true, 200, "admin"},
	} {
		r := httptest.NewRequest(c.method, c.path, nil)
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
}
