"""Hosted try-on vendors (Replicate / fal style).

Submits the job and returns immediately; the vendor calls back to
`/webhooks/vton/{provider}`, which is verified and deduplicated through
`webhook_events`. Polling is the fallback when no public callback URL exists.
"""
from __future__ import annotations

import base64
import io
import time

import numpy as np

from .base import RenderRequest, RenderResult


class HostedVtonProvider:
    provider = "replicate"
    supports_multi_garment = True

    def __init__(self, model_id: str, endpoint: str, api_token: str, *,
                 webhook_url: str | None = None, timeout: float = 60.0) -> None:
        self.model_id = model_id
        self.endpoint = endpoint
        self.api_token = api_token
        self.webhook_url = webhook_url
        self.timeout = timeout

    def submit(self, request: RenderRequest) -> str:
        """Returns the vendor's job id; the result arrives by webhook."""
        import httpx

        payload = {
            "input": {
                "human_img": _data_uri(request.person_rgb),
                "garm_img": _data_uri(request.layers[0].cutout_rgba),
                "category": request.layers[0].role,
                "seed": request.seed,
                **request.params,
            }
        }
        if self.webhook_url:
            payload["webhook"] = self.webhook_url
            payload["webhook_events_filter"] = ["completed"]

        with httpx.Client(timeout=self.timeout) as client:
            r = client.post(self.endpoint, json=payload,
                            headers={"Authorization": f"Bearer {self.api_token}"})
            r.raise_for_status()
            return r.json()["id"]

    def fetch_result(self, provider_job_id: str) -> RenderResult | None:
        import httpx
        from PIL import Image

        started = time.perf_counter()
        with httpx.Client(timeout=self.timeout) as client:
            r = client.get(f"{self.endpoint}/{provider_job_id}",
                           headers={"Authorization": f"Bearer {self.api_token}"})
            r.raise_for_status()
            body = r.json()
            if body.get("status") != "succeeded":
                return None
            image = client.get(body["output"]).content

        return RenderResult(
            image_rgb=np.asarray(Image.open(io.BytesIO(image)).convert("RGB"), dtype=np.uint8),
            provider=self.provider, model_id=self.model_id,
            duration_ms=int((time.perf_counter() - started) * 1000),
            cost_usd=float(body.get("metrics", {}).get("predict_time", 0)) * 0.0014,
            metadata={"provider_job_id": provider_job_id},
        )

    def render(self, request: RenderRequest) -> RenderResult:
        raise NotImplementedError("hosted providers are asynchronous: use submit()")


def _data_uri(array: np.ndarray) -> str:
    from PIL import Image

    mode = "RGBA" if array.shape[-1] == 4 else "RGB"
    buf = io.BytesIO()
    Image.fromarray(array, mode=mode).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
