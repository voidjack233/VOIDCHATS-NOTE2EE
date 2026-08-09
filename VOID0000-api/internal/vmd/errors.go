package vmd

import "fmt"

type MediaError struct {
	Code    string
	Status  int
	Message string
	Cause   error
}

func (e *MediaError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

func (e *MediaError) Unwrap() error {
	return e.Cause
}

func mediaError(status int, code, message string, cause error) *MediaError {
	return &MediaError{
		Code:    code,
		Status:  status,
		Message: message,
		Cause:   cause,
	}
}

func wrapInternal(operation string, err error) error {
	return fmt.Errorf("%s: %w", operation, err)
}
