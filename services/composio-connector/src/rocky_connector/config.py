from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


@dataclass(frozen=True, slots=True)
class ToolkitRegistry:
    slugs: tuple[str, ...]
    # Optional per-toolkit Composio auth config id. It decides the OAuth scopes
    # shown on the consent screen, so pinning it is how an organisation avoids
    # Composio's broad shared app asking for data the integration never uses.
    auth_config_ids: tuple[tuple[str, str], ...] = ()

    def contains(self, slug: str) -> bool:
        return slug in self.slugs

    def auth_config_id(self, slug: str) -> str:
        return dict(self.auth_config_ids).get(slug, "")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CONNECTOR_", extra="ignore")

    database_url: str = "postgresql://rocky_connector:rocky_connector@postgres:5432/rocky_connector"
    composio_api_key_file: Path
    registry_path: Path
    service_public_key_file: Path
    service_issuer: str = "rocky-connector-control-plane"
    service_audience: str = "irock-connector-sidecar"
    enterprise_org_id: str = "buglerock"
    assertion_max_ttl_seconds: int = 60
    callback_url: str = "http://127.0.0.1:4317/api/v1/connectors/callback"
    composio_base_url: str | None = None
    composio_timeout_seconds: float = 10.0
    composio_max_retries: int = 2
    mcp_allowed_hosts: list[str] = Field(
        default_factory=lambda: [
            "backend.composio.dev",
            "connect.composio.dev",
            "mcp.composio.dev",
        ]
    )

    @field_validator("assertion_max_ttl_seconds")
    @classmethod
    def validate_assertion_ttl(cls, value: int) -> int:
        if value < 1 or value > 60:
            raise ValueError("assertion_max_ttl_seconds must be between 1 and 60")
        return value

    def read_project_key(self) -> str:
        key = self.composio_api_key_file.read_text(encoding="utf-8").strip()
        if not key:
            raise ValueError("Composio project key file is empty")
        return key

    def read_public_key(self) -> str:
        key = self.service_public_key_file.read_text(encoding="utf-8").strip()
        if not key:
            raise ValueError("service assertion public key file is empty")
        return key

    def read_registry(self) -> ToolkitRegistry:
        raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
        if raw.get("schemaVersion") != 2 or raw.get("provider") != "composio":
            raise ValueError("registry must use schemaVersion 2 and provider composio")
        entries = raw.get("toolkits")
        if not isinstance(entries, dict) or not entries:
            raise ValueError("registry must contain toolkits")
        slugs: list[str] = []
        auth_ids: list[tuple[str, str]] = []
        for slug, entry in entries.items():
            if not isinstance(slug, str) or not slug or not isinstance(entry, dict):
                raise ValueError("registry contains an invalid toolkit")
            if entry.get("enabled") is True:
                slugs.append(slug)
                pinned = entry.get("authConfigId")
                if pinned is not None:
                    if not isinstance(pinned, str) or not pinned.strip():
                        raise ValueError(f"toolkit '{slug}' has an invalid authConfigId")
                    auth_ids.append((slug, pinned.strip()))
        if not slugs:
            raise ValueError("registry enables no toolkits")
        return ToolkitRegistry(tuple(slugs), tuple(auth_ids))


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
