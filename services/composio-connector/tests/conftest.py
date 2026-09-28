from __future__ import annotations

import time
import uuid

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from joserfc import jwt
from joserfc.jwk import ECKey


@pytest.fixture(scope="session")
def signing_material() -> tuple[str, str]:
    private = ec.generate_private_key(ec.SECP256R1())
    private_pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        private.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


@pytest.fixture
def assertion(signing_material):
    private_pem, _ = signing_material

    def issue(
        tenant_id: str = "tenant-a",
        *,
        issuer: str = "rocky",
        audience: str = "connector",
        org: str = "org-a",
        now: int | None = None,
        ttl: int = 45,
        jti: str | None = None,
    ) -> str:
        timestamp = int(time.time()) if now is None else now
        return jwt.encode(
            {"alg": "ES256"},
            {
                "iss": issuer,
                "aud": audience,
                "sub": tenant_id,
                "org": org,
                "iat": timestamp,
                "exp": timestamp + ttl,
                "jti": jti or str(uuid.uuid4()),
            },
            ECKey.import_key(private_pem),
        )

    return issue
