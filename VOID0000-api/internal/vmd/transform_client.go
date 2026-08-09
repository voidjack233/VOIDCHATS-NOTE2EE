package vmd

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
)

const (
	transformProtocolVersion = 1
	maxTransformHeaderBytes  = 4 * 1024
)

type Image struct {
	Body        []byte
	ContentType string
	Width       int
	Height      int
	Pages       int
	ETag        string
}

type transformFrame struct {
	Version       int    `json:"version"`
	Operation     string `json:"operation,omitempty"`
	Type          string `json:"type,omitempty"`
	Variant       string `json:"variant,omitempty"`
	PayloadLength int    `json:"payloadLength,omitempty"`
	Status        int    `json:"status,omitempty"`
	Code          string `json:"code,omitempty"`
	Message       string `json:"message,omitempty"`
	Metadata      *struct {
		ContentType string `json:"contentType"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Pages       int    `json:"pages"`
	} `json:"metadata,omitempty"`
}

type TransformClient struct {
	socketPath     string
	timeout        time.Duration
	maxSourceBytes int64
	maxOutputBytes int64
}

func NewTransformClient(socketPath string, timeout time.Duration, maxSourceBytes, maxOutputBytes int64) *TransformClient {
	return &TransformClient{
		socketPath:     socketPath,
		timeout:        timeout,
		maxSourceBytes: maxSourceBytes,
		maxOutputBytes: maxOutputBytes,
	}
}

func writeControlFrame(writer io.Writer, frame transformFrame) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(payload) == 0 || len(payload) > maxTransformHeaderBytes {
		return fmt.Errorf("VMD transform control frame is invalid")
	}
	prefix := make([]byte, 4)
	binary.BigEndian.PutUint32(prefix, uint32(len(payload)))
	if err := writeAll(writer, prefix); err != nil {
		return err
	}
	return writeAll(writer, payload)
}

func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrUnexpectedEOF
		}
		payload = payload[written:]
	}
	return nil
}

func readControlFrame(reader *bufio.Reader) (transformFrame, error) {
	prefix := make([]byte, 4)
	if _, err := io.ReadFull(reader, prefix); err != nil {
		return transformFrame{}, err
	}
	length := int(binary.BigEndian.Uint32(prefix))
	if length <= 0 || length > maxTransformHeaderBytes {
		return transformFrame{}, fmt.Errorf("VMD transform control frame exceeds its limit")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return transformFrame{}, err
	}
	var frame transformFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		return transformFrame{}, err
	}
	return frame, nil
}

func remoteTransformError(frame transformFrame) error {
	status := frame.Status
	if status < 400 || status > 599 {
		status = 500
	}
	code := frame.Code
	if code == "" {
		code = "VMD_TRANSFORM_FAILED"
	}
	message := frame.Message
	if message == "" {
		message = "VMD image transformation failed"
	}
	return mediaError(status, code, message, nil)
}

func (c *TransformClient) dial(ctx context.Context) (net.Conn, error) {
	dialer := net.Dialer{Timeout: c.timeout}
	connection, err := dialer.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return nil, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}
	deadline := time.Now().Add(c.timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		_ = connection.Close()
		return nil, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}
	return connection, nil
}

func (c *TransformClient) Transform(ctx context.Context, source []byte, variant string) (Image, error) {
	if len(source) == 0 || int64(len(source)) > c.maxSourceBytes {
		return Image{}, mediaError(413, "VMD_SOURCE_TOO_LARGE", "Attachment exceeds the VMD source limit", nil)
	}
	if _, ok := Variants[variant]; !ok {
		return Image{}, mediaError(400, "VMD_VARIANT_UNSUPPORTED", "Unsupported VMD image variant", nil)
	}

	connection, err := c.dial(ctx)
	if err != nil {
		return Image{}, err
	}
	defer connection.Close()
	reader := bufio.NewReaderSize(connection, maxTransformHeaderBytes+4)

	if err := writeControlFrame(connection, transformFrame{
		Version:       transformProtocolVersion,
		Operation:     "transform",
		Variant:       variant,
		PayloadLength: len(source),
	}); err != nil {
		return Image{}, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}
	ready, err := readControlFrame(reader)
	if err != nil {
		return Image{}, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}
	if ready.Type == "error" {
		return Image{}, remoteTransformError(ready)
	}
	if ready.Version != transformProtocolVersion || ready.Type != "ready" {
		return Image{}, mediaError(503, "VMD_TRANSFORM_PROTOCOL_ERROR", "VMD transform worker returned an invalid response", nil)
	}
	if err := writeAll(connection, source); err != nil {
		return Image{}, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}

	result, err := readControlFrame(reader)
	if err != nil {
		return Image{}, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}
	if result.Type == "error" {
		return Image{}, remoteTransformError(result)
	}
	if result.Version != transformProtocolVersion || result.Type != "result" || result.Metadata == nil || result.PayloadLength <= 0 || int64(result.PayloadLength) > c.maxOutputBytes {
		return Image{}, mediaError(503, "VMD_TRANSFORM_PROTOCOL_ERROR", "VMD transform worker returned an invalid response", nil)
	}
	if result.Metadata.ContentType != "image/webp" || result.Metadata.Width <= 0 || result.Metadata.Height <= 0 || result.Metadata.Pages <= 0 {
		return Image{}, mediaError(503, "VMD_TRANSFORM_PROTOCOL_ERROR", "VMD transform worker returned invalid image metadata", nil)
	}
	body := make([]byte, result.PayloadLength)
	if _, err := io.ReadFull(reader, body); err != nil {
		return Image{}, mediaError(503, "VMD_TRANSFORM_UNAVAILABLE", "VMD transform worker is unavailable", err)
	}

	return Image{
		Body:        body,
		ContentType: result.Metadata.ContentType,
		Width:       result.Metadata.Width,
		Height:      result.Metadata.Height,
		Pages:       result.Metadata.Pages,
	}, nil
}

func (c *TransformClient) Ping(ctx context.Context) error {
	connection, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	reader := bufio.NewReaderSize(connection, maxTransformHeaderBytes+4)
	if err := writeControlFrame(connection, transformFrame{
		Version:   transformProtocolVersion,
		Operation: "ping",
	}); err != nil {
		return err
	}
	response, err := readControlFrame(reader)
	if err != nil {
		return err
	}
	if response.Version != transformProtocolVersion || response.Type != "pong" {
		return fmt.Errorf("VMD transform worker returned an invalid readiness response")
	}
	return nil
}
