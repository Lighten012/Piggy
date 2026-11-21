package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewRejectsBrokenOfficePackages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slides.pptx")
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _ := validateOffice(path, "pptx"); code != 422 {
		t.Fatalf("corrupt package: %d", code)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	if _, err = archive.Create("word/document.xml"); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	if code, _ := validateOffice(path, "pptx"); code != 422 {
		t.Fatalf("mismatched package: %d", code)
	}
	if code, _ := validateOffice(path, "docx"); code != 0 {
		t.Fatalf("valid main part: %d", code)
	}
}
