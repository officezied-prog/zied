"""S3 / R2 backed store. boto3 is imported lazily so local runs need no AWS deps."""
from __future__ import annotations

from functools import cached_property

from .base import ObjectStore, PresignedUpload


class S3ObjectStore(ObjectStore):
    def __init__(self, region: str, endpoint_url: str | None = None) -> None:
        self.region = region
        self.endpoint_url = endpoint_url

    @cached_property
    def _client(self):
        import boto3
        from botocore.config import Config

        return boto3.client(
            "s3",
            region_name=self.region,
            endpoint_url=self.endpoint_url,
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        )

    def presign_put(self, bucket: str, key: str, *, content_type: str,
                    max_bytes: int, ttl: int) -> PresignedUpload:
        url = self._client.generate_presigned_url(
            "put_object",
            Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=ttl,
        )
        return PresignedUpload(url=url, headers={"Content-Type": content_type}, expires_in=ttl)

    def presign_get(self, bucket: str, key: str, *, ttl: int) -> str:
        return self._client.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=ttl
        )

    def put_bytes(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        self._client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)

    def get_bytes(self, bucket: str, key: str) -> bytes:
        return self._client.get_object(Bucket=bucket, Key=key)["Body"].read()

    def exists(self, bucket: str, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=bucket, Key=key)
            return True
        except ClientError:
            return False

    def delete(self, bucket: str, key: str) -> None:
        self._client.delete_object(Bucket=bucket, Key=key)

    def delete_prefix(self, bucket: str, prefix: str) -> int:
        paginator = self._client.get_paginator("list_objects_v2")
        deleted = 0
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objects:
                self._client.delete_objects(Bucket=bucket, Delete={"Objects": objects})
                deleted += len(objects)
        return deleted
