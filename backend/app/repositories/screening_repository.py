"""Screening persistence: assignments and the decisions that freeze the config.

Every read takes ``project_id`` as a required keyword, and every
assignment-to-article join goes through :data:`ARTICLE_STILL_IN_PROJECT`.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import Select, and_, exists, func, literal, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article
from app.models.screening import SCREENING_PHASE, ScreeningAssignment, ScreeningDecision

# THE assignment-to-article join condition. Members can move an article to
# another project through PostgREST and nothing binds an assignment's
# project_id to the article's current project, so a moved article must read as
# missing. Use it as a ``.join(Article, ...)`` onclause only, never in ``.where``.
ARTICLE_STILL_IN_PROJECT = and_(
    Article.id == ScreeningAssignment.article_id,
    Article.project_id == ScreeningAssignment.project_id,
)


def live_assignments(project_id: UUID) -> Select[tuple[ScreeningAssignment]]:
    """The project's title/abstract assignments whose article is still in the project."""
    return (
        select(ScreeningAssignment)
        .join(Article, ARTICLE_STILL_IN_PROJECT)
        .where(
            ScreeningAssignment.project_id == project_id,
            ScreeningAssignment.phase == SCREENING_PHASE,
        )
    )


class ScreeningRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def enroll(
        self, *, project_id: UUID, enrolled_by: UUID, article_ids: Sequence[UUID] | None
    ) -> int:
        """Insert one assignment per article, skipping the enrolled; returns the rows inserted.

        The id is generated per row by ``gen_random_uuid()``: the model's Python
        default would render one id for every row of the INSERT ... SELECT.
        """
        source = select(
            func.gen_random_uuid(),
            Article.project_id,
            Article.id,
            literal(SCREENING_PHASE),
            literal(enrolled_by, type_=PG_UUID(as_uuid=True)),
        ).where(Article.project_id == project_id)
        if article_ids is not None:
            source = source.where(Article.id.in_(article_ids))
        stmt = (
            insert(ScreeningAssignment)
            .from_select(
                ["id", "project_id", "article_id", "phase", "enrolled_by"],
                source,
                include_defaults=False,
            )
            .on_conflict_do_nothing(index_elements=["project_id", "article_id", "phase"])
        )
        result = await self.db.execute(stmt)
        return int(result.rowcount)  # type: ignore[attr-defined]

    async def count_enrolled(self, *, project_id: UUID) -> int:
        live = live_assignments(project_id).subquery()
        return int((await self.db.execute(select(func.count()).select_from(live))).scalar_one())

    async def count_project_articles(self, *, project_id: UUID) -> int:
        stmt = select(func.count()).select_from(Article).where(Article.project_id == project_id)
        return int((await self.db.execute(stmt)).scalar_one())

    async def project_has_decision(self, *, project_id: UUID) -> bool:
        """Any decision ever recorded in the project, moved articles included."""
        stmt = select(
            exists()
            .where(ScreeningDecision.assignment_id == ScreeningAssignment.id)
            .where(ScreeningAssignment.project_id == project_id)
        )
        return bool((await self.db.execute(stmt)).scalar_one())
