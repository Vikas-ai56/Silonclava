from __future__ import annotations

from typing import Protocol

from .domain import Connection, ConnectionStatus, McpEndpoint, Tool, Toolkit


class ConnectorGateway(Protocol):
    async def list_toolkits(self) -> list[Toolkit]: ...

    async def list_tools(self, toolkit: str) -> list[Tool]: ...

    async def list_connections(self, tenant_id: str) -> list[ConnectionStatus]: ...

    async def connect(self, tenant_id: str, toolkit: str) -> Connection: ...

    async def disconnect(self, tenant_id: str, toolkit: str) -> None: ...

    async def resolve_mcp(self, tenant_id: str, requested: list[str]) -> McpEndpoint | None: ...


class OperationStore(Protocol):
    async def claim(self, key: str, fingerprint: str) -> tuple[str, dict[str, object] | None]: ...

    async def complete(self, key: str, result: dict[str, object]) -> None: ...

    async def fail(self, key: str) -> None: ...

    async def audit(
        self,
        *,
        tenant_id: str,
        org_id: str,
        action: str,
        toolkit: str | None,
        outcome: str,
    ) -> None: ...
