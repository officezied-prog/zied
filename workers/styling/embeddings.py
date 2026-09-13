"""Garment embeddings.

Two implementations behind one interface:

* :class:`FeatureEmbedder` — deterministic, weight-free, and *meaningful*: it
  encodes the properties the stylist actually reasons about (colour in CIELAB,
  formality, warmth, pattern, role, category). Cosine similarity in this space
  behaves sensibly — two navy tailored shirts sit close, a navy shirt and orange
  shorts do not — so the taste vector genuinely learns from feedback with no
  model to serve.
* :class:`FashionClipEmbedder` — the production encoder (Marqo-FashionSigLIP /
  FashionCLIP). Same interface, same 768-d column, distinguished by the `model`
  column so the two spaces are never mixed in one query.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

import numpy as np

DIM = 768


class Embedder(Protocol):
    name: str
    version: str

    def embed(self, garment: dict) -> np.ndarray: ...


@dataclass
class FeatureEmbedder:
    name: str = "feature-v1"
    version: str = "1.0.0"

    def embed(self, garment: dict) -> np.ndarray:
        v = np.zeros(DIM, dtype=np.float32)

        # 0-5: primary colour in CIELAB, scaled to roughly unit range.
        lab = garment.get("lab") or (50.0, 0.0, 0.0)
        v[0] = lab[0] / 100.0
        v[1] = lab[1] / 128.0
        v[2] = lab[2] / 128.0
        # 3-4: hue on the unit circle, so 359° and 1° are neighbours.
        hue = float(garment.get("lch_h") or 0.0)
        chroma = float(garment.get("lch_c") or 0.0) / 128.0
        v[3] = np.cos(np.radians(hue)) * chroma
        v[4] = np.sin(np.radians(hue)) * chroma
        v[5] = 1.0 if garment.get("is_neutral") else 0.0

        # 6-8: styling scalars.
        v[6] = (float(garment.get("formality") or 3) - 1) / 4.0
        v[7] = float(garment.get("warmth") or 2) / 5.0
        v[8] = 1.0 if garment.get("is_layerable") else 0.0

        # 9-40: hashed one-hots for role, category, pattern and materials.
        for field, weight in (("role", 1.0), ("category", 0.9),
                              ("pattern", 0.6), ("brand", 0.3)):
            value = garment.get(field)
            if value:
                v[9 + self._bucket(f"{field}:{value}", 24)] += weight
        for material in (garment.get("material") or [])[:4]:
            v[33 + self._bucket(f"material:{material}", 8)] += 0.4

        norm = np.linalg.norm(v)
        return v / norm if norm else v

    @staticmethod
    def _bucket(token: str, size: int) -> int:
        return int.from_bytes(hashlib.blake2b(token.encode(), digest_size=4).digest(),
                              "big") % size


class FashionClipEmbedder:
    """Lazy-loaded transformer encoder. Not exercised in CI (no weights)."""

    name = "marqo-fashionSigLIP"

    def __init__(self, model_id: str = "Marqo/marqo-fashionSigLIP",
                 version: str = "1.0.0", device: str | None = None) -> None:
        self.model_id = model_id
        self.version = version
        self.device = device
        self._model = None
        self._processor = None

    def _load(self):
        if self._model is None:
            import torch
            from transformers import AutoModel, AutoProcessor

            self._model = AutoModel.from_pretrained(self.model_id, trust_remote_code=True)
            self._processor = AutoProcessor.from_pretrained(self.model_id, trust_remote_code=True)
            self._model.eval()
            if self.device:
                self._model.to(self.device)
            self._torch = torch
        return self._model

    def embed(self, garment: dict) -> np.ndarray:
        model = self._load()
        image = garment["image"]                       # PIL.Image of the cutout
        inputs = self._processor(images=[image], return_tensors="pt")
        if self.device:
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with self._torch.no_grad():
            feats = model.get_image_features(**inputs)
        vec = feats[0].cpu().numpy().astype(np.float32)
        norm = np.linalg.norm(vec)
        return vec / norm if norm else vec


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def update_taste_vector(current: np.ndarray | None, sample: np.ndarray,
                        *, liked: bool, alpha: float = 0.15) -> np.ndarray:
    """Exponential moving average toward liked looks, away from disliked ones.

    A dislike moves half as far as a like: users reject outfits for reasons that
    have nothing to do with taste ("wrong for the weather", "it's in the wash"),
    so a negative signal is weaker evidence than a positive one.
    """
    direction = sample if liked else -sample
    rate = alpha if liked else alpha / 2
    updated = direction * rate if current is None else current * (1 - rate) + direction * rate
    norm = np.linalg.norm(updated)
    return updated / norm if norm else updated
