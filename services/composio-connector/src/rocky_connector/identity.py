from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import ECKey

from .domain import ConnectorError

ALGORITHM = "ES256"


class InvalidAssertion(ConnectorError):
    def __init__(self, message: str = "Invalid connector service assertion.") -> None:
        super().__init__(401, "auth.invalid_service_assertion", message)


@dataclass(frozen=True, slots=True)
class ServicePrincipal:
    tenant_id: str
    org_id: str
    assertion_id: str


class AssertionVerifier:
    def __init__(
        self,
        *,
        public_key_pem: str,
        issuer: str,
        audience: str,
        org_id: str,
        max_ttl_seconds: int = 60,
    ) -> None:
        self._key = ECKey.import_key(public_key_pem)
        self._issuer = issuer
        self._audience = audience
        self._org_id = org_id
        self._max_ttl = max_ttl_seconds
        self._seen: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def verify(self, token: str, *, now: int | None = None) -> ServicePrincipal:
        timestamp = int(time.time()) if now is None else now
        try:
            decoded = jwt.decode(token, self._key, algorithms=[ALGORITHM])
            claims: dict[str, Any] = dict(decoded.claims)
        except (JoseError, TypeError, ValueError) as exc:
            raise InvalidAssertion() from exc

        audience = claims.get("aud")
        audience_matches = audience == self._audience or (
            isinstance(audience, list) and self._audience in audience
        )
        subject = claims.get("sub")
        org_id = claims.get("org")
        assertion_id = claims.get("jti")
        issued_at = claims.get("iat")
        expires_at = claims.get("exp")
        if (
            claims.get("iss") != self._issuer
            or not audience_matches
            or org_id != self._org_id
            or not isinstance(subject, str)
            or not subject
            or not isinstance(assertion_id, str)
            or not assertion_id
            or not isinstance(issued_at, int)
            or not isinstance(expires_at, int)
        ):
            raise InvalidAssertion("Malformed connector service assertion.")
        if issued_at > timestamp + 5 or expires_at <= timestamp:
            raise InvalidAssertion("Expired connector service assertion.")
        if expires_at - issued_at <= 0 or expires_at - issued_at > self._max_ttl:
            raise InvalidAssertion("Connector service assertion TTL is invalid.")
        if expires_at > timestamp + self._max_ttl + 5:
            raise InvalidAssertion("Connector service assertion expiry is invalid.")

        async with self._lock:
            self._seen = {jti: exp for jti, exp in self._seen.items() if exp > timestamp}
            if assertion_id in self._seen:
                raise InvalidAssertion("Connector service assertion was replayed.")
            self._seen[assertion_id] = expires_at
        return ServicePrincipal(subject, str(org_id), assertion_id)
