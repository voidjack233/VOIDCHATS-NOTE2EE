package media

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type Job struct {
	IngestID       string
	ConversationID string
}

func ParseJob(values map[string]interface{}) (Job, error) {
	if len(values) != 2 {
		return Job{}, fmt.Errorf("invalid video job fields")
	}
	job := Job{}
	for name, target := range map[string]*string{"ingest_id": &job.IngestID, "conversation_id": &job.ConversationID} {
		v, ok := values[name].(string)
		if !ok || len(v) != 36 {
			return Job{}, fmt.Errorf("invalid video job identity")
		}
		id, err := uuid.Parse(v)
		if err != nil || id == uuid.Nil || id.String() != v {
			return Job{}, fmt.Errorf("invalid video job identity")
		}
		*target = v
	}
	return job, nil
}

type Queue struct {
	Client     *redis.Client
	Consumer   string
	StaleAfter time.Duration
	cursor     string
}

func (q *Queue) Initialize(ctx context.Context) error {
	err := q.Client.XGroupCreateMkStream(ctx, Stream, Group, "0").Err()
	if err != nil && !strings.HasPrefix(err.Error(), "BUSYGROUP") {
		return err
	}
	return nil
}

func (q *Queue) Publish(ctx context.Context, job Job) error {
	values := map[string]interface{}{"ingest_id": job.IngestID, "conversation_id": job.ConversationID}
	if _, err := ParseJob(values); err != nil {
		return err
	}
	return q.Client.XAdd(ctx, &redis.XAddArgs{Stream: Stream, MaxLen: 10000, Approx: true, Values: values}).Err()
}

func (q *Queue) Next(ctx context.Context) ([]redis.XMessage, error) {
	if q.cursor == "" {
		q.cursor = "0-0"
	}
	messages, next, err := q.Client.XAutoClaim(ctx, &redis.XAutoClaimArgs{Stream: Stream, Group: Group, Consumer: q.Consumer, MinIdle: q.StaleAfter, Start: q.cursor, Count: 1}).Result()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	q.cursor = next
	if len(messages) > 0 {
		return messages, nil
	}
	streams, err := q.Client.XReadGroup(ctx, &redis.XReadGroupArgs{Group: Group, Consumer: q.Consumer, Streams: []string{Stream, ">"}, Count: 1, Block: 2 * time.Second}).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(streams) == 0 {
		return nil, nil
	}
	return streams[0].Messages, nil
}

// Call only after PostgreSQL records a terminal outcome (or rejects an invalid job).
func (q *Queue) Ack(ctx context.Context, id string) error {
	if err := q.Client.XAck(ctx, Stream, Group, id).Err(); err != nil {
		return err
	}
	return q.Client.XDel(ctx, Stream, id).Err()
}
