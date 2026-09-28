from __future__ import annotations

import hashlib
import json
from urllib.parse import urlparse

from .config import ToolkitRegistry
from .domain import ConnectorError, IdempotencyConflict, McpEndpoint, UnsafeMcpEndpoint
from .ports import ConnectorGateway, OperationStore


def _fingerprint(action: str, tenant_id: str, toolkit: str | None) -> str:
    payload = json.dumps([action, tenant_id, toolkit], separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class ConnectorService:
    def __init__(
        self,
        *,
        gateway: ConnectorGateway,
        store: OperationStore,
        registry: ToolkitRegistry,
        mcp_allowed_hosts: list[str],
    ) -> None:
        self._gateway = gateway
        self._store = store
        self._registry = registry
        self._allowed_hosts = frozenset(host.lower() for host in mcp_allowed_hosts)

    def _allowed(self, toolkit: str) -> None:
        if not self._registry.contains(toolkit):
            from .domain import ToolkitNotFound

            raise ToolkitNotFound(toolkit)

    async def available(self):
        return await self._gateway.list_toolkits()

    async def tools(self, toolkit: str):
        self._allowed(toolkit)
        return await self._gateway.list_tools(toolkit)

    async def connections(self, tenant_id: str):
        return await self._gateway.list_connections(tenant_id)

    async def connect(
        self,
        *,
        tenant_id: str,
        org_id: str,
        toolkit: str,
        idempotency_key: str,
    ) -> dict[str, object]:
        self._allowed(toolkit)
        fingerprint = _fingerprint("connect", tenant_id, toolkit)
        state, saved = await self._store.claim(idempotency_key, fingerprint)
        if state == "complete" and saved is not None:
            return saved
        if state != "owner":
            raise IdempotencyConflict()
        try:
            connection = await self._gateway.connect(tenant_id, toolkit)
            result: dict[str, object] = {
                "connection_id": connection.connection_id,
                "redirect_url": connection.redirect_url,
            }
            await self._store.complete(idempotency_key, result)
            await self._store.audit(
                tenant_id=tenant_id,
                org_id=org_id,
                action="connect",
                toolkit=toolkit,
                outcome="started",
            )
            return result
        except Exception:
            await self._store.fail(idempotency_key)
            await self._store.audit(
                tenant_id=tenant_id,
                org_id=org_id,
                action="connect",
                toolkit=toolkit,
                outcome="failed",
            )
            raise

    async def disconnect(
        self,
        *,
        tenant_id: str,
        org_id: str,
        toolkit: str,
        connection_id: str | None = None,
    ) -> None:
        self._allowed(toolkit)
        try:
            await self._gateway.disconnect(tenant_id, toolkit, connection_id)
            outcome = "completed"
        except Exception:
            outcome = "failed"
            raise
        finally:
            await self._store.audit(
                tenant_id=tenant_id,
                org_id=org_id,
                action="disconnect",
                toolkit=toolkit,
                outcome=outcome,
            )

    async def resolve(
        self, *, tenant_id: str, org_id: str, toolkits: list[str]
    ) -> McpEndpoint | None:
        requested = list(dict.fromkeys(toolkits))
        for toolkit in requested:
            self._allowed(toolkit)
        try:
            endpoint = await self._gateway.resolve_mcp(tenant_id, requested)
            if endpoint is not None:
                self._validate_endpoint(endpoint)
            outcome = "resolved" if endpoint else "empty"
            return endpoint
        except ConnectorError:
            outcome = "failed"
            raise
        except Exception:
            outcome = "failed"
            raise
        finally:
            await self._store.audit(
                tenant_id=tenant_id,
                org_id=org_id,
                action="resolve_mcp",
                toolkit=None,
                outcome=outcome,
            )

    def _validate_endpoint(self, endpoint: McpEndpoint) -> None:
        parsed = urlparse(endpoint.url)
        if (
            endpoint.name != "composio"
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.hostname.lower() not in self._allowed_hosts
            or parsed.username
            or parsed.password
        ):
            raise UnsafeMcpEndpoint()
