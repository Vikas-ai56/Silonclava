from __future__ import annotations

from types import SimpleNamespace

import pytest

from rocky_connector.composio_gateway import ComposioGateway
from rocky_connector.config import ToolkitRegistry
from rocky_connector.domain import AlreadyConnected, ConnectionState, TooManyAccounts


class Accounts:
    def __init__(self):
        self.items = []
        self.linked = []

    def list(self, *, user_ids):
        assert user_ids[0].startswith("acct:")
        return SimpleNamespace(items=list(self.items))

    def link(self, **kwargs):
        self.linked.append(kwargs)
        return SimpleNamespace(id="connection-1", redirect_url="https://connect.example/once")

    def delete(self, connection_id):
        self.items = [item for item in self.items if item.id != connection_id]


class FakeSdk:
    def __init__(self):
        self.connected_accounts = Accounts()
        self.auth_configs = SimpleNamespace(
            list=lambda: SimpleNamespace(
                items=[
                    SimpleNamespace(
                        id="auth-1",
                        toolkit=SimpleNamespace(slug="gmail"),
                        auth_scheme="OAUTH2",
                    )
                ]
            )
        )
        self.toolkits = SimpleNamespace(
            get=lambda slug: SimpleNamespace(
                slug=slug,
                name=slug.title(),
                meta=SimpleNamespace(description=f"{slug} tools", logo=None),
            )
        )
        self.tools = SimpleNamespace(
            get_raw_composio_tools=lambda **_: [
                {"slug": "GMAIL_FETCH_EMAILS", "name": "Fetch", "description": "Fetch email"},
                {"slug": "GMAIL_SEND_EMAIL", "name": "Send", "description": "Send email"},
            ]
        )
        self.sessions = SimpleNamespace(
            create=lambda **kwargs: SimpleNamespace(
                kwargs=kwargs,
                mcp=SimpleNamespace(
                    url="https://mcp.composio.dev/session/opaque",
                    headers={"Authorization": "Bearer opaque"},
                ),
            )
        )


def gateway(client: FakeSdk) -> ComposioGateway:
    return ComposioGateway(
        api_key="project-secret",
        registry=ToolkitRegistry(("gmail", "asana")),
        callback_url="https://gateway.example/callback",
        client=client,
    )


@pytest.mark.asyncio
async def test_connect_uses_stable_tenant_scope_and_returns_connection_id():
    client = FakeSdk()
    result = await gateway(client).connect("tenant-a", "gmail")
    assert result.connection_id == "connection-1"
    assert client.connected_accounts.linked == [
        {
            "user_id": "acct:tenant-a",
            "auth_config_id": "auth-1",
            "callback_url": "https://gateway.example/callback",
            "allow_multiple": True,
        }
    ]


def _account(account_id, slug, status):
    return SimpleNamespace(
        id=account_id,
        toolkit=SimpleNamespace(slug=slug),
        status=status,
        is_disabled=False,
    )


@pytest.mark.asyncio
async def test_connect_rejects_a_second_link_while_one_is_pending():
    client = FakeSdk()
    client.connected_accounts.items = [_account("half-done", "gmail", ConnectionState.initiated)]
    with pytest.raises(AlreadyConnected):
        await gateway(client).connect("tenant-a", "gmail")


@pytest.mark.asyncio
async def test_connect_allows_a_second_account_when_one_is_already_active():
    client = FakeSdk()
    client.connected_accounts.items = [_account("work", "gmail", ConnectionState.active)]
    result = await gateway(client).connect("tenant-a", "gmail")
    assert result.connection_id == "connection-1"
    assert client.connected_accounts.linked[0]["allow_multiple"] is True


@pytest.mark.asyncio
async def test_connect_refuses_past_the_account_limit():
    client = FakeSdk()
    client.connected_accounts.items = [
        _account(f"acct-{i}", "gmail", ConnectionState.active) for i in range(5)
    ]
    with pytest.raises(TooManyAccounts):
        await gateway(client).connect("tenant-a", "gmail")


@pytest.mark.asyncio
async def test_resolve_returns_one_combined_native_mcp_server():
    client = FakeSdk()
    client.connected_accounts.items = [
        SimpleNamespace(
            id="g-1",
            toolkit=SimpleNamespace(slug="gmail"),
            status="ACTIVE",
            is_disabled=False,
        ),
        SimpleNamespace(
            id="a-1",
            toolkit=SimpleNamespace(slug="asana"),
            status="ACTIVE",
            is_disabled=False,
        ),
    ]
    endpoint = await gateway(client).resolve_mcp("tenant-a", ["gmail", "asana"])
    assert endpoint is not None
    assert endpoint.name == "composio"
    assert endpoint.url == "https://mcp.composio.dev/session/opaque"
    assert endpoint.headers == {"Authorization": "Bearer opaque"}


@pytest.mark.asyncio
async def test_tools_are_not_filtered_or_reimplemented():
    tools = await gateway(FakeSdk()).list_tools("gmail")
    assert [tool.slug for tool in tools] == ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]


def _gmail(account_id, *, display_name=None, word_id=None, alias=None):
    return SimpleNamespace(
        id=account_id,
        toolkit=SimpleNamespace(slug="gmail"),
        status=ConnectionState.active,
        is_disabled=False,
        alias=alias,
        word_id=word_id,
        data={"displayName": display_name} if display_name else {},
    )


@pytest.mark.asyncio
async def test_each_account_is_identifiable():
    client = FakeSdk()
    client.connected_accounts.items = [
        _gmail("ca_work", display_name="a@work.example", word_id="gmail_roomy-stole"),
        _gmail("ca_school", display_name="b@school.example", word_id="gmail_jef-jobman",
               alias="school"),
    ]
    found = await gateway(client).list_connections("tenant-a")
    by_id = {item.connection_id: item for item in found}

    assert by_id["ca_work"].display_name == "a@work.example"
    assert by_id["ca_work"].account == "gmail_roomy-stole"
    assert by_id["ca_school"].display_name == "b@school.example"
    assert by_id["ca_school"].account == "school", "an alias the user set wins over the handle"


@pytest.mark.asyncio
async def test_disconnect_removes_only_the_named_account():
    client = FakeSdk()
    client.connected_accounts.items = [_gmail("ca_work"), _gmail("ca_school")]
    await gateway(client).disconnect("tenant-a", "gmail", "ca_school")
    assert [item.id for item in client.connected_accounts.items] == ["ca_work"]


@pytest.mark.asyncio
async def test_disconnect_without_an_account_still_clears_the_toolkit():
    client = FakeSdk()
    client.connected_accounts.items = [_gmail("ca_work"), _gmail("ca_school")]
    await gateway(client).disconnect("tenant-a", "gmail")
    assert client.connected_accounts.items == []


@pytest.mark.asyncio
async def test_disconnect_refuses_an_account_that_is_not_there():
    from rocky_connector.domain import ConnectionNotFound

    client = FakeSdk()
    client.connected_accounts.items = [_gmail("ca_work")]
    with pytest.raises(ConnectionNotFound):
        await gateway(client).disconnect("tenant-a", "gmail", "ca_nope")
    assert [item.id for item in client.connected_accounts.items] == ["ca_work"], \
        "a miss must not delete the accounts that are there"


@pytest.mark.asyncio
async def test_mcp_session_demands_an_explicit_account():
    client = FakeSdk()
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            mcp=SimpleNamespace(url="https://mcp.composio.dev/s", headers={})
        )

    client.sessions = SimpleNamespace(create=create)
    client.connected_accounts.items = [_gmail("ca_work"), _gmail("ca_school")]

    endpoint = await gateway(client).resolve_mcp("tenant-a", ["gmail"])
    assert endpoint is not None
    multi = captured["multi_account"]
    assert multi["enable"] is True
    assert multi["require_explicit_selection"] is True, \
        "without this the router silently picks a mailbox for the user"
