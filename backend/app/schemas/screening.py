"""Title/abstract screening: project config and enrollment. snake_case on the wire."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

MAX_ENROLL_ARTICLES = 10_000


class ScreeningConfigRead(BaseModel):
    """Screening setup of a project plus the caller's roles in it."""

    reviewer_count: int | None
    reviewer_count_locked: bool
    reviewer_capable: int
    enrolled: int
    not_enrolled: int
    can_manage: bool
    can_review: bool
    can_arbitrate: bool


class ScreeningConfigUpdate(BaseModel):
    """Reviewers per record (1 to 3)."""

    model_config = ConfigDict(extra="forbid")

    reviewer_count: int = Field(ge=1, le=3)


class ScreeningEnrollRequest(BaseModel):
    """Articles to enroll; omit ``article_ids`` to enroll every article of the project."""

    model_config = ConfigDict(extra="forbid")

    article_ids: list[UUID] | None = Field(
        default=None, min_length=1, max_length=MAX_ENROLL_ARTICLES
    )


class ScreeningEnrollResult(BaseModel):
    enrolled: int
    already_enrolled: int
