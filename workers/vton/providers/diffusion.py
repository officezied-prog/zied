"""Self-hosted diffusion try-on (IDM-VTON / CatVTON class models).

Lazy-loaded: the API image never imports torch. One garment per pass — the
pipeline chains passes for layered looks.

Licence gate: `vton_models.commercial_ok` decides whether a checkpoint may serve
paying traffic. The router reads it; this class does not second-guess it, but it
records `model_id` on every render so an audit can answer "which model produced
this image".
"""
from __future__ import annotations

import time
from typing import Any

import numpy as np

from .base import RenderRequest, RenderResult


class DiffusionVtonProvider:
    provider = "internal_gpu"
    supports_multi_garment = False

    def __init__(self, model_id: str, checkpoint: str, *, device: str = "cuda",
                 steps: int = 30, guidance: float = 2.0) -> None:
        self.model_id = model_id
        self.checkpoint = checkpoint
        self.device = device
        self.steps = steps
        self.guidance = guidance
        self._pipe: Any | None = None

    def _load(self):
        if self._pipe is None:
            import torch
            from diffusers import StableDiffusionInpaintPipeline

            self._pipe = StableDiffusionInpaintPipeline.from_pretrained(
                self.checkpoint, torch_dtype=torch.float16).to(self.device)
            self._pipe.set_progress_bar_config(disable=True)
            self._torch = torch
        return self._pipe

    def render(self, request: RenderRequest) -> RenderResult:
        if len(request.layers) != 1:
            raise ValueError(f"{self.model_id} renders one garment per pass")

        started = time.perf_counter()
        pipe = self._load()
        from PIL import Image

        from ..preprocess import zone_for_role

        h, w = request.person_rgb.shape[:2]
        layer = request.layers[0]
        x, y, zw, zh = request.zones.pixel_box(zone_for_role(layer.role), w, h)

        # Cloth-agnostic mask: the region the model is allowed to repaint. The
        # head is excluded so identity cannot drift.
        inpaint = np.zeros((h, w), dtype=np.uint8)
        inpaint[y:y + zh, x:x + zw] = 255
        if request.preserve_face:
            fx, fy, fw, fh = request.zones.pixel_box("head", w, h)
            inpaint[fy:fy + fh, fx:fx + fw] = 0

        generator = self._torch.Generator(device=self.device).manual_seed(request.seed)
        output = pipe(
            prompt=f"a person wearing {layer.category or layer.role}",
            image=Image.fromarray(request.person_rgb),
            mask_image=Image.fromarray(inpaint),
            num_inference_steps=request.params.get("steps", self.steps),
            guidance_scale=request.params.get("guidance", self.guidance),
            generator=generator,
        ).images[0]

        return RenderResult(
            image_rgb=np.asarray(output.convert("RGB"), dtype=np.uint8),
            provider=self.provider, model_id=self.model_id,
            duration_ms=int((time.perf_counter() - started) * 1000),
            cost_usd=0.0,
            metadata={"steps": self.steps, "seed": request.seed},
        )
