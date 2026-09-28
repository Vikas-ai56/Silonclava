from __future__ import annotations

import pytest

from rocky_connector.identity import AssertionVerifier, InvalidAssertion


def verifier(public_key: str) -> AssertionVerifier:
    return AssertionVerifier(
        public_key_pem=public_key,
        issuer="rocky",
        audience="connector",
        org_id="org-a",
        max_ttl_seconds=60,
    )


@pytest.mark.asyncio
async def test_assertion_binds_tenant_and_rejects_replay(signing_material, assertion):
    _, public_key = signing_material
    check = verifier(public_key)
    token = assertion("tenant-a", now=1_000, jti="once")
    principal = await check.verify(token, now=1_001)
    assert principal.tenant_id == "tenant-a"
    assert principal.org_id == "org-a"
    with pytest.raises(InvalidAssertion, match="replayed"):
        await check.verify(token, now=1_001)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kwargs", "at"),
    [
        ({"audience": "other", "now": 1_000}, 1_001),
        ({"issuer": "other", "now": 1_000}, 1_001),
        ({"org": "other", "now": 1_000}, 1_001),
        ({"now": 1_000, "ttl": 61}, 1_001),
        ({"now": 1_000, "ttl": 1}, 1_002),
    ],
)
async def test_assertion_rejects_wrong_scope_or_lifetime(signing_material, assertion, kwargs, at):
    _, public_key = signing_material
    with pytest.raises(InvalidAssertion):
        await verifier(public_key).verify(assertion(**kwargs), now=at)
