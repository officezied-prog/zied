"""The implementation must not drift from the published contract.

`api/openapi/openapi.yaml` is what the mobile client and any third party build
against. If a route is added, renamed or removed without updating it, the
contract silently becomes fiction — so compare them here.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "api" / "openapi" / "openapi.yaml"

# Routes that exist only in a local/dev build and are excluded from the contract.
INTERNAL_PREFIXES = ("/_storage", "/docs", "/redoc", "/openapi.json")

# Documented but not yet implemented — each one is listed in docs/05 §"still open".
KNOWN_UNIMPLEMENTED = {
    ("get", "/v1/social/providers"),
    ("post", "/v1/social/{provider}/authorize"),
    ("get", "/v1/social/{provider}/callback"),
    ("delete", "/v1/social/{provider}"),
    ("post", "/v1/social/{provider}/sync"),
    ("post", "/webhooks/vton/{provider}"),
    ("post", "/webhooks/meta/deauthorize"),
    ("post", "/webhooks/meta/data-deletion"),
    ("get", "/v1/garments/{garmentId}/similar"),
    ("post", "/v1/me/devices"),
    ("get", "/v1/me/style-preferences"),
    ("put", "/v1/me/style-preferences"),
    ("delete", "/v1/me"),
    ("patch", "/v1/me"),
    ("get", "/v1/me/biometrics"),
    ("put", "/v1/me/biometrics"),
    ("delete", "/v1/me/biometrics"),
    ("delete", "/v1/media/{mediaId}"),
    ("get", "/v1/media/{mediaId}"),
}


def _normalise(path: str) -> str:
    """FastAPI uses `{job_id}`; the contract uses `{jobId}`. Compare shapes."""
    out, depth = [], 0
    for char in path:
        if char == "{":
            depth += 1
            out.append("{}")
        elif char == "}":
            depth -= 1
        elif depth == 0:
            out.append(char)
    return "".join(out)


@pytest.fixture(scope="module")
def contract() -> dict:
    return yaml.safe_load(CONTRACT.read_text())


@pytest.fixture(scope="module")
def implemented(app) -> set[tuple[str, str]]:
    schema = app.openapi()
    return {
        (method, _normalise(path))
        for path, item in schema["paths"].items()
        if not path.startswith(INTERNAL_PREFIXES)
        for method in item
        if method in ("get", "post", "put", "patch", "delete")
    }


def test_contract_is_valid_openapi_31(contract):
    from openapi_spec_validator import validate

    validate(contract)


def test_every_implemented_route_is_documented(contract, implemented):
    documented = {
        (method, _normalise(path))
        for path, item in contract["paths"].items()
        for method in item
        if method in ("get", "post", "put", "patch", "delete")
    }
    undocumented = sorted(implemented - documented)
    assert not undocumented, (
        "these routes are live but missing from api/openapi/openapi.yaml: "
        f"{undocumented}"
    )


def test_unimplemented_routes_are_tracked_deliberately(contract, implemented):
    """A documented-but-missing route is allowed only if it is on the known list."""
    documented = {
        (method, _normalise(path))
        for path, item in contract["paths"].items()
        for method in item
        if method in ("get", "post", "put", "patch", "delete")
    }
    known = {(m, _normalise(p)) for m, p in KNOWN_UNIMPLEMENTED}
    missing = sorted(documented - implemented - known)
    assert not missing, (
        "documented routes with no implementation and no entry in "
        f"KNOWN_UNIMPLEMENTED: {missing}"
    )


def test_no_stale_entries_in_the_known_list(contract, implemented):
    """Once a route ships, it must come off the exemption list."""
    known = {(m, _normalise(p)) for m, p in KNOWN_UNIMPLEMENTED}
    shipped = sorted(known & implemented)
    assert not shipped, f"these are implemented now — remove them from the list: {shipped}"
