"""Title/abstract screening: project config and enrollment."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps.security import require_project_manager, require_project_scope
from app.core.deps import DbSession
from app.schemas.common import ApiResponse
from app.schemas.screening import (
    ScreeningConfigRead,
    ScreeningConfigUpdate,
    ScreeningEnrollRequest,
    ScreeningEnrollResult,
)
from app.services.article_read_service import ArticleNotFoundError
from app.services.screening_config_service import ProjectNotFoundError, ScreeningConfigService
from app.utils.rate_limiter import limiter

router = APIRouter()


@router.get("/projects/{project_id}/screening/config")
@limiter.limit("60/minute")
async def get_screening_config(
    request: Request,
    project_id: UUID,
    db: DbSession,
    user_sub: UUID = Depends(require_project_scope),
) -> ApiResponse[ScreeningConfigRead]:
    config = await ScreeningConfigService(db).read(project_id, user_sub)
    return ApiResponse.success(config, trace_id=getattr(request.state, "trace_id", None))


@router.put(
    "/projects/{project_id}/screening/config",
    responses={
        404: {"description": "Project not found"},
        409: {"description": "Config frozen by a decision, or fewer reviewers than requested"},
    },
)
@limiter.limit("30/minute")
async def put_screening_config(
    request: Request,
    project_id: UUID,
    body: ScreeningConfigUpdate,
    db: DbSession,
    user_sub: UUID = Depends(require_project_manager),
) -> ApiResponse[ScreeningConfigRead]:
    try:
        config = await ScreeningConfigService(db).set_reviewer_count(
            project_id, user_sub, body.reviewer_count
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        ) from exc
    await db.commit()
    return ApiResponse.success(config, trace_id=getattr(request.state, "trace_id", None))


@router.post(
    "/projects/{project_id}/screening/enroll",
    responses={404: {"description": "An article is not in this project"}},
)
@limiter.limit("10/minute")
async def enroll_screening(
    request: Request,
    project_id: UUID,
    db: DbSession,
    body: ScreeningEnrollRequest | None = None,
    user_sub: UUID = Depends(require_project_manager),
) -> ApiResponse[ScreeningEnrollResult]:
    try:
        result = await ScreeningConfigService(db).enroll(
            project_id, user_sub, body.article_ids if body else None
        )
    except ArticleNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Article not found"
        ) from exc
    await db.commit()
    return ApiResponse.success(result, trace_id=getattr(request.state, "trace_id", None))
