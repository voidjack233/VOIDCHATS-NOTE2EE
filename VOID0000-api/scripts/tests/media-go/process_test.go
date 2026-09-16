package media_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/voidjack233/voidchats-note2ee/VOID0000-api/media"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func processorConfig() media.Config {
	return media.Config{FFmpeg: "/usr/bin/ffmpeg", FFprobe: "/usr/bin/ffprobe", ProbeTimeout: 15 * time.Second, TranscodeTimeout: 30 * time.Second}
}
func fixture(t *testing.T, directory string, audio bool) string {
	t.Helper()
	path := filepath.Join(directory, "source.mp4")
	args := []string{"-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24"}
	if audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000")
	}
	args = append(args, "-t", "1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p")
	if audio {
		args = append(args, "-c:a", "aac")
	}
	args = append(args, "-y", path)
	out, err := exec.Command("/usr/bin/ffmpeg", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("fixture: %s %v", out, err)
	}
	return path
}
func TestRealNormalization(t *testing.T) {
	for _, audio := range []bool{false, true} {
		t.Run(map[bool]string{false: "silent", true: "audio"}[audio], func(t *testing.T) {
			dir := t.TempDir()
			c := processorConfig()
			source := fixture(t, dir, audio)
			p, err := media.ProbeFile(context.Background(), c, source)
			if err != nil {
				t.Fatal("probe", err)
			}
			info, err := media.ValidateProbe(p, false)
			if err != nil {
				t.Fatal("validate", err)
			}
			result, err := media.Normalize(context.Background(), c, source, dir, info)
			if err != nil {
				t.Fatal("normalize", err)
			}
			if result.Info.Audio != audio || result.Info.Width != 320 || result.Info.Height != 180 || result.PosterWidth <= 0 || result.PosterHeight <= 0 {
				t.Fatalf("bad result: %+v", result)
			}
			for _, path := range []string{result.VideoPath, result.PosterPath} {
				s, e := os.Stat(path)
				if e != nil || s.Size() <= 0 || s.Size() > media.MaxOutputBytes {
					t.Fatal(path, e)
				}
			}
		})
	}
}
func TestProbeInvalidAndTimeout(t *testing.T) {
	c := processorConfig()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake.mp4")
	if err := os.WriteFile(path, []byte("not an MP4"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := media.ProbeFile(context.Background(), c, path); err == nil {
		t.Fatal("arbitrary bytes accepted")
	}
	source := fixture(t, dir, false)
	c.ProbeTimeout = time.Nanosecond
	if _, err := media.ProbeFile(context.Background(), c, source); err == nil {
		t.Fatal("probe timeout ignored")
	}
	c = processorConfig()
	p, err := media.ProbeFile(context.Background(), c, source)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := media.ValidateProbe(p, false)
	c.TranscodeTimeout = time.Nanosecond
	if _, err = media.Normalize(context.Background(), c, source, dir, info); err == nil {
		t.Fatal("encode timeout ignored")
	}
}

func TestProbeRejectsUnsafeStreamsAndMetadata(t *testing.T) {
	base := `{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":320,"height":180,"avg_frame_rate":"30/1","duration":"1200"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1200","tags":{"major_brand":"isom"}}}`
	for name, mutate := range map[string]func(*media.Probe){
		"no video":   func(p *media.Probe) { p.Streams = nil },
		"two videos": func(p *media.Probe) { p.Streams = append(p.Streams, p.Streams[0]) },
		"two audio": func(p *media.Probe) {
			p.Streams = append(p.Streams, media.ProbeStream{Type: "audio"}, media.ProbeStream{Type: "audio"})
		},
		"subtitle":              func(p *media.Probe) { p.Streams = append(p.Streams, media.ProbeStream{Type: "subtitle"}) },
		"data":                  func(p *media.Probe) { p.Streams = append(p.Streams, media.ProbeStream{Type: "data"}) },
		"attachment":            func(p *media.Probe) { p.Streams = append(p.Streams, media.ProbeStream{Type: "attachment"}) },
		"negative time":         func(p *media.Probe) { p.Format.Duration = "-1" },
		"NaN":                   func(p *media.Probe) { p.Format.Duration = "NaN" },
		"Inf":                   func(p *media.Probe) { p.Format.Duration = "Inf" },
		"inconsistent duration": func(p *media.Probe) { p.Streams[0].Duration = "15000" },
		"bad start":             func(p *media.Probe) { p.Streams[0].Start = "-9999" },
		"zero denominator":      func(p *media.Probe) { p.Streams[0].FrameRate = "30/0" },
		"absurd geometry":       func(p *media.Probe) { p.Streams[0].Width = 100000 },
		"unsupported container": func(p *media.Probe) { p.Format.Name = "matroska" },
	} {
		t.Run(name, func(t *testing.T) {
			var p media.Probe
			json.Unmarshal([]byte(base), &p)
			mutate(&p)
			if _, err := media.ValidateProbe(p, false); err == nil {
				t.Fatal("unsafe input accepted")
			}
		})
	}
}

func TestLongAndOversizedProfilesNormalizeWithinBounds(t *testing.T) {
	for _, scenario := range []struct{ name, input, duration string }{
		{"long low bitrate", "color=size=16x16:rate=1/5", "1200"},
		{"high resolution", "color=size=2560x1440:rate=4", "0.5"},
		{"high frame rate", "color=size=160x90:rate=120", "0.5"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "source.mp4")
			out, err := exec.Command("/usr/bin/ffmpeg", "-v", "error", "-f", "lavfi", "-i", scenario.input, "-t", scenario.duration, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", path).CombinedOutput()
			if err != nil {
				t.Fatalf("fixture %s %v", out, err)
			}
			c := processorConfig()
			p, err := media.ProbeFile(context.Background(), c, path)
			if err != nil {
				t.Fatal(err)
			}
			info, err := media.ValidateProbe(p, false)
			if err != nil {
				t.Fatal(err)
			}
			result, err := media.Normalize(context.Background(), c, path, dir, info)
			if err != nil {
				t.Fatal(err)
			}
			if result.Info.Width > 1920 || result.Info.Height > 1080 || result.Info.FPS > 60.01 {
				t.Fatal("profile not bounded", result.Info)
			}
			if scenario.name == "long low bitrate" && result.Info.DurationMS < 1200000 {
				t.Fatal("valid long clip truncated", result.Info)
			}
		})
	}
}

func TestFinalOutputOverLimitCannotPass(t *testing.T) {
	dir := t.TempDir()
	path := fixture(t, dir, false)
	c := processorConfig()
	p, err := media.ProbeFile(context.Background(), c, path)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := media.ValidateProbe(p, false)
	// A processor double writes a too-large output, testing the independent
	// post-process size guard (in addition to real prlimit during normal execution).
	script := filepath.Join(dir, "fake-ffmpeg")
	if err = os.WriteFile(script, []byte("#!/bin/sh\ntruncate -s 10485761 normalized.mp4\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c.FFmpeg = script
	if _, err = media.Normalize(context.Background(), c, path, dir, info); err == nil {
		t.Fatal("oversized output accepted")
	}
	if _, err = media.CopyBounded(io.Discard, bytes.NewReader(make([]byte, media.MaxSourceBytes+1)), media.MaxSourceBytes); err == nil {
		t.Fatal("source overflow accepted")
	}
}
