from __future__ import annotations

from dataclasses import dataclass

import pytest

from rocky_connector.config import ToolkitRegistry
from rocky_connector.domain import Connection, ConnectionStatus, McpEndpoint
from rocky_connector.service import ConnectorService
from rocky_connector.store import MemoryOperationStore


@dataclass
class FakeGateway:
    connect_calls: int = 0

    async def list_toolkits(self):
        return []

    async def list_tools(self, toolkit):
        return []

    async def list_connections(self, tenant_id):
        return [ConnectionStatus("gmail", True, None, f"connection-{tenant_id}")]

    async def connect(self, tenant_id, toolkit):
        self.connect_calls += 1
        return Connection(f"{tenant_id}-{toolkit}", "https://connect.example/once")

    async def disconnect(self, tenant_id, toolkit):
        return None

    async def resolve_mcp(self, tenant_id, requested):
        return McpEndpoint(
            "composio",
            f"https://mcp.composio.dev/{tenant_id}",
            {"Authorization": f"Bearer {tenant_id}"},
        )


def service(gateway=None, store=None, hosts=None):
    return ConnectorService(
        gateway=gateway or FakeGateway(),
        store=store or MemoryOperationStore(),
        registry=ToolkitRegistry(("gmail", "asana")),
        mcp_allowed_hosts=hosts or ["mcp.composio.dev"],
    )


@pytest.mark.asyncio
async def test_connect_idempotency_replays_without_second_vendor_call():
    gateway = FakeGateway()
    svc = service(gateway=gateway)
    first = await svc.connect(
        tenant_id="tenant-a", org_id="org-a", toolkit="gmail", idempotency_key="same"
    )
    second = await svc.connect(
        tenant_id="tenant-a", org_id="org-a", toolkit="gmail", idempotency_key="same"
    )
    assert first == second
    assert gateway.connect_calls == 1


@pytest.mark.asyncio
async def test_mcp_resolution_is_tenant_scoped():
    a = await service().resolve(tenant_id="tenant-a", org_id="org-a", toolkits=["gmail"])
    b = await service().resolve(tenant_id="tenant-b", org_id="org-a", toolkits=["gmail"])
    assert a is not None and b is not None
    assert a.url != b.url
    assert a.headers != b.headers


@pytest.mark.asyncio
async def test_mcp_resolution_rejects_untrusted_host():
    with pytest.raises(Exception, match="unsafe"):
        await service(hosts=["different.example"]).resolve(
            tenant_id="tenant-a", org_id="org-a", toolkits=["gmail"]
        )
