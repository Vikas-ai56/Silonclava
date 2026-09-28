from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .domain import ConnectionState

ToolkitSlug = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z][a-z0-9_-]{0,63}$", strip_whitespace=True),
]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolkitSchema(Schema):
    slug: str
    name: str
    description: str
    logo_url: str | None = None


class ToolSchema(Schema):
    slug: str
    name: str
    description: str


class ConnectionSchema(Schema):
    toolkit: str
    connected: bool
    status: ConnectionState | None = None
    connection_id: str | None = None
    account: str | None = None
    display_name: str | None = None


class ConnectResponse(Schema):
    connection_id: str
    redirect_url: str


class ResolveRequest(Schema):
    toolkits: Annotated[list[ToolkitSlug], Field(min_length=1, max_length=50)]


class McpServerSchema(Schema):
    type: Literal["http"] = "http"
    url: str
    headers: dict[str, str] | None = None


class ResolveResponse(Schema):
    servers: dict[str, McpServerSchema]
