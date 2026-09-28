from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from .domain import IdempotencyConflict


def opaque_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class MemoryOperationStore:
    """Test/local port implementation with the same claim semantics as Postgres."""

    def __init__(self) -> None:
        self.rows: dict[str, tuple[str, str, dict[str, object] | None]] = {}
        self.events: list[dict[str, str | None]] = []
        self._lock = asyncio.Lock()

    async def claim(self, key: str, fingerprint: str) -> tuple[str, dict[str, object] | None]:
        async with self._lock:
            current = self.rows.get(key)
            if current:
                stored_fingerprint, state, result = current
                if stored_fingerprint != fingerprint:
                    raise IdempotencyConflict("Idempotency key was reused for another operation.")
                return state, result
            self.rows[key] = (fingerprint, "pending", None)
            return "owner", None

    async def complete(self, key: str, result: dict[str, object]) -> None:
        async with self._lock:
            fingerprint, _, _ = self.rows[key]
            self.rows[key] = (fingerprint, "complete", result)

    async def fail(self, key: str) -> None:
        async with self._lock:
            self.rows.pop(key, None)

    async def audit(
        self,
        *,
        tenant_id: str,
        org_id: str,
        action: str,
        toolkit: str | None,
        outcome: str,
    ) -> None:
        self.events.append(
            {
                "tenant_id": tenant_id,
                "org_id": org_id,
                "action": action,
                "toolkit": toolkit,
                "outcome": outcome,
            }
        )


class PostgresOperationStore:
    """Small operational store. It contains no provider token or MCP credential."""

    def __init__(self, pool: asyncpg.Pool[Any]) -> None:
        self._pool = pool

    @classmethod
    async def open(cls, database_url: str) -> PostgresOperationStore:
        pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4)
        store = cls(pool)
        await store._initialize()
        return store

    async def close(self) -> None:
        await self._pool.close()

    async def _initialize(self) -> None:
        async with self._pool.acquire() as connection:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS connector_idempotency (
                    key_hash TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL,
                    result JSONB,
                    expires_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS connector_audit (
                    id BIGSERIAL PRIMARY KEY,
                    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    tenant_id TEXT NOT NULL,
                    org_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    toolkit TEXT,
                    outcome TEXT NOT NULL
                );
                """
            )

    async def claim(self, key: str, fingerprint: str) -> tuple[str, dict[str, object] | None]:
        key_hash = opaque_key(key)
        now = datetime.now(UTC)
        expires_at = now + timedelta(minutes=10)
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "DELETE FROM connector_idempotency WHERE key_hash = $1 AND expires_at <= $2",
                    key_hash,
                    now,
                )
                inserted = await connection.fetchval(
                    """
                    INSERT INTO connector_idempotency
                        (key_hash, fingerprint, state, expires_at)
                    VALUES ($1, $2, 'pending', $3)
                    ON CONFLICT (key_hash) DO NOTHING
                    RETURNING key_hash
                    """,
                    key_hash,
                    fingerprint,
                    expires_at,
                )
                if inserted:
                    return "owner", None
                row = await connection.fetchrow(
                    """
                    SELECT fingerprint, state, result
                    FROM connector_idempotency
                    WHERE key_hash = $1
                    """,
                    key_hash,
                )
                if row is None:
                    raise IdempotencyConflict()
                if row["fingerprint"] != fingerprint:
                    raise IdempotencyConflict("Idempotency key was reused for another operation.")
                result = row["result"]
                if isinstance(result, str):
                    result = json.loads(result)
                return str(row["state"]), dict(result) if result is not None else None

    async def complete(self, key: str, result: dict[str, object]) -> None:
        await self._pool.execute(
            """
            UPDATE connector_idempotency
            SET state = 'complete', result = $2::jsonb, updated_at = NOW(),
                expires_at = NOW() + INTERVAL '24 hours'
            WHERE key_hash = $1 AND state = 'pending'
            """,
            opaque_key(key),
            json.dumps(result),
        )

    async def fail(self, key: str) -> None:
        await self._pool.execute(
            "DELETE FROM connector_idempotency WHERE key_hash = $1 AND state = 'pending'",
            opaque_key(key),
        )

    async def audit(
        self,
        *,
        tenant_id: str,
        org_id: str,
        action: str,
        toolkit: str | None,
        outcome: str,
    ) -> None:
        await self._pool.execute(
            """
            INSERT INTO connector_audit (tenant_id, org_id, action, toolkit, outcome)
            VALUES ($1, $2, $3, $4, $5)
            """,
            tenant_id,
            org_id,
            action,
            toolkit,
            outcome,
        )
