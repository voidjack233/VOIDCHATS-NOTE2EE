#!/bin/sh
set -eu

alias_name=voidapp
endpoint=http://minio:9000

mc alias set "$alias_name" "$endpoint" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
mc ready "$alias_name" >/dev/null

for bucket in \
  "$MINIO_BUCKET" \
  "$MINIO_GROUP_AVATAR_BUCKET" \
  "$MINIO_ATTACH_BUCKET" \
  "$MINIO_VMD_CACHE_BUCKET"
do
  mc mb --ignore-existing "$alias_name/$bucket" >/dev/null
done

mc anonymous set download "$alias_name/$MINIO_BUCKET" >/dev/null
mc anonymous set download "$alias_name/$MINIO_GROUP_AVATAR_BUCKET" >/dev/null
mc anonymous set none "$alias_name/$MINIO_ATTACH_BUCKET" >/dev/null
mc anonymous set none "$alias_name/$MINIO_VMD_CACHE_BUCKET" >/dev/null

mc stat "$alias_name/$MINIO_BUCKET" >/dev/null
mc stat "$alias_name/$MINIO_GROUP_AVATAR_BUCKET" >/dev/null
mc stat "$alias_name/$MINIO_ATTACH_BUCKET" >/dev/null
mc stat "$alias_name/$MINIO_VMD_CACHE_BUCKET" >/dev/null

printf '%s\n' 'MinIO buckets and access policies are ready.'
