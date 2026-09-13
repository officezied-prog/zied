"""RFC 9457 problem+json error handling."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_BASE = "https://api.smartstylist.app/problems"
CONTENT_TYPE = "application/problem+json"


class ProblemError(Exception):
    """Domain error that renders as an RFC 9457 problem document."""

    def __init__(
        self,
        *,
        status_code: int,
        title: str,
        detail: str,
        problem_type: str,
        **extra: Any,
    ) -> None:
        self.status_code = status_code
        self.title = title
        self.detail = detail
        self.problem_type = f"{PROBLEM_BASE}/{problem_type}"
        self.extra = extra
        super().__init__(detail)

    def to_dict(self, instance: str, trace_id: str | None) -> dict[str, Any]:
        body = {
            "type": self.problem_type,
            "title": self.title,
            "status": self.status_code,
            "detail": self.detail,
            "instance": instance,
        }
        if trace_id:
            body["trace_id"] = trace_id
        body.update(self.extra)
        return body


# ── Concrete problems the API raises ────────────────────────────────────────
class NotAuthenticated(ProblemError):
    def __init__(self, detail: str = "A valid bearer token is required.") -> None:
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            title="Unauthorized", detail=detail, problem_type="unauthorized",
        )


class NotFound(ProblemError):
    def __init__(self, resource: str, resource_id: str | None = None) -> None:
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            title="Not found",
            detail=f"{resource} {resource_id or ''}".strip() + " does not exist.",
            problem_type="not-found",
        )


class ConsentRequired(ProblemError):
    def __init__(self, consent_type: str) -> None:
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            title="Consent required",
            detail=f"{consent_type} consent is required for this operation.",
            problem_type="consent-required",
            required_consent=consent_type,
        )


class QuotaExceeded(ProblemError):
    def __init__(self, metric: str) -> None:
        super().__init__(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            title="Quota exceeded",
            detail=f"Monthly {metric} quota is exhausted.",
            problem_type="quota-exceeded",
            metric=metric,
        )


class Conflict(ProblemError):
    def __init__(self, detail: str) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            title="Conflict", detail=detail, problem_type="conflict",
        )


class InvalidRequest(ProblemError):
    def __init__(self, detail: str, **extra: Any) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            title="Invalid request", detail=detail,
            problem_type="invalid-request", **extra,
        )


def install_error_handlers(app: FastAPI) -> None:
    def _trace_id(request: Request) -> str | None:
        return request.headers.get("x-request-id") or getattr(request.state, "trace_id", None)

    @app.exception_handler(ProblemError)
    async def _problem(request: Request, exc: ProblemError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_dict(str(request.url.path), _trace_id(request)),
            media_type=CONTENT_TYPE,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "type": f"{PROBLEM_BASE}/http-error",
                "title": "Request failed",
                "status": exc.status_code,
                "detail": str(exc.detail),
                "instance": str(request.url.path),
                "trace_id": _trace_id(request),
            },
            media_type=CONTENT_TYPE,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,  # Unprocessable Content
            content={
                "type": f"{PROBLEM_BASE}/validation-error",
                "title": "Validation failed",
                "status": 422,
                "detail": "One or more fields are invalid.",
                "instance": str(request.url.path),
                "trace_id": _trace_id(request),
                "errors": [
                    {"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]}
                    for e in exc.errors()
                ],
            },
            media_type=CONTENT_TYPE,
        )
