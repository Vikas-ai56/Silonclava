from __future__ import annotations

from fastapi.testclient import TestClient
from test_service import FakeGateway

from rocky_connector.app import create_app
from rocky_connector.config import ToolkitRegistry
from rocky_connector.identity import AssertionVerifier
from rocky_connector.service import ConnectorService
from rocky_connector.store import MemoryOperationStore


def client(signing_material):
    _, public_key = signing_material
    gateway = FakeGateway()
    service = ConnectorService(
        gateway=gateway,
        store=MemoryOperationStore(),
        registry=ToolkitRegistry(("gmail", "asana")),
        mcp_allowed_hosts=["mcp.composio.dev"],
    )
    verifier = AssertionVerifier(
        public_key_pem=public_key,
        issuer="rocky",
        audience="connector",
        org_id="org-a",
    )
    return TestClient(create_app(service=service, verifier=verifier)), gateway


def headers(assertion, tenant="tenant-a", **extra):
    return {"Authorization": f"Bearer {assertion(tenant)}", **extra}


def test_request_identity_comes_only_from_signed_subject(signing_material, assertion):
    http, _ = client(signing_material)
    response = http.get("/api/v1/connections", headers=headers(assertion, "tenant-a"))
    assert response.status_code == 200
    assert response.json()[0]["connection_id"] == "connection-tenant-a"


def test_connect_requires_idempotency_key(signing_material, assertion):
    http, gateway = client(signing_material)
    response = http.post(
        "/api/v1/toolkits/gmail/connections", headers=headers(assertion, "tenant-a")
    )
    assert response.status_code == 409
    assert gateway.connect_calls == 0


def test_connect_and_resolve_return_narrow_shapes(signing_material, assertion):
    http, _ = client(signing_material)
    connect = http.post(
        "/api/v1/toolkits/gmail/connections",
        headers=headers(assertion, "tenant-a", **{"Idempotency-Key": "request-1"}),
    )
    assert connect.status_code == 201
    assert set(connect.json()) == {"connection_id", "redirect_url"}

    resolved = http.post(
        "/api/v1/mcp/resolve",
        headers=headers(assertion, "tenant-a"),
        json={"toolkits": ["gmail"]},
    )
    assert resolved.status_code == 200
    assert set(resolved.json()["servers"]) == {"composio"}


def test_replayed_assertion_and_body_tenant_override_are_rejected(signing_material, assertion):
    http, _ = client(signing_material)
    token = assertion("tenant-a", jti="replay")
    auth = {"Authorization": f"Bearer {token}"}
    assert http.get("/api/v1/connections", headers=auth).status_code == 200
    assert http.get("/api/v1/connections", headers=auth).status_code == 401

    extra = http.post(
        "/api/v1/mcp/resolve",
        headers=headers(assertion, "tenant-a"),
        json={"toolkits": ["gmail"], "tenant_id": "tenant-b"},
    )
    assert extra.status_code == 422
