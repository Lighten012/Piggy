package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStreamHistoryAndFailedTurn(t *testing.T) {
	var calls [][]message
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data struct{ Messages []message }
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			t.Error(err)
			return
		}
		calls = append(calls, data.Messages)
		if len(calls) == 2 {
			w.WriteHeader(401)
			return
		}
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"收到\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	svc := service{sessions: make(map[string]*session), endpoint: upstream.URL, key: "fixture", client: upstream.Client()}
	send := func(text, id string) string {
		data, _ := json.Marshal(map[string]string{"text": text, "session": id})
		req := httptest.NewRequest("POST", "https://piggy.test/chat", strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		svc.chat(w, req)
		if w.Code != 200 {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	first := strings.Split(strings.TrimSpace(send("one", "")), "\n")
	var done struct {
		Session string
		Done    bool
	}
	if len(first) != 2 || !strings.Contains(first[0], "收到") || json.Unmarshal([]byte(first[1]), &done) != nil || !done.Done || done.Session == "" {
		t.Fatal(first)
	}
	if !strings.Contains(send("failed", done.Session), "\"error\"") {
		t.Fatal("expected failure")
	}
	if !strings.Contains(send("two", done.Session), done.Session) {
		t.Fatal("missing session")
	}
	if msgs := calls[2]; len(msgs) != 4 || msgs[1].Content != "one" || msgs[2].Content != "收到" || msgs[3].Content != "two" {
		t.Fatal(msgs)
	}
}

func TestConcurrentSessions(t *testing.T) {
	s := service{sessions: make(map[string]*session)}
	id, _, code, _ := s.acquire("")
	if code != 0 {
		t.Fatal(code)
	}
	if _, _, code, _ = s.acquire(id); code != 409 {
		t.Fatal(code)
	}
	if _, _, code, _ = s.acquire(""); code != 0 {
		t.Fatal(code)
	}
	if _, _, code, _ = s.acquire(""); code != 429 {
		t.Fatal(code)
	}
}
