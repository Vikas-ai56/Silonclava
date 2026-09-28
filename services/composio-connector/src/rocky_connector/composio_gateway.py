"""Minimal Composio adapter extracted from iRock's connector backend.

Modified for Rocky: no direct tool execution, triggers, desktop identity, or API-key connectors;
one active/pending account per toolkit; one combined MCP session per tenant.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

import anyio

from .config import ToolkitRegistry
from .domain import (
    AlreadyConnected,
    Connection,
    ConnectionNotFound,
    ConnectorError,
    ConnectionState,
    ConnectionStatus,
    McpEndpoint,
    Tool,
    Toolkit,
    ToolkitNotFound,
    TooManyAccounts,
    UpstreamFailure,
    UpstreamTimeout,
)

T = TypeVar("T")
_MISSING = object()
_MAX_TOOLS = 500
_PENDING_STATES = {
    ConnectionState.initializing,
    ConnectionState.initiated,
}


def _field(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
            continue
        value = getattr(obj, name, _MISSING)
        if value is not _MISSING and not callable(value):
            return value
    return default


def _toolkit_slug(obj: Any) -> str:
    toolkit = _field(obj, "toolkit", "toolkit_slug")
    return str(_field(toolkit, "slug", default=toolkit) or "")


def _state(value: Any) -> ConnectionState | None:
    if value is None:
        return None
    try:
        return ConnectionState(str(value).upper())
    except ValueError:
        return None


def _disabled(item: Any) -> bool:
    return bool(_field(item, "is_disabled", "disabled", default=False))


class ComposioGateway:
    def __init__(
        self,
        *,
        api_key: str,
        registry: ToolkitRegistry,
        callback_url: str,
        base_url: str | None = None,
        timeout_seconds: float = 10.0,
        max_retries: int = 2,
        max_accounts: int = 5,
        client: Any = None,
    ) -> None:
        self._api_key = api_key
        self._registry = registry
        self._callback_url = callback_url
        self._base_url = base_url
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._max_accounts = max_accounts
        self._client = client
        self._connect_locks: dict[tuple[str, str], asyncio.Lock] = {}

    def _registry_auth_config_id(self, toolkit: str) -> str:
        """The org registry may pin `authConfigId` per toolkit to control scopes."""
        return self._registry.auth_config_id(toolkit)

    @staticmethod
    def scope(tenant_id: str) -> str:
        """Stable per-tenant Composio account scope."""
        return f"acct:{tenant_id}"

    def _assert_allowed(self, toolkit: str) -> None:
        if not self._registry.contains(toolkit):
            raise ToolkitNotFound(toolkit)

    def _sdk(self) -> Any:
        if self._client is None:
            try:
                from composio import Composio
            except ImportError as exc:  # pragma: no cover
                raise UpstreamFailure("Composio SDK is unavailable.") from exc
            kwargs: dict[str, Any] = {"api_key": self._api_key}
            if self._base_url:
                kwargs["base_url"] = self._base_url
            self._client = Composio(**kwargs)
        return self._client

    async def _call(self, description: str, fn: Callable[[], T], *, retry: bool) -> T:
        attempts = self._max_retries + 1 if retry else 1
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                with anyio.fail_after(self._timeout):
                    return await anyio.to_thread.run_sync(fn, abandon_on_cancel=True)
            except TimeoutError as exc:
                raise UpstreamTimeout() from exc
            except ConnectorError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        raise UpstreamFailure(f"Composio {description} failed.") from last_error

    async def list_toolkits(self) -> list[Toolkit]:
        def work() -> list[Toolkit]:
            client = self._sdk()
            result: list[Toolkit] = []
            for slug in self._registry.slugs:
                try:
                    item = client.toolkits.get(slug=slug)
                except Exception:  # noqa: BLE001, S112 -- degrade one catalogue entry
                    continue
                meta = _field(item, "meta")
                result.append(
                    Toolkit(
                        slug=str(_field(item, "slug", default=slug) or slug),
                        name=str(_field(item, "name", "display_name", default=slug)),
                        description=str(_field(meta, "description", default="")),
                        logo_url=_field(meta, "logo", "logo_url"),
                    )
                )
            return result

        return await self._call("toolkit lookup", work, retry=True)

    async def list_tools(self, toolkit: str) -> list[Tool]:
        self._assert_allowed(toolkit)

        def work() -> list[Tool]:
            raw = self._sdk().tools.get_raw_composio_tools(toolkits=[toolkit], limit=_MAX_TOOLS)
            return [
                Tool(
                    slug=str(_field(item, "slug", "name", default="")),
                    name=str(_field(item, "name", "display_name", default="")),
                    description=str(_field(item, "description", default="")),
                )
                for item in (raw or [])
            ]

        return await self._call(f"tools lookup for '{toolkit}'", work, retry=True)

    async def list_connections(self, tenant_id: str) -> list[ConnectionStatus]:
        def work() -> list[ConnectionStatus]:
            raw = self._sdk().connected_accounts.list(user_ids=[self.scope(tenant_id)])
            result: list[ConnectionStatus] = []
            for item in _field(raw, "items", default=raw) or []:
                toolkit = _toolkit_slug(item)
                if not self._registry.contains(toolkit):
                    continue
                state = _state(_field(item, "status"))
                data = _field(item, "data") or {}
                result.append(
                    ConnectionStatus(
                        toolkit=toolkit,
                        connected=state is ConnectionState.active and not _disabled(item),
                        status=state,
                        connection_id=str(_field(item, "id", "connected_account_id") or "") or None,
                        account=str(
                            _field(item, "alias") or _field(item, "word_id") or ""
                        )
                        or None,
                        display_name=str(_field(data, "displayName", "display_name") or "")
                        or None,
                    )
                )
            return result

        return await self._call("connections lookup", work, retry=True)

    async def connect(self, tenant_id: str, toolkit: str) -> Connection:
        self._assert_allowed(toolkit)
        lock = self._connect_locks.setdefault((tenant_id, toolkit), asyncio.Lock())
        async with lock:
            connections = [
                item for item in await self.list_connections(tenant_id)
                if item.toolkit == toolkit
            ]
            if any(item.status in _PENDING_STATES for item in connections):
                raise AlreadyConnected(toolkit)
            if len(connections) >= self._max_accounts:
                raise TooManyAccounts(toolkit, self._max_accounts)

            def work() -> Connection:
                client = self._sdk()

                # An auth config decides the OAuth scopes on the consent screen.
                # Picking "the first OAUTH2 one we find" means Composio's shared
                # managed app, which for Gmail asks for People API scopes the
                # user has no reason to grant — date of birth, home address,
                # contacts. When the registry pins an id we use exactly that one
                # and fail loudly if it is missing, rather than silently falling
                # back to the broad default.
                pinned = self._registry_auth_config_id(toolkit)
                if pinned:
                    auth_id = pinned
                else:
                    auth_configs = client.auth_configs.list()
                    auth_id = ""
                    for config in _field(auth_configs, "items", default=auth_configs) or []:
                        if _toolkit_slug(config) != toolkit:
                            continue
                        scheme = str(_field(config, "auth_scheme") or "").upper()
                        if scheme in {"", "OAUTH2"}:
                            auth_id = str(_field(config, "id") or "")
                            if scheme == "OAUTH2":
                                break
                if not auth_id:
                    raise UpstreamFailure(f"No OAuth configuration exists for '{toolkit}'.")
                # Composio retired the legacy managed-OAuth initiate endpoint in July 2026.
                # `link` is its supported Connect-Link replacement and keeps the same result shape.
                connected = client.connected_accounts.link(
                    user_id=self.scope(tenant_id),
                    auth_config_id=auth_id,
                    callback_url=self._callback_url,
                    allow_multiple=True,
                )
                result = Connection(
                    connection_id=str(_field(connected, "id", "connection_id") or ""),
                    redirect_url=str(_field(connected, "redirect_url", "redirectUrl") or ""),
                )
                if not result.connection_id or not result.redirect_url:
                    raise UpstreamFailure("Composio returned an incomplete Connect Link.")
                return result

            return await self._call(f"connect for '{toolkit}'", work, retry=False)

    async def disconnect(
        self, tenant_id: str, toolkit: str, connection_id: str | None = None
    ) -> None:
        self._assert_allowed(toolkit)

        def work() -> None:
            client = self._sdk()
            raw = client.connected_accounts.list(user_ids=[self.scope(tenant_id)])
            matched = False
            for item in _field(raw, "items", default=raw) or []:
                if _toolkit_slug(item) != toolkit:
                    continue
                item_id = _field(item, "id", "connected_account_id")
                if connection_id and str(item_id) != connection_id:
                    continue
                client.connected_accounts.delete(item_id)
                matched = True
            if connection_id and not matched:
                raise ConnectionNotFound(connection_id)

        await self._call(f"disconnect for '{toolkit}'", work, retry=False)

    async def resolve_mcp(self, tenant_id: str, requested: list[str]) -> McpEndpoint | None:
        for toolkit in requested:
            self._assert_allowed(toolkit)
        active = {
            item.toolkit
            for item in await self.list_connections(tenant_id)
            if item.connected and item.status is ConnectionState.active
        }
        selected = list(dict.fromkeys(item for item in requested if item in active))
        if not selected:
            return None

        def work() -> McpEndpoint:
            session = self._sdk().sessions.create(
                user_id=self.scope(tenant_id),
                toolkits=selected,
                mcp=True,
                multi_account={
                    "enable": True,
                    "max_accounts_per_toolkit": self._max_accounts,
                    "require_explicit_selection": True,
                },
            )
            mcp = _field(session, "mcp")
            url = str(_field(mcp, "url") or "")
            if not url:
                raise UpstreamFailure("Composio returned no MCP endpoint.")
            raw_headers = _field(mcp, "headers") or {}
            headers = {
                str(key): str(value)
                for key, value in dict(raw_headers).items()
                if value is not None
            }
            return McpEndpoint("composio", url, headers or None)

        return await self._call("combined MCP resolution", work, retry=False)
