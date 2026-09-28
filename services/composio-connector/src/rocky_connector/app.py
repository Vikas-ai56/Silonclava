from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .composio_gateway import ComposioGateway
from .config import Settings, get_settings
from .domain import ConnectorError
from .identity import AssertionVerifier, InvalidAssertion, ServicePrincipal
from .schemas import (
    ConnectionSchema,
    ConnectResponse,
    McpServerSchema,
    ResolveRequest,
    ResolveResponse,
    ToolkitSchema,
    ToolSchema,
)
from .service import ConnectorService
from .store import PostgresOperationStore

SERVICE_ID = "rocky-composio-connector"


def _bearer(value: str | None) -> str:
    scheme, _, token = str(value or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise InvalidAssertion("Missing connector service assertion.")
    return token


def create_app(
    *,
    service: ConnectorService | None = None,
    verifier: AssertionVerifier | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    injected = service is not None and verifier is not None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not injected:
            active = settings or get_settings()
            registry = active.read_registry()
            store = await PostgresOperationStore.open(active.database_url)
            gateway = ComposioGateway(
                api_key=active.read_project_key(),
                registry=registry,
                callback_url=active.callback_url,
                base_url=active.composio_base_url,
                timeout_seconds=active.composio_timeout_seconds,
                max_retries=active.composio_max_retries,
            )
            app.state.service = ConnectorService(
                gateway=gateway,
                store=store,
                registry=registry,
                mcp_allowed_hosts=active.mcp_allowed_hosts,
            )
            app.state.verifier = AssertionVerifier(
                public_key_pem=active.read_public_key(),
                issuer=active.service_issuer,
                audience=active.service_audience,
                org_id=active.enterprise_org_id,
                max_ttl_seconds=active.assertion_max_ttl_seconds,
            )
            app.state.operation_store = store
        yield
        operation_store = getattr(app.state, "operation_store", None)
        if operation_store is not None:
            await operation_store.close()

    app = FastAPI(
        title="Rocky Composio connector",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    if injected:
        app.state.service = service
        app.state.verifier = verifier

    async def principal(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> ServicePrincipal:
        return await request.app.state.verifier.verify(_bearer(authorization))

    def connector_service(request: Request) -> ConnectorService:
        return request.app.state.service

    @app.exception_handler(ConnectorError)
    async def connector_error(_: Request, exc: ConnectorError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(Exception)
    async def internal_error(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "internal_error", "message": "Connector request failed."}},
        )

    @app.get("/health")
    async def health() -> dict[str, object]:
        # The identifier is load-bearing: a bare {"ok": true} is indistinguishable
        # from any other service on the port, and Rocky spent a day reporting
        # "composio sidecar: healthy" while probing an unrelated backend that
        # happened to own 4317.
        return {"ok": True, "service": SERVICE_ID}

    @app.get("/api/v1/toolkits", response_model=list[ToolkitSchema])
    async def available(
        _: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
    ) -> Any:
        return await svc.available()

    @app.get("/api/v1/toolkits/{toolkit}/tools", response_model=list[ToolSchema])
    async def tools(
        toolkit: str,
        _: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
    ) -> Any:
        return await svc.tools(toolkit)

    @app.get("/api/v1/connections", response_model=list[ConnectionSchema])
    async def connections(
        actor: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
    ) -> Any:
        return await svc.connections(actor.tenant_id)

    @app.post(
        "/api/v1/toolkits/{toolkit}/connections",
        response_model=ConnectResponse,
        status_code=201,
    )
    async def connect(
        toolkit: str,
        actor: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        if not idempotency_key or len(idempotency_key) > 200:
            from .domain import IdempotencyConflict

            raise IdempotencyConflict("A bounded Idempotency-Key is required.")
        return await svc.connect(
            tenant_id=actor.tenant_id,
            org_id=actor.org_id,
            toolkit=toolkit,
            idempotency_key=idempotency_key,
        )

    @app.delete("/api/v1/toolkits/{toolkit}/connections", status_code=204)
    async def disconnect(
        toolkit: str,
        connection_id: str | None = None,
        actor: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
    ) -> None:
        await svc.disconnect(
            tenant_id=actor.tenant_id,
            org_id=actor.org_id,
            toolkit=toolkit,
            connection_id=connection_id,
        )

    @app.post("/api/v1/mcp/resolve", response_model=ResolveResponse)
    async def resolve(
        body: ResolveRequest,
        actor: ServicePrincipal = Depends(principal),
        svc: ConnectorService = Depends(connector_service),
    ) -> ResolveResponse:
        endpoint = await svc.resolve(
            tenant_id=actor.tenant_id,
            org_id=actor.org_id,
            toolkits=body.toolkits,
        )
        if endpoint is None:
            return ResolveResponse(servers={})
        return ResolveResponse(
            servers={"composio": McpServerSchema(url=endpoint.url, headers=endpoint.headers)}
        )

    @app.get("/api/v1/connectors/callback", response_class=HTMLResponse)
    async def callback() -> str:
        return (
            "<h1>Connection received</h1><p>You may close this window and return to WhatsApp.</p>"
        )

    return app


app = create_app()
