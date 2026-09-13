from .base import GarmentLayer, RenderRequest, RenderResult, VtonProvider
from .composite import CompositeProvider

__all__ = [
    "CompositeProvider",
    "GarmentLayer",
    "RenderRequest",
    "RenderResult",
    "VtonProvider",
    "build_provider",
]


def build_provider(model_id: str, config: dict | None = None) -> VtonProvider:
    config = config or {}
    if model_id in ("composite@1", "mock@1"):
        return CompositeProvider()
    if config.get("provider") in ("replicate", "fal"):
        from .hosted import HostedVtonProvider

        return HostedVtonProvider(model_id=model_id, endpoint=config["endpoint"],
                                  api_token=config["api_token"],
                                  webhook_url=config.get("webhook_url"))
    from .diffusion import DiffusionVtonProvider

    return DiffusionVtonProvider(model_id=model_id,
                                 checkpoint=config.get("checkpoint", model_id),
                                 device=config.get("device", "cuda"),
                                 steps=config.get("steps", 30),
                                 guidance=config.get("guidance", 2.0))
