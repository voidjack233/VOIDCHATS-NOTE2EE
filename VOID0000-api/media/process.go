package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type MediaError struct{ Code string }

func (e *MediaError) Error() string { return e.Code }
func invalid(code string) error     { return &MediaError{Code: code} }

type ProbeStream struct {
	Type        string `json:"codec_type"`
	Codec       string `json:"codec_name"`
	PixelFormat string `json:"pix_fmt"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	FrameRate   string `json:"avg_frame_rate"`
	Duration    string `json:"duration"`
	Start       string `json:"start_time"`
	Disposition struct {
		Attached int `json:"attached_pic"`
	} `json:"disposition"`
}
type Probe struct {
	Streams []ProbeStream `json:"streams"`
	Format  struct {
		Name     string            `json:"format_name"`
		Duration string            `json:"duration"`
		Start    string            `json:"start_time"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}
type VideoInfo struct {
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	DurationMS int64   `json:"duration_ms"`
	FPS        float64 `json:"-"`
	Audio      bool    `json:"-"`
}
type Processed struct {
	VideoPath    string
	PosterPath   string
	Info         VideoInfo
	PosterWidth  int
	PosterHeight int
}

func finite(s string) (float64, error) {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, invalid("MEDIA_METADATA_INVALID")
	}
	return n, nil
}
func rate(s string) (float64, error) {
	parts := strings.Split(s, "/")
	if len(parts) != 2 {
		return 0, invalid("MEDIA_FRAMERATE_INVALID")
	}
	n, err := finite(parts[0])
	if err != nil {
		return 0, err
	}
	d, err := finite(parts[1])
	if err != nil || d <= 0 {
		return 0, invalid("MEDIA_FRAMERATE_INVALID")
	}
	r := n / d
	if r <= 0 || r > 1000 {
		return 0, invalid("MEDIA_FRAMERATE_INVALID")
	}
	return r, nil
}
func ValidateProbe(p Probe, final bool) (VideoInfo, error) {
	if p.Format.Name != "mov,mp4,m4a,3gp,3g2,mj2" {
		return VideoInfo{}, invalid("MEDIA_CONTAINER_UNSUPPORTED")
	}
	brand := strings.TrimSpace(p.Format.Tags["major_brand"])
	if !strings.HasPrefix(brand, "iso") && brand != "mp41" && brand != "mp42" && brand != "avc1" && brand != "M4V" && brand != "dash" {
		return VideoInfo{}, invalid("MEDIA_CONTAINER_UNSUPPORTED")
	}
	duration, err := finite(p.Format.Duration)
	if err != nil || duration < 0 || duration > float64(1<<53)/1000 {
		return VideoInfo{}, invalid("MEDIA_DURATION_INVALID")
	}
	if p.Format.Start != "" {
		start, e := finite(p.Format.Start)
		if e != nil || math.Abs(start) > math.Max(duration, 1) {
			return VideoInfo{}, invalid("MEDIA_TIMESTAMPS_INVALID")
		}
	}
	info := VideoInfo{DurationMS: int64(math.Round(duration * 1000))}
	videos, audios := 0, 0
	for _, s := range p.Streams {
		if s.Duration != "" {
			d, e := finite(s.Duration)
			if e != nil || d < 0 || d > duration+math.Max(1, duration*0.1) {
				return VideoInfo{}, invalid("MEDIA_TIMESTAMPS_INVALID")
			}
		}
		if s.Start != "" {
			v, e := finite(s.Start)
			if e != nil || math.Abs(v) > math.Max(duration, 1) {
				return VideoInfo{}, invalid("MEDIA_TIMESTAMPS_INVALID")
			}
		}
		switch s.Type {
		case "video":
			videos++
			fps, e := rate(s.FrameRate)
			if e != nil || s.Width < 2 || s.Height < 2 || s.Width > 16384 || s.Height > 16384 || int64(s.Width)*int64(s.Height) > 100000000 || s.Disposition.Attached != 0 || s.Codec == "" {
				return VideoInfo{}, invalid("MEDIA_VIDEO_INVALID")
			}
			if final && (s.Width > 1920 || s.Height > 1080 || fps > 60.01 || s.Codec != "h264" || s.PixelFormat != "yuv420p") {
				return VideoInfo{}, invalid("MEDIA_OUTPUT_INVALID")
			}
			info.Width = s.Width
			info.Height = s.Height
			info.FPS = fps
		case "audio":
			audios++
			if final && s.Codec != "aac" {
				return VideoInfo{}, invalid("MEDIA_OUTPUT_INVALID")
			}
		default:
			return VideoInfo{}, invalid("MEDIA_STREAMS_UNSUPPORTED")
		}
	}
	if videos != 1 || audios > 1 {
		return VideoInfo{}, invalid("MEDIA_STREAMS_UNSUPPORTED")
	}
	info.Audio = audios == 1
	return info, nil
}

type boundedOutput struct {
	bytes    []byte
	limit    int
	overflow bool
}

func (w *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := w.limit - len(w.bytes)
	if len(p) > left {
		w.overflow = true
		p = p[:left]
	}
	w.bytes = append(w.bytes, p...)
	return n, nil
}

// Linux prlimit sets hard file/address-space limits before exec'ing FFmpeg.
// Protocol/demux restrictions prevent source-triggered network/file references.
func runTool(ctx context.Context, timeout time.Duration, binary, workspace string, fileLimit int64, args ...string) ([]byte, error) {
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	argv := append([]string{"--fsize=" + strconv.FormatInt(fileLimit, 10), "--as=1073741824", "--", binary}, args...)
	cmd := exec.CommandContext(ctx, "/usr/bin/prlimit", argv...)
	cmd.Dir = workspace
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "HOME=" + workspace, "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	out, stderr := &boundedOutput{limit: 1024 * 1024}, &boundedOutput{limit: 8192}
	cmd.Stdout = out
	cmd.Stderr = stderr
	err := cmd.Run()
	if parent.Err() != nil {
		return nil, parent.Err()
	}
	if ctx.Err() != nil {
		return nil, invalid("MEDIA_PROCESS_TIMEOUT")
	}
	if err != nil {
		return nil, invalid("MEDIA_PROCESS_FAILED")
	}
	if out.overflow {
		return nil, invalid("MEDIA_PROBE_TOO_LARGE")
	}
	return out.bytes, nil
}

func ProbeFile(ctx context.Context, c Config, path string) (Probe, error) {
	args := []string{"-v", "error", "-max_alloc", "67108864", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov",
		"-enable_drefs", "0", "-use_absolute_path", "0", "-probesize", "10485760", "-analyzeduration", "10000000", "-show_streams", "-show_format", "-of", "json", path}
	out, err := runTool(ctx, c.ProbeTimeout, c.FFprobe, filepath.Dir(path), MaxOutputBytes+1, args...)
	if err != nil {
		return Probe{}, err
	}
	var p Probe
	if err = json.Unmarshal(out, &p); err != nil {
		return Probe{}, invalid("MEDIA_PROBE_INVALID")
	}
	return p, nil
}

func Normalize(ctx context.Context, c Config, input, workspace string, source VideoInfo) (Processed, error) {
	output := filepath.Join(workspace, "normalized.mp4")
	poster := filepath.Join(workspace, "poster.webp")
	fps := strconv.FormatFloat(math.Min(source.FPS, 60), 'f', 6, 64)
	args := []string{"-nostdin", "-v", "error", "-y", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
		"-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", input,
		"-map", "0:v:0", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
		"-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=" + fps,
		"-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p"}
	if source.Audio {
		args = append(args, "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000")
	} else {
		args = append(args, "-an")
	}
	args = append(args, "-movflags", "+faststart", "-f", "mp4", output)
	if _, err := runTool(ctx, c.TranscodeTimeout, c.FFmpeg, workspace, MaxOutputBytes+1, args...); err != nil {
		return Processed{}, err
	}
	if err := checkSize(output, MaxOutputBytes); err != nil {
		return Processed{}, err
	}
	p, err := ProbeFile(ctx, c, output)
	if err != nil {
		return Processed{}, err
	}
	info, err := ValidateProbe(p, true)
	if err != nil {
		return Processed{}, err
	}
	if math.Abs(float64(info.DurationMS-source.DurationMS)) > math.Max(1000, 2000/source.FPS) {
		return Processed{}, invalid("MEDIA_OUTPUT_DURATION_MISMATCH")
	}
	args = []string{"-nostdin", "-v", "error", "-y", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", output,
		"-map", "0:v:0", "-map_metadata", "-1", "-an", "-frames:v", "1", "-vf", "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-c:v", "libwebp", "-threads", "1", "-quality", "80", "-f", "webp", poster}
	if _, err = runTool(ctx, 30*time.Second, c.FFmpeg, workspace, MaxPosterBytes+1, args...); err != nil {
		return Processed{}, err
	}
	if err = checkSize(poster, MaxPosterBytes); err != nil {
		return Processed{}, err
	}
	out, err := runTool(ctx, c.ProbeTimeout, c.FFprobe, workspace, MaxPosterBytes+1, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", poster)
	if err != nil {
		return Processed{}, err
	}
	var pp Probe
	if json.Unmarshal(out, &pp) != nil || len(pp.Streams) != 1 || pp.Streams[0].Codec != "webp" || pp.Streams[0].Width <= 0 || pp.Streams[0].Width > 640 || pp.Streams[0].Height <= 0 || pp.Streams[0].Height > 360 {
		return Processed{}, invalid("MEDIA_POSTER_INVALID")
	}
	return Processed{VideoPath: output, PosterPath: poster, Info: info, PosterWidth: pp.Streams[0].Width, PosterHeight: pp.Streams[0].Height}, nil
}

func checkSize(path string, max int64) error {
	s, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !s.Mode().IsRegular() || s.Size() <= 0 || s.Size() > max {
		return invalid("MEDIA_OUTPUT_SIZE_EXCEEDED")
	}
	return nil
}

func CopyBounded(destination io.Writer, source io.Reader, max int64) (int64, error) {
	n, err := io.Copy(destination, io.LimitReader(source, max+1))
	if err != nil {
		return n, err
	}
	if n <= 0 || n > max {
		return n, invalid("MEDIA_SOURCE_SIZE_INVALID")
	}
	return n, nil
}

func CheckTools(ctx context.Context, c Config) error {
	for _, path := range []string{c.FFmpeg, c.FFprobe, "/usr/bin/prlimit"} {
		s, err := os.Stat(path)
		if err != nil || !s.Mode().IsRegular() || s.Mode()&0111 == 0 {
			return fmt.Errorf("required media executable unavailable")
		}
	}
	return ctx.Err()
}
