package main

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const previewPath = "/mobile/preview"
const previewSocket = "/run/piggy-preview/office.sock"
const previewLimit = 32 << 20

func officeProxy() http.Handler {
	p := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: "preview"})
	p.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", previewSocket)
	}}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) { fail(w, 503, "Office 预览暂时不可用") }
	return p
}

func serveOffice() error {
	_ = os.Remove(previewSocket)
	listener, err := net.Listen("unix", previewSocket)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod(previewSocket, 0666); err != nil {
		return err
	}
	slot := make(chan struct{}, 1)
	server := http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 70 * time.Second, WriteTimeout: 100 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != previewPath {
			http.NotFound(w, r)
			return
		}
		select {
		case slot <- struct{}{}:
			defer func() { <-slot }()
		default:
			fail(w, 429, "另一份文件正在排版，请稍后重试")
			return
		}
		convertOffice(w, r)
	})}
	return server.Serve(listener)
}

func officeType(ext string) bool {
	switch ext {
	case "doc", "docx", "dot", "odt", "rtf", "ppt", "pptx", "pot", "pps", "odp", "pages", "key":
		return true
	}
	return false
}

// Verify the main document part before launching the converter. Encrypted OOXML
// containers and truncated ZIP files cannot be rendered without a password.
func validateOffice(path, ext string) (int, string) {
	part := map[string]string{"docx": "word/document.xml", "pptx": "ppt/presentation.xml", "odt": "content.xml", "odp": "content.xml"}[ext]
	z, err := zip.OpenReader(path)
	if err != nil {
		if part != "" {
			return 422, "文档可能已加密或损坏"
		}
		return 0, ""
	}
	defer z.Close()
	const maxExpanded = 128 << 20
	var total uint64
	found := part == ""
	for _, member := range z.File {
		if member.UncompressedSize64 > maxExpanded-total {
			return 413, "文档解压后过大"
		}
		total += member.UncompressedSize64
		if member.Name == part {
			found = true
		}
	}
	if !found {
		return 422, "文档内容与文件格式不符"
	}
	return 0, ""
}

func availableMemory() bool {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return false
	}
	var total, avail int64
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total, _ = strconv.ParseInt(f[1], 10, 64)
		case "MemAvailable:":
			avail, _ = strconv.ParseInt(f[1], 10, 64)
		}
	}
	// Reserve the conversion service's full cgroup budget above the host's 50% target.
	return total > 0 && avail > total/2+384*1024
}

func convertOffice(w http.ResponseWriter, r *http.Request) {
	ext := r.Header.Get("X-Piggy-Format")
	if !officeType(ext) {
		fail(w, 415, "该文件类型无法排版")
		return
	}
	if !availableMemory() {
		fail(w, 503, "服务器内存繁忙，请稍后重试")
		return
	}
	dir, err := os.MkdirTemp("", "piggy-office-")
	if err != nil {
		fail(w, 500, "无法创建预览")
		return
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "document."+ext)
	f, err := os.Create(path)
	if err != nil {
		fail(w, 500, "无法创建预览")
		return
	}
	size, err := io.Copy(f, http.MaxBytesReader(w, r.Body, previewLimit))
	closeErr := f.Close()
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			fail(w, 413, "文件超过 32 MB 预览上限")
		} else {
			fail(w, 400, "文件传输不完整")
		}
		return
	}
	if size == 0 || closeErr != nil {
		fail(w, 400, "无法读取文件")
		return
	}
	if code, message := validateOffice(path, ext); code != 0 {
		fail(w, code, message)
		return
	}
	profile := filepath.Join(dir, "profile")
	if err = os.MkdirAll(filepath.Join(profile, "user"), 0700); err != nil {
		fail(w, 500, "无法准备排版")
		return
	}
	const settings = `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`
	if err = os.WriteFile(filepath.Join(profile, "user/registrymodifications.xcu"), []byte(settings), 0600); err != nil {
		fail(w, 500, "无法准备排版")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 65*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/libreoffice", "-env:UserInstallation=file://"+profile, "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", "pdf", "--outdir", dir, path)
	cmd.Dir = dir
	cmd.Env = []string{"HOME=" + dir, "LANG=C.UTF-8", "PATH=/usr/bin:/bin", "SAL_USE_VCLPLUGIN=svp"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	if err = cmd.Run(); err != nil {
		fail(w, 422, "文档转换失败，文件可能损坏、加密或过大")
		return
	}
	pdf, err := os.Open(filepath.Join(dir, "document.pdf"))
	if err != nil {
		fail(w, 422, "文件无法预览，可能已加密或格式不受支持")
		return
	}
	defer pdf.Close()
	info, err := pdf.Stat()
	if err != nil || info.Size() < 5 || info.Size() > 64<<20 {
		fail(w, 422, "预览文件为空或过大")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Cache-Control", "private, no-store")
	io.Copy(w, pdf)
}
