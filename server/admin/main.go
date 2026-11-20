package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type session struct {
	history []message
	used    time.Time
	busy    bool
}
type service struct {
	mu                   sync.Mutex
	sessions             map[string]*session
	endpoint, key, model string
	client               *http.Client
}

func failure(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func memoryPressure() bool {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return false
	}
	var total, available int64
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fmt.Sscanf(line, "MemTotal: %d", &total)
		}
		if strings.HasPrefix(line, "MemAvailable:") {
			fmt.Sscanf(line, "MemAvailable: %d", &available)
		}
	}
	return total > 0 && available < total/2+32*1024
}
func (s *service) acquire(id string) (string, *session, int, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var oldest string
	active := 0
	for k, v := range s.sessions {
		if v.busy {
			active++
			continue
		}
		if time.Since(v.used) > time.Hour {
			delete(s.sessions, k)
			continue
		}
		if oldest == "" || v.used.Before(s.sessions[oldest].used) {
			oldest = k
		}
	}
	if active >= 2 {
		return "", nil, 429, "服务器正在回复其他对话，请稍后重试"
	}
	c := s.sessions[id]
	if id != "" {
		if c == nil {
			return "", nil, 410, "会话已过期，请新建对话"
		}
		if c.busy {
			return "", nil, 409, "上一条消息仍在生成"
		}
	} else {
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", nil, 500, "创建会话失败"
		}
		id = hex.EncodeToString(b[:])
		if len(s.sessions) >= 8 {
			delete(s.sessions, oldest)
		}
		c = &session{}
		s.sessions[id] = c
	}
	c.busy = true
	return id, c, 0, ""
}
func (s *service) generate(ctx context.Context, history []message, delta func(string) error) (string, error) {
	payload, err := json.Marshal(map[string]any{"model": s.model, "messages": history, "stream": true, "max_tokens": 2048})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", s.endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("model HTTP %d", resp.StatusCode)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 128*1024)
	var answer strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[5:])
		if data == "[DONE]" && answer.Len() > 0 {
			return answer.String(), nil
		}
		var event struct {
			Error   json.RawMessage
			Choices []struct {
				Delta struct{ Content string }
			}
		}
		if json.Unmarshal([]byte(data), &event) != nil || len(event.Error) > 0 {
			return "", errors.New("invalid model stream")
		}
		if len(event.Choices) == 0 {
			continue
		}
		text := event.Choices[0].Delta.Content
		if answer.Len()+len(text) > 128*1024 {
			return "", errors.New("model output too large")
		}
		if text != "" {
			answer.WriteString(text)
			if err := delta(text); err != nil {
				return "", err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", io.ErrUnexpectedEOF
}
func (s *service) chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		failure(w, 405, "请使用 POST")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+r.Host {
		failure(w, 403, "请求来源无效")
		return
	}
	if media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); media != "application/json" {
		failure(w, 415, "请使用 JSON 请求")
		return
	}
	if s.key == "" {
		failure(w, 503, "服务端尚未配置模型密钥")
		return
	}
	var input struct{ Text, Session string }
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32768))
	if err != nil {
		failure(w, 413, "消息太长")
		return
	}
	if json.Unmarshal(body, &input) != nil {
		failure(w, 400, "请求格式有误")
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.Text == "" || len([]rune(input.Text)) > 8000 {
		failure(w, 400, "消息格式有误")
		return
	}
	if memoryPressure() {
		failure(w, 503, "整机内存紧张，请稍后重试")
		return
	}
	id, c, status, msg := s.acquire(input.Session)
	if status != 0 {
		failure(w, status, msg)
		return
	}
	committed := false
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		c.busy = false
		c.used = time.Now()
		if !committed && input.Session == "" {
			delete(s.sessions, id)
		}
	}()
	history := []message{{"system", "你是个人助手 Piggy。按用户使用的语言回答，清楚、简洁。"}}
	history = append(history, c.history...)
	history = append(history, message{"user", input.Text})
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.WriteHeader(200)
	rc := http.NewResponseController(w)
	if rc.Flush() != nil {
		return
	}
	emit := func(obj any) error {
		if err := json.NewEncoder(w).Encode(obj); err != nil {
			return err
		}
		return rc.Flush()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 110*time.Second)
	defer cancel()
	answer, err := s.generate(ctx, history, func(text string) error { return emit(map[string]string{"delta": text}) })
	if err != nil {
		log.Printf("generation failed: %v", err)
		emit(map[string]string{"error": "生成失败，请检查模型配置或稍后重试"})
		return
	}
	updated := append(history[1:], message{"assistant", answer})
	if len(updated) > 24 {
		updated = updated[len(updated)-24:]
	}
	c.history = append([]message(nil), updated...)
	committed = true
	emit(map[string]any{"done": true, "session": id})
}
func main() {
	password := os.Getenv("PIGGY_ADMIN_PASSWORD")
	if password == "" {
		log.Fatal("missing PIGGY_ADMIN_PASSWORD")
	}
	expected := sha256.Sum256([]byte("piggy:" + password))
	model := os.Getenv("PI_MODEL")
	if model == "" {
		model = "gpt-4.1-mini"
	}
	s := &service{sessions: make(map[string]*session), endpoint: "https://api.openai.com/v1/chat/completions", key: os.Getenv("PI_API_KEY"), model: model, client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	mux := http.NewServeMux()
	mux.HandleFunc("/chat", s.chat)
	mux.Handle("/", http.FileServer(http.Dir("web/dist")))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		user, pass, ok := r.BasicAuth()
		got := sha256.Sum256([]byte(user + ":" + pass))
		if !ok || subtle.ConstantTimeCompare(got[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Piggy", charset="UTF-8"`)
			failure(w, 401, "请登录 Piggy")
			return
		}
		mux.ServeHTTP(w, r)
	})
	server := http.Server{Addr: "127.0.0.1:18888", Handler: handler, ReadTimeout: 15 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 * 1024}
	log.Fatal(server.ListenAndServe())
}
