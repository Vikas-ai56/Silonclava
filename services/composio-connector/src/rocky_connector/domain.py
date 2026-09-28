from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class ConnectionState(StrEnum):
    initializing = "INITIALIZING"
    initiated = "INITIATED"
    active = "ACTIVE"
    failed = "FAILED"
    expired = "EXPIRED"
    inactive = "INACTIVE"
    revoked = "REVOKED"


@dataclass(frozen=True, slots=True)
class Connection:
    connection_id: str
    redirect_url: str


@dataclass(frozen=True, slots=True)
class ConnectionStatus:
    toolkit: str
    connected: bool
    status: ConnectionState | None
    connection_id: str | None
    account: str | None = None
    display_name: str | None = None


@dataclass(frozen=True, slots=True)
class Toolkit:
    slug: str
    name: str
    description: str
    logo_url: str | None


@dataclass(frozen=True, slots=True)
class Tool:
    slug: str
    name: str
    description: str


@dataclass(frozen=True, slots=True)
class McpEndpoint:
    name: str
    url: str
    headers: dict[str, str] | None


class ConnectorError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class NotConfigured(ConnectorError):
    def __init__(self, message: str = "Connector service is not configured.") -> None:
        super().__init__(503, "connectors.not_configured", message)


class ToolkitNotFound(ConnectorError):
    def __init__(self, slug: str) -> None:
        super().__init__(404, "connectors.not_found", f"Unknown or disabled toolkit '{slug}'.")


class AlreadyConnected(ConnectorError):
    def __init__(self, slug: str) -> None:
        super().__init__(
            409,
            "connectors.already_connected",
            f"'{slug}' has an authorization already in progress.",
        )


class TooManyAccounts(ConnectorError):
    def __init__(self, slug: str, limit: int) -> None:
        super().__init__(
            409,
            "connectors.too_many_accounts",
            f"'{slug}' already has {limit} connected accounts.",
        )


class ConnectionNotFound(ConnectorError):
    def __init__(self, connection_id: str) -> None:
        super().__init__(
            404,
            "connectors.connection_not_found",
            f"No connected account '{connection_id}'.",
        )


class UpstreamFailure(ConnectorError):
    def __init__(self, message: str = "Composio request failed.") -> None:
        super().__init__(502, "connectors.upstream_failure", message)


class UpstreamTimeout(ConnectorError):
    def __init__(self) -> None:
        super().__init__(504, "connectors.upstream_timeout", "Composio request timed out.")


class UnsafeMcpEndpoint(ConnectorError):
    def __init__(self) -> None:
        super().__init__(
            502,
            "connectors.unsafe_mcp_endpoint",
            "Composio returned an unsafe MCP endpoint.",
        )


class IdempotencyConflict(ConnectorError):
    def __init__(self, message: str = "The request is already in progress.") -> None:
        super().__init__(409, "connectors.idempotency_conflict", message)
